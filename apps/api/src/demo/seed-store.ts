import type Redis from "ioredis";
import type { FairRecord } from "@galabet/fair";
import { ConflictException } from "@nestjs/common";

/** What the demo keeps per browser session. Server seed never leaves this object until rotation. */
export interface DemoSession {
  id: string;
  serverSeed: string;
  commitment: string;
  clientSeed: string;
  /** Bets placed under the current server seed. Decides if rotation reveals anything. */
  betsUnderSeed: number;
  createdAt: number;
}

/**
 * Small store interface. Redis in production; the same shape will move to @galabet/fair-store
 * with memory, Postgres and KV adapters for operators.
 *
 * The nonce lives in its own key so it can be reserved atomically with INCR: two bets fired at
 * once never share a nonce, which a read-modify-write on the session JSON could not guarantee.
 */
export interface SeedStore {
  get(id: string, ttlSeconds?: number): Promise<DemoSession | null>;
  put(
    session: DemoSession,
    ttlSeconds: number,
    expectedCommitment?: string,
  ): Promise<void>;
  /** Reserve the next nonce. Returns the nonce this bet must use. */
  reserveNonce(
    id: string,
    ttlSeconds: number,
    expectedCommitment: string,
  ): Promise<number>;
  /** Current nonce without consuming one. */
  peekNonce(id: string): Promise<number>;
  /** Remember a revealed server seed under its commitment, for the verify page. Expires with the session. */
  reveal(
    id: string,
    commitment: string,
    serverSeed: string,
    ttlSeconds: number,
  ): Promise<void>;
  revealed(id: string): Promise<Record<string, string>>;
  pushRecord(
    id: string,
    record: FairRecord,
    keep: number,
    ttlSeconds: number,
  ): Promise<void>;
  records(id: string, limit: number): Promise<FairRecord[]>;
  /** Per-IP session creation counter, expires at end of window. */
  countSession(ip: string, windowSeconds: number): Promise<number>;
}

/**
 * Every script receives the session, nonce, revealed, records and linked keys, in that order, and
 * gives all of them the same expiry. A live session therefore never outlives its revealed seeds or
 * the records that reference them. EXPIRE on a key that does not exist yet is a no-op.
 */
const TOUCH = `
  local function touch(ttl)
    for i = 1, #KEYS do redis.call('EXPIRE', KEYS[i], ttl) end
  end
`;

export class RedisSeedStore implements SeedStore {
  /**
   * `linked` names other `demo:<part>:<id>` keys that must expire with the session, such as the
   * open Mines board, so an unfinished round cannot vanish while the session and its history live.
   */
  constructor(
    private readonly redis: Redis,
    private readonly linked: readonly string[] = [],
  ) {}
  private k(id: string, part: string) {
    return `demo:${part}:${id}`;
  }
  private keys(id: string) {
    const parts = ["session", "nonce", "revealed", "records", ...this.linked];
    return parts.map((part) => this.k(id, part));
  }
  private run(script: string, id: string, ...args: (string | number)[]) {
    const keys = this.keys(id);
    return this.redis.eval(TOUCH + script, keys.length, ...keys, ...args);
  }
  async get(id: string, ttl?: number) {
    const raw = (await this.run(
      `
      local session = redis.call('GET', KEYS[1])
      if not session then return nil end
      if redis.call('EXISTS', KEYS[2]) == 0 then return '' end
      if tonumber(ARGV[1]) > 0 then touch(ARGV[1]) end
      return session`,
      id,
      ttl ?? 0,
    )) as string | null;
    if (raw === "")
      throw new ConflictException(
        "session nonce missing; start a new demo session",
      );
    return raw ? (JSON.parse(raw) as DemoSession) : null;
  }
  async put(session: DemoSession, ttl: number, expectedCommitment?: string) {
    const saved = await this.run(
      `
      local old = redis.call('GET', KEYS[1])
      local next = cjson.decode(ARGV[1])
      local counter = redis.call('GET', KEYS[2])
      if old then
        local previous = cjson.decode(old)
        if previous.commitment ~= ARGV[3] then return 0 end
        if previous.commitment == next.commitment then
          if not counter then return 0 end
        else counter = '0' end
      else
        if ARGV[3] ~= '' then return 0 end
        counter = '0'
      end
      redis.call('MSET', KEYS[1], ARGV[1], KEYS[2], counter)
      touch(ARGV[2])
      return 1`,
      session.id,
      JSON.stringify(session),
      ttl,
      expectedCommitment ?? "",
    );
    if (saved !== 1)
      throw new ConflictException(
        "session changed, expired or nonce missing; start a new demo session",
      );
  }
  async reserveNonce(id: string, ttl: number, expectedCommitment: string) {
    const value = Number(
      await this.run(
        `
      if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[2]) == 0 then return -1 end
      if cjson.decode(redis.call('GET', KEYS[1])).commitment ~= ARGV[2] then return -1 end
      local n = tonumber(redis.call('GET', KEYS[2]))
      if not n or n < 0 or n >= 9007199254740991 then return -1 end
      redis.call('INCR', KEYS[2])
      touch(ARGV[1])
      return n`,
        id,
        ttl,
        expectedCommitment,
      ),
    );
    if (value < 0)
      throw new ConflictException(
        "session nonce unavailable; start a new demo session",
      );
    return value;
  }
  async peekNonce(id: string) {
    const value = await this.redis.get(this.k(id, "nonce"));
    if (value === null)
      throw new ConflictException(
        "session nonce missing; start a new demo session",
      );
    return Number(value);
  }
  async reveal(
    id: string,
    commitment: string,
    serverSeed: string,
    ttl: number,
  ) {
    await this.run(
      `redis.call('HSET', KEYS[3], ARGV[1], ARGV[2]); touch(ARGV[3])`,
      id,
      commitment,
      serverSeed,
      ttl,
    );
  }
  async revealed(id: string) {
    return this.redis.hgetall(this.k(id, "revealed"));
  }
  async pushRecord(id: string, record: FairRecord, keep: number, ttl: number) {
    await this.run(
      `
      redis.call('LPUSH', KEYS[4], ARGV[1])
      redis.call('LTRIM', KEYS[4], 0, tonumber(ARGV[2]) - 1)
      touch(ARGV[3])`,
      id,
      JSON.stringify(record),
      keep,
      ttl,
    );
  }
  async records(id: string, limit: number) {
    const raw = await this.redis.lrange(this.k(id, "records"), 0, limit - 1);
    return raw.map((r) => JSON.parse(r) as FairRecord);
  }
  async countSession(ip: string, window: number) {
    const key = `demo:ip:${ip}`;
    const res = await this.redis
      .multi()
      .incr(key)
      .expire(key, window, "NX")
      .exec();
    return Number(res?.[0]?.[1] ?? 1);
  }
}
