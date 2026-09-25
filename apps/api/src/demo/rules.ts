/**
 * Payout math for the free demo games. Fairness (the outcome) comes from @galabet/fair; this file
 * only decides how many virtual chips an outcome pays. Shared with the site's explanatory tools.
 * Returns describe the tables before integer chip rounding; Roulette uses 36/37.
 */

export const HOUSE_EDGE = 0.01;
export const DEMO_RULE_VERSION = "galabet-demo/2026-09-20.1";
const RTP = 1 - HOUSE_EDGE;

// ---------- dice ----------
export interface DiceBet {
  target: number; // 2.00 .. 98.00, two decimals
  over: boolean;
}
export function diceChance(b: DiceBet): number {
  if (!Number.isFinite(b.target) || b.target < 0 || b.target > 100)
    throw new RangeError("target must be between 0 and 100");
  const size = 2 ** 32;
  let low = 0,
    high = size;
  // Count the actual GFS 32-bit fractions, respecting strict equality boundaries.
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const roll = Math.floor((mid / size) * 10001) / 100;
    if (b.over ? roll > b.target : roll >= b.target) high = mid;
    else low = mid + 1;
  }
  return b.over ? (size - low) / size : low / size;
}
export function diceMultiplier(b: DiceBet): number {
  return Math.floor((RTP / diceChance(b)) * 10000) / 10000;
}
export function diceWin(roll: number, b: DiceBet): boolean {
  return b.over ? roll > b.target : roll < b.target;
}

// ---------- limbo ----------
export function limboWin(result: number, target: number): boolean {
  return result >= target;
}

// ---------- roulette ----------
export const RED = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);
export type RouletteBet =
  | { type: "straight"; number: number }
  | { type: "color"; color: "red" | "black" }
  | { type: "parity"; parity: "odd" | "even" }
  | { type: "range"; range: "low" | "high" }
  | { type: "dozen"; dozen: 1 | 2 | 3 }
  | { type: "column"; column: 1 | 2 | 3 };

/** Total return multiplier on a win (stake included). Classic European table pays 35:1 straight, giving RTP 97.3%. */
export function rouletteMultiplier(b: RouletteBet): number {
  switch (b.type) {
    case "straight":
      return 36;
    case "dozen":
    case "column":
      return 3;
    default:
      return 2;
  }
}
export function rouletteWin(pocket: number, b: RouletteBet): boolean {
  if (pocket === 0) return b.type === "straight" && b.number === 0;
  switch (b.type) {
    case "straight":
      return pocket === b.number;
    case "color":
      return (b.color === "red") === RED.has(pocket);
    case "parity":
      return (b.parity === "even") === (pocket % 2 === 0);
    case "range":
      return (b.range === "low") === pocket <= 18;
    case "dozen":
      return Math.ceil(pocket / 12) === b.dozen;
    case "column":
      return ((pocket - 1) % 3) + 1 === b.column;
  }
}

// ---------- wheel ----------
/** 10 segments, RTP 99%: sum of multipliers is 9.90. */
export const WHEEL_SEGMENTS = [
  0, 1.5, 1.2, 1.5, 0, 2, 1.2, 1.5, 0, 1.0,
] as const;
export function wheelMultiplier(segment: number): number {
  return WHEEL_SEGMENTS[segment] ?? 0;
}

// ---------- plinko ----------
export function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}
const plinkoCache = new Map<number, number[]>();
/**
 * Bucket multipliers for `rows`, shaped so the edges pay big and the middle pays under 1x,
 * then scaled to exactly 99% return before rounding to 2 decimals.
 */
export function plinkoTable(rows: number): number[] {
  if (![8, 12, 16].includes(rows))
    throw new RangeError("supported rows are 8, 12 and 16");
  const cached = plinkoCache.get(rows);
  if (cached) return cached;
  const probs = Array.from(
    { length: rows + 1 },
    (_, k) => binom(rows, k) / 2 ** rows,
  );
  const shape = probs.map((p) => Math.pow(1 / p, 0.62));
  const ev = shape.reduce((a, w, k) => a + w * probs[k]!, 0);
  const table = shape.map((w) => Math.round(((w * RTP) / ev) * 100) / 100);
  plinkoCache.set(rows, table);
  return table;
}
export function plinkoRtp(rows: number): number {
  const probs = Array.from(
    { length: rows + 1 },
    (_, k) => binom(rows, k) / 2 ** rows,
  );
  return plinkoTable(rows).reduce((a, m, k) => a + m * probs[k]!, 0);
}

// ---------- mines ----------
/** Multiplier after `picks` safe tiles with `mines` mines on 25 tiles. Product of the survival odds, times RTP. */
export function minesMultiplier(mines: number, picks: number): number {
  if (picks === 0) return 1;
  let p = 1;
  for (let i = 0; i < picks; i++) p *= (25 - mines - i) / (25 - i);
  return Math.floor((RTP / p) * 10000) / 10000;
}

