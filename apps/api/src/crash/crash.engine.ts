import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import type Redis from "ioredis";
import { REDIS } from "../redis/redis.module";
import { CrashIntegrityError, CrashService } from "./crash.service";
import {
  CrashBets,
  type RefundSummary,
  type RoundClock,
  type SettleSummary,
} from "./crash.bets";

export const CRASH_CHANNEL = "crash:events";
export type CrashEvent =
  | { type: "waiting"; chainId: string; index: number; startsAt: number }
  | {
      type: "tick";
      chainId: string;
      index: number;
      multiplier: number;
      elapsed: number;
    }
  | {
      type: "crash";
      chainId: string;
      index: number;
      gameHash: string;
      result: number;
      salt: string;
      settled: SettleSummary;
    }
  | {
      type: "void";
      chainId: string;
      index: number;
      gameHash: string;
      result: number;
      salt: string;
      refunded: RefundSummary;
    }
  | { type: "paused"; reason: string };

const WAIT_MS = 6_000;
const TICK_MS = 100;

/** One worker owns the loop. Redis keeps the private round and its authoritative clock. */
@Injectable()
export class CrashEngine implements OnModuleDestroy {
  private readonly log = new Logger(CrashEngine.name);
  private running = false;
  private stopped = false;
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly crash: CrashService,
    private readonly bets: CrashBets,
  ) {}
  private publish(ev: CrashEvent) {
    return this.redis.publish(CRASH_CHANNEL, JSON.stringify(ev));
  }
  async start() {
    if (this.running) return;
    this.running = true;
    while (!this.stopped) {
      try {
        await this.round();
      } catch (e) {
        if (e instanceof CrashIntegrityError) {
          // Retrying cannot repair a chain that fails its link check; an operator must.
          this.stopped = true;
          this.log.error(e.message);
          await this.publish({
            type: "paused",
            reason: "engine stopped: Crash chain failed its integrity check",
          }).catch(() => {});
          break;
        }
        this.log.error(String(e));
        await this.publish({
          type: "paused",
          reason: "engine error, retrying",
        }).catch(() => {});
        await sleep(5_000);
      }
    }
  }
  private async round() {
    let game = await this.crash.pendingGame();
    if (!game) {
      const chain = await this.crash.currentChain();
      const salt = await this.crash.salt(chain.id);
      if (!salt) {
        await this.publish({
          type: "paused",
          reason: `waiting for block ${chain.saltRef} to be mined for the salt`,
        });
        await sleep(5_000);
        return;
      }
      game = await this.crash.nextGame(chain.id, salt);
    }
    // On a retry/restart this preserves the original deadlines and settled bets. If the engine was
    // away when the deadline passed, the first advance voids the round instead of crashing it.
    await this.bets.prepare(game.chainId, game.index, game.result, WAIT_MS);
    let announcedWaiting = false;
    let clock: RoundClock | undefined;
    while (!this.stopped) {
      clock = await this.bets.advance();
      if (clock.phase === "crashed" || clock.phase === "void") break;
      if (clock.phase === "waiting") {
        if (!announcedWaiting) {
          await this.publish({
            type: "waiting",
            chainId: game.chainId,
            index: game.index,
            startsAt: clock.startsAt,
          });
          announcedWaiting = true;
        }
      } else {
        await this.publish({
          type: "tick",
          chainId: game.chainId,
          index: game.index,
          multiplier: clock.multiplier,
          elapsed: clock.elapsed,
        });
      }
      await sleep(TICK_MS);
    }
    if (this.stopped || !clock) return;
    const reveal = {
      chainId: game.chainId,
      index: game.index,
      gameHash: game.gameHash,
      result: game.result,
      salt: game.salt,
    };
    if (clock.phase === "void") {
      const refunded = await this.bets.refund(game.chainId, game.index);
      await this.crash.completeGame(game, refunded);
      this.log.warn(
        `voided crash round ${game.chainId}:${game.index}, refunded ${refunded.refunded} of ${refunded.bets} bets`,
      );
      await this.publish({ type: "void", ...reveal, refunded });
    } else {
      const settled = await this.bets.settle(game.chainId, game.index);
      await this.crash.completeGame(game);
      await this.publish({ type: "crash", ...reveal, settled });
    }
    // Expire the round's bet keys before forgetting the round: if this throws, the pending round
    // survives and the retry repeats the (idempotent) close, so no key is left without expiry.
    await this.bets.retire(game.chainId, game.index);
    await this.crash.finishGame(game);
    await this.crash.releaseChain(game.chainId);
    await sleep(2_000);
  }
  onModuleDestroy() {
    this.stopped = true;
  }
}
function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
