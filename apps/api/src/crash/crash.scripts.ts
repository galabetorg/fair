// Phase checks and chip movements run on Redis's clock, atomically on one primary.
// This demo uses standalone Redis, not Redis Cluster.
const clock = `local t = redis.call('TIME'); local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)`;

// Integer-cent payout. A 2-dp multiplier becomes whole hundredths first (2.01 -> 201), so
// 100 x 2.01 pays 201, not floor(200.99999999999997) = 200. Exact while amount x cents < 2^53,
// which covers every automatic target (<= 10,000x) and manual multipliers below ~900,000,000x.
const payoutOf = `local function payoutOf(amount, multiplier)
  local cents = math.floor(multiplier * 100 + 0.5)
  return math.floor(amount * cents / 100)
end`;

// A missing balance starts from the demo stake, as ChipsService does for debits and credits.
const balanceOf = `local function balanceOf(key, initial)
  return tonumber(redis.call('GET', key) or initial)
end`;

// `seen` is the Redis time of the engine's latest look at the round; ADVANCE uses it as proof.
export const PREPARE = `
${clock}
if redis.call('HGET', KEYS[1], 'chainId') == ARGV[1] and redis.call('HGET', KEYS[1], 'index') == ARGV[2] then return 0 end
local starts = now + tonumber(ARGV[4])
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'chainId', ARGV[1], 'index', ARGV[2], 'phase', 'waiting',
  'result', ARGV[3], 'startsAt', starts, 'endsAt', starts + tonumber(ARGV[5]), 'multiplier', 1, 'seen', now)
return 1`;

// ARGV: proof gap in ms. 'crashed' and 'void' are final: a closed round is never decided twice.
// At the deadline the round crashes only if the engine can prove players watched it run: its
// last look was 'running' within the gap before the end, or it has looked without a pause since
// (a round shorter than the gap may pass from waiting to crashed between two looks). Anything
// else - an engine that was down, a waiting round nobody saw start, a state without `seen` - voids.
export const ADVANCE = `
${clock}
local starts = tonumber(redis.call('HGET', KEYS[1], 'startsAt'))
local ends = tonumber(redis.call('HGET', KEYS[1], 'endsAt'))
if not starts or not ends then return nil end
local stored = redis.call('HGET', KEYS[1], 'phase')
local phase = 'waiting'; local multiplier = 1
if stored == 'crashed' or stored == 'void' then
  phase = stored
  if stored == 'crashed' then multiplier = tonumber(redis.call('HGET', KEYS[1], 'result')) end
  return cjson.encode({phase=phase, multiplier=multiplier, startsAt=starts, elapsed=math.max(0, now-starts)})
end
if now >= ends then
  local seen = tonumber(redis.call('HGET', KEYS[1], 'seen'))
  local gap = tonumber(ARGV[1])
  if seen and ((stored == 'running' and seen >= ends - gap) or now - seen <= gap) then
    phase = 'crashed'; multiplier = tonumber(redis.call('HGET', KEYS[1], 'result'))
  else
    phase = 'void'
    redis.call('HSET', KEYS[1], 'voidedAt', now)
  end
elseif now >= starts then
  phase = 'running'; multiplier = math.floor(math.exp(0.06 * (now - starts) / 1000) * 100) / 100
end
redis.call('HSET', KEYS[1], 'phase', phase, 'multiplier', multiplier, 'seen', now)
return cjson.encode({phase=phase, multiplier=multiplier, startsAt=starts, elapsed=math.max(0, now-starts)})
`;

// KEYS: state, bet index, balance, seed session, bet.
// ARGV: chain, index, sid, amount, auto, initial, TTL, retention.
// The unsettled bet and its index expire after `retention` even if no engine ever returns.
export const PLACE = `
${clock}
${balanceOf}
if redis.call('HGET', KEYS[1], 'chainId') ~= ARGV[1] or redis.call('HGET', KEYS[1], 'index') ~= ARGV[2] then return 'round changed' end
local starts = tonumber(redis.call('HGET', KEYS[1], 'startsAt'))
if redis.call('HGET', KEYS[1], 'phase') ~= 'waiting' or not starts or now >= starts then return 'bets open only while the round is waiting' end
if redis.call('EXISTS', KEYS[4]) == 0 then return 'demo session not found or expired' end
if redis.call('EXISTS', KEYS[5]) == 1 then return 'one bet per round' end
local balance = balanceOf(KEYS[3], ARGV[6])
local amount = tonumber(ARGV[4])
if balance < amount then return 'not enough chips' end
local auto = tonumber(ARGV[5]); if auto == 0 then auto = cjson.null end
local bet = cjson.encode({sid=ARGV[3], amount=amount, autoCashout=auto, cashedAt=cjson.null, settled=false})
-- Index first. If storage fails, an orphan index entry carries no stake and can be skipped.
-- MSET commits debit and bet together, even if a later command fails.
redis.call('HSET', KEYS[2], ARGV[3], '1')
redis.call('EXPIRE', KEYS[2], ARGV[8])
redis.call('MSET', KEYS[5], bet, KEYS[3], balance-amount)
redis.call('EXPIRE', KEYS[3], ARGV[7])
redis.call('EXPIRE', KEYS[5], ARGV[8])
return bet`;

// The completed bet is also the credit marker: a settled bet is returned unchanged, so a retried
// settlement or refund cannot credit twice. KEYS: state, bet, balance.
// ARGV: chain, index, sid, mode (manual | settle | refund), TTL, initial.
export const PAY = `
${clock}
${payoutOf}
${balanceOf}
if redis.call('HGET', KEYS[1], 'chainId') ~= ARGV[1] or redis.call('HGET', KEYS[1], 'index') ~= ARGV[2] then return 'round changed' end
local raw = redis.call('GET', KEYS[2])
if not raw then return 'no bet in this round' end
local bet = cjson.decode(raw)
if bet.settled then
  if ARGV[4] == 'manual' then return 'already settled' end
  return raw
end
local phase = redis.call('HGET', KEYS[1], 'phase')
local payout = 0
if ARGV[4] == 'refund' then
  if phase ~= 'void' then return 'round was not voided' end
  payout = bet.amount; bet.cashedAt = cjson.null; bet.refunded = true
else
  local starts = tonumber(redis.call('HGET', KEYS[1], 'startsAt'))
  local ends = tonumber(redis.call('HGET', KEYS[1], 'endsAt'))
  local result = tonumber(redis.call('HGET', KEYS[1], 'result'))
  if not starts or not ends or not result then return 'round clock unavailable' end
  local at = nil
  if ARGV[4] == 'manual' then
    if phase ~= 'running' or now < starts or now >= ends then return 'no round running' end
    at = math.floor(math.exp(0.06 * (now-starts) / 1000) * 100) / 100
    if at >= result then return 'cash-out reached the crash point' end
  elseif phase ~= 'crashed' or now < ends then
    return 'round has not crashed'
  end
  if bet.autoCashout ~= cjson.null and bet.autoCashout < result then
    if ARGV[4] == 'settle' or at >= bet.autoCashout then at = bet.autoCashout end
  end
  if at then payout = payoutOf(bet.amount, at) end
  bet.cashedAt = at or cjson.null
end
local balance = balanceOf(KEYS[3], ARGV[6]) + payout
bet.payout = payout; bet.settled = true
local encoded = cjson.encode(bet)
redis.call('MSET', KEYS[2], encoded, KEYS[3], balance)
-- MSET clears expiries; a settled bet expires with the session even if retire never runs.
redis.call('EXPIRE', KEYS[3], ARGV[5])
redis.call('EXPIRE', KEYS[2], ARGV[5])
return encoded`;