// ---------- keno ----------
/** Hits -> multiplier, indexed by number of picks (1..10). Draws 10 of 40. Total return multipliers. */
export const KENO_TABLE: Record<number, number[]> = {
  1: [0, 3.96],
  2: [0, 1.9, 4.5],
  3: [0, 1, 3.1, 10.4],
  4: [0, 0.8, 1.8, 5, 22.5],
  5: [0, 0.25, 1.4, 4.1, 16.5, 36],
  6: [0, 0, 1, 3.68, 7, 16.5, 40],
  7: [0, 0, 0.47, 3, 4.5, 14, 31, 60],
  8: [0, 0, 0, 2.2, 4, 13, 22, 55, 70],
  9: [0, 0, 0, 1.55, 3, 8, 15, 44, 60, 85],
  10: [0, 0, 0, 1.4, 2.25, 4.5, 8, 17, 50, 80, 100],
};
function hyper(picks: number, hits: number): number {
  // P(hits) drawing 10 of 40 with `picks` chosen: C(picks,hits) C(40-picks,10-hits) / C(40,10)
  return (binom(picks, hits) * binom(40 - picks, 10 - hits)) / binom(40, 10);
}
export function kenoRtp(picks: number): number {
  const row = KENO_TABLE[picks] ?? [];
  return row.reduce((a, m, hits) => a + m * hyper(picks, hits), 0);
}
export function kenoMultiplier(picks: number, hits: number): number {
  return KENO_TABLE[picks]?.[hits] ?? 0;
}

export function plinkoDistribution(rows: number) {
  return plinkoTable(rows).map((multiplier, bucket) => ({
    bucket,
    probability: binom(rows, bucket) / 2 ** rows,
    multiplier,
  }));
}
export function kenoDistribution(picks: number) {
  if (!Number.isInteger(picks) || picks < 1 || picks > 10)
    throw new RangeError("choose 1 to 10 numbers");
  return Array.from({ length: picks + 1 }, (_, hits) => ({
    hits,
    probability: hyper(picks, hits),
    multiplier: kenoMultiplier(picks, hits),
  }));
}
export function minesNextChance(mines: number, safePicks: number) {
  if (
    !Number.isInteger(mines) ||
    mines < 1 ||
    mines > 24 ||
    !Number.isInteger(safePicks) ||
    safePicks < 0 ||
    safePicks > 25 - mines
  )
    throw new RangeError("invalid board state");
  return safePicks === 25 - mines
    ? null
    : (25 - mines - safePicks) / (25 - safePicks);
}
export function rouletteCoverage(bet: RouletteBet) {
  return Array.from({ length: 37 }, (_, n) => n).filter((n) =>
    rouletteWin(n, bet),
  );
}
export function wheelGroups() {
  return [...new Set(WHEEL_SEGMENTS)]
    .sort((a, b) => a - b)
    .map((value) => ({
      value,
      indices: WHEEL_SEGMENTS.flatMap((v, i) => (v === value ? [i] : [])),
    }));
}
/** Every demo multiplier sits on a 0.0001 grid: Dice and Mines keep four decimals, the tables two or fewer. */
const MULTIPLIER_UNITS = 10_000;
/**
 * Whole chips returned for `stake` at `multiplier`, rounded down, in integer arithmetic.
 * Math.floor(100 * 2.01) is 200 because 2.01 is stored as 2.00999...; this returns 201.
 */
export function chipPayout(stake: number, multiplier: number): number {
  if (
    !Number.isSafeInteger(stake) ||
    stake < 0 ||
    !Number.isFinite(multiplier) ||
    multiplier < 0
  )
    throw new RangeError("invalid settlement inputs");
  const scaled = multiplier * MULTIPLIER_UNITS,
    units = Math.round(scaled);
  if (Math.abs(scaled - units) > 8 * Number.EPSILON * Math.max(1, scaled))
    throw new RangeError("multiplier must have at most four decimals");
  const total = stake * units;
  if (!Number.isSafeInteger(total))
    throw new RangeError("return exceeds safe integer range");
  return (total - (total % MULTIPLIER_UNITS)) / MULTIPLIER_UNITS;
}
export function chipReceipt(stake: number, multiplier: number, won: boolean) {
  if (
    !Number.isSafeInteger(stake) ||
    stake < 1 ||
    !Number.isFinite(multiplier) ||
    multiplier < 0
  )
    throw new RangeError("invalid settlement inputs");
  const returned = won ? chipPayout(stake, multiplier) : 0;
  return {
    stake,
    multiplier,
    returned,
    net: returned - stake,
    ruleVersion: DEMO_RULE_VERSION,
  };
}
export function publicRuleCatalog() {
  return {
    version: DEMO_RULE_VERSION,
    credits: "virtual; no monetary value",
    dice: {
      comparison: "strict over or under; equality loses",
      fractionBits: 32,
      houseEdge: HOUSE_EDGE,
    },
    limbo: { houseEdge: HOUSE_EDGE, comparison: "result >= target" },
    plinko: [8, 12, 16].map((rows) => ({
      rows,
      buckets: plinkoDistribution(rows),
      tableReturn: plinkoRtp(rows),
    })),
    mines: { tiles: 25, minMines: 1, maxMines: 24, houseEdge: HOUSE_EDGE },
    roulette: {
      pockets: 37,
      selections: ["straight", "color", "parity", "range", "dozen", "column"],
      tableReturn: 36 / 37,
    },
    keno: Array.from({ length: 10 }, (_, i) => ({
      picks: i + 1,
      hits: kenoDistribution(i + 1),
      tableReturn: kenoRtp(i + 1),
    })),
    wheel: {
      values: WHEEL_SEGMENTS,
      tableReturn:
        WHEEL_SEGMENTS.reduce<number>((sum, v) => sum + v, 0) /
        WHEEL_SEGMENTS.length,
    },
    blackjack: {
      mode: "public analysis",
      decks: 1,
      dealer: "stands on all 17s in practice",
      actions: ["hit", "stand"],
      settlement: false,
    },
    hilo: {
      mode: "public rank comparison",
      ace: "high",
      equalRank: "tie",
      settlement: false,
    },
    crash: {
      profile: "hash chain",
      manualCashout: "accepted only during running phase",
      settlement: "server authoritative",
    },
  };
}
