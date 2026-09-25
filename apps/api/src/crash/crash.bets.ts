import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";
import { REDIS } from "../redis/redis.module";
import { CONFIG, type Config } from "../config";
import { PREPARE, ADVANCE, PLACE, PAY } from "./crash.scripts";

/** Longest unseen stretch before a round's deadline that still counts as a round players watched. */
export const PROOF_GAP_MS = 1_000;
/** Backstop expiry for unsettled bets, so no stake record outlives an engine that never returns. */
const UNSETTLED_RETENTION_S = 7 * 24 * 60 * 60;

export interface CrashBet {
  sid: string;
  amount: number;
  autoCashout: number | null;
  cashedAt: number | null;
  settled?: boolean;
  payout?: number;
  /** Set when a voided round returned the stake; `payout` then equals `amount`. */
  refunded?: boolean;
}
export interface RoundClock {
  phase: "waiting" | "running" | "crashed" | "void";
  multiplier: number;
  startsAt: number;
  elapsed: number;
}
export interface SettleSummary {
  bets: number;
  paid: number;
  totalPayout: number;
}
export interface RefundSummary {
  bets: number;
  refunded: number;
  totalRefund: number;
}

@Injectable()
export class CrashBets {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CONFIG) private readonly config: Config,
  ) {}
  private key(chainId: string, index: number) {
    return `crash:bets:${chainId}:${index}`;
  }
  private betKey(chainId: string, index: number, sid: string) {
    return `crash:bet:${chainId}:${index}:${sid}`;
  }

  async prepare(
    chainId: string,
    index: number,
    result: number,
    waitMs: number,
  ) {
    await this.redis.eval(
      PREPARE,
      1,
      "crash:state",
      chainId,
      index,
      result,
      waitMs,
      (Math.log(result) / 0.06) * 1000,
    );
  }
  async advance(proofGapMs = PROOF_GAP_MS): Promise<RoundClock> {
    const raw = await this.redis.eval(ADVANCE, 1, "crash:state", proofGapMs);
    if (typeof raw !== "string") throw new Error("Crash round clock missing");
    return JSON.parse(raw);
  }
  private decode(raw: unknown): CrashBet {
    if (typeof raw !== "string" || !raw.startsWith("{"))
      throw new BadRequestException(String(raw));
    return JSON.parse(raw);
  }
  async place(sid: string, amount: number, autoCashout: number | null) {
    if (
      !Number.isSafeInteger(amount) ||
      amount < 1 ||
      amount > 100_000 ||
      (autoCashout !== null &&
        (!Number.isFinite(autoCashout) ||
          autoCashout < 1.01 ||
          autoCashout > 10_000))
    )
      throw new BadRequestException("invalid Crash stake or auto cash-out");
    const state = await this.redis.hgetall("crash:state");
    if (!state.chainId || !state.index)
      throw new BadRequestException("no round waiting");
    const bet = this.decode(
      await this.redis.eval(
        PLACE,
        5,
        "crash:state",
        this.key(state.chainId, Number(state.index)),
        `demo:chips:${sid}`,
        `demo:session:${sid}`,
        this.betKey(state.chainId, Number(state.index), sid),
        state.chainId,
        state.index,
        sid,
        amount,
        autoCashout ?? 0,
        this.config.DEMO_START_CHIPS,
        this.config.DEMO_SESSION_TTL,
        Math.max(this.config.DEMO_SESSION_TTL, UNSETTLED_RETENTION_S),
      ),
    );
    return { chainId: state.chainId, index: Number(state.index), bet };
  }
  async cashout(sid: string) {
    const state = await this.redis.hgetall("crash:state");
    if (!state.chainId || !state.index)
      throw new BadRequestException("no round running");
    const bet = await this.pay(
      state.chainId,
      Number(state.index),
      sid,
      "manual",
    );
    return {
      multiplier: bet.cashedAt,
      payout: bet.payout,
      chips: Number(await this.redis.get(`demo:chips:${sid}`)),
    };
  }
  private async pay(
    chainId: string,
    index: number,
    sid: string,
    mode: "manual" | "settle" | "refund",
  ) {
    return this.decode(
      await this.redis.eval(
        PAY,
        3,
        "crash:state",
        this.betKey(chainId, index, sid),
        `demo:chips:${sid}`,
        chainId,
        index,
        sid,
        mode,
        this.config.DEMO_SESSION_TTL,
        this.config.DEMO_START_CHIPS,
      ),
    );
  }
  /** Bets in the round's index that still have a stake record; orphan index entries are skipped. */
  private async *placed(chainId: string, index: number) {
    for (const sid of await this.redis.hkeys(this.key(chainId, index))) {
      if (await this.redis.exists(this.betKey(chainId, index, sid))) yield sid;
    }
  }
  async settle(chainId: string, index: number): Promise<SettleSummary> {
    const summary = { bets: 0, paid: 0, totalPayout: 0 };
    for await (const sid of this.placed(chainId, index)) {
      const bet = await this.pay(chainId, index, sid, "settle");
      summary.bets++;
      if (bet.payout) {
        summary.paid++;
        summary.totalPayout += bet.payout;
      }
    }
    return summary;
  }
  /**
   * Return every unsettled stake of a voided round. Bets already paid (manual cash-outs, including
   * ones capped at a reached automatic target) keep their payout. Safe to repeat: each refund is
   * written with the bet's settled marker, so a retry reports the same refund without crediting it again.
   */
  async refund(chainId: string, index: number): Promise<RefundSummary> {
    const summary = { bets: 0, refunded: 0, totalRefund: 0 };
    for await (const sid of this.placed(chainId, index)) {
      const bet = await this.pay(chainId, index, sid, "refund");
      summary.bets++;
      if (bet.refunded) {
        summary.refunded++;
        summary.totalRefund += bet.payout ?? 0;
      }
    }
    return summary;
  }
  async retire(chainId: string, index: number) {
    const sids = await this.redis.hkeys(this.key(chainId, index));
    for (const sid of sids)
      await this.redis.expire(
        this.betKey(chainId, index, sid),
        this.config.DEMO_SESSION_TTL,
      );
    await this.redis.expire(
      this.key(chainId, index),
      this.config.DEMO_SESSION_TTL,
    );
  }
  async myBet(sid: string) {
    const state = await this.redis.hgetall("crash:state");
    if (!state.chainId) return null;
    const raw = await this.redis.get(
      this.betKey(state.chainId, Number(state.index), sid),
    );
    return raw ? (JSON.parse(raw) as CrashBet) : null;
  }
}
