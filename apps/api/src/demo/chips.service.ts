import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";
import { CONFIG, type Config } from "../config";
import { REDIS } from "../redis/redis.module";

/** What a round's credit marker records. `payout` is null for markers written before payouts were kept ('1'). */
export type CreditReceipt = { payout: number | null } & Record<string, unknown>;

function parseReceipt(raw: string): CreditReceipt {
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      value &&
      typeof value === "object" &&
      Number.isSafeInteger((value as { payout?: unknown }).payout)
    )
      return value as CreditReceipt;
  } catch {
    // Fall through: an unreadable marker still means the round was credited.
  }
  return { payout: null };
}

/**
 * Virtual chips per demo session. Integers only, no real value, no withdrawal, no purchase.
 * Debit and credit are atomic Lua so concurrent bets cannot overdraw.
 */
@Injectable()
export class ChipsService {
  private static readonly DEBIT = `
    local bal = redis.call('GET', KEYS[1])
    if not bal then bal = ARGV[2]; redis.call('SET', KEYS[1], bal, 'EX', ARGV[3]) end
    bal = tonumber(bal)
    local amt = tonumber(ARGV[1])
    if bal < amt then return -1 end
    redis.call('DECRBY', KEYS[1], amt)
    redis.call('EXPIRE', KEYS[1], ARGV[3])
    return bal - amt
  `;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  private key(sid: string) {
    return `demo:chips:${sid}`;
  }

  async balance(sid: string): Promise<number> {
    const v = await this.redis.get(this.key(sid));
    if (v === null) {
      await this.redis.set(
        this.key(sid),
        this.config.DEMO_START_CHIPS,
        "EX",
        this.config.DEMO_SESSION_TTL,
        "NX",
      );
      return Number(await this.redis.get(this.key(sid)));
    }
    return Number(v);
  }

  private marker(sid: string, round: string) {
    return `demo:credited:${sid}:${round}`;
  }

  /**
   * Idempotent completed-round credit, including retry after a lost Redis response. The round's
   * marker keeps the payout (plus the caller's `detail`), so a retry reports what was credited
   * rather than a recomputed amount.
   */
  async creditOnce(
    sid: string,
    amount: number,
    round: string,
    detail: Record<string, unknown> = {},
  ): Promise<{ balance: number; credited: boolean; receipt: CreditReceipt }> {
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new RangeError("invalid chip credit");
    const [balance, stored, credited] = (await this.redis.eval(
      `
      local bal = redis.call('GET', KEYS[1])
      if not bal then bal = ARGV[2]; redis.call('SET', KEYS[1], bal, 'EX', ARGV[3]) end
      local prior = redis.call('GET', KEYS[2])
      if prior then return {tonumber(bal), prior, 0} end
      local next = redis.call('INCRBY', KEYS[1], ARGV[1])
      redis.call('EXPIRE', KEYS[1], ARGV[3])
      redis.call('SET', KEYS[2], ARGV[4], 'EX', ARGV[3])
      return {next, ARGV[4], 1}
    `,
      2,
      this.key(sid),
      this.marker(sid, round),
      amount,
      this.config.DEMO_START_CHIPS,
      this.config.DEMO_SESSION_TTL,
      JSON.stringify({ ...detail, payout: amount }),
    )) as [number, string, number];
    return {
      balance: Number(balance),
      credited: Number(credited) === 1,
      receipt: parseReceipt(stored),
    };
  }

  /** The stored settlement if this round has already been credited, otherwise null. */
  async creditReceipt(
    sid: string,
    round: string,
  ): Promise<CreditReceipt | null> {
    const raw = await this.redis.get(this.marker(sid, round));
    return raw === null ? null : parseReceipt(raw);
  }

  /** Take `amount` chips or throw 402 if the session cannot cover it. Returns the new balance. */
  async debit(sid: string, amount: number): Promise<number> {
    const res = (await this.redis.eval(
      ChipsService.DEBIT,
      1,
      this.key(sid),
      amount,
      this.config.DEMO_START_CHIPS,
      this.config.DEMO_SESSION_TTL,
    )) as number;
    if (res < 0)
      throw new HttpException("not enough chips", HttpStatus.PAYMENT_REQUIRED);
    return res;
  }

  async credit(sid: string, amount: number): Promise<number> {
    if (amount <= 0) return this.balance(sid);
    const v = await this.redis
      .multi()
      .incrby(this.key(sid), Math.floor(amount))
      .expire(this.key(sid), this.config.DEMO_SESSION_TTL)
      .exec();
    return Number(v?.[0]?.[1] ?? 0);
  }

  /** The free refill: back to the starting stack. Rate limited by the controller. */
  async refill(sid: string): Promise<number> {
    await this.redis.set(
      this.key(sid),
      this.config.DEMO_START_CHIPS,
      "EX",
      this.config.DEMO_SESSION_TTL,
    );
    return this.config.DEMO_START_CHIPS;
  }
}
