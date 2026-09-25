import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, not } from "drizzle-orm";
import type Redis from "ioredis";
import {
  createCrashChain,
  crashGameHash,
  crashResult,
  expandCrashChain,
  verifyCrashLink,
} from "@galabet/fair";
import { DB, type Db } from "../db/db.module";
import { REDIS } from "../redis/redis.module";
import { auditLog, crashChains, crashGames } from "../db/schema";
import { BeaconService } from "../beacon/beacon.service";
import type { RefundSummary } from "./crash.bets";

const CHAIN_LENGTH = 10_000;
const SALT_BLOCK_OFFSET = 20; // announce block N+20 at chain creation; salt = its hash once mined
const HOUSE_EDGE = 0.01;
const VOID_ACTION = "crash.void";

export interface PendingCrash {
  chainId: string;
  index: number;
  gameHash: string;
  result: number;
  salt: string;
}

/** The chain's stored hashes cannot be trusted. The engine stops instead of retrying. */
export class CrashIntegrityError extends Error {
  override name = "CrashIntegrityError";
}

const keys = (id: string) => ({
  secret: `crash:secret:${id}`,
  chain: `crash:chain:${id}`,
  played: `crash:played:${id}`,
});
const voidSubject = (chainId: string, index: number) => `${chainId}:${index}`;

/**
 * Chain management for the multiplayer crash demo. The secret lives in Redis only, and only while
 * the chain has unplayed games; Postgres holds the public parts. Each game reveals its hash and the
 * site can verify the chain link and the result.
 */
@Injectable()
export class CrashService {
  private readonly log = new Logger(CrashService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly beacon: BeaconService,
  ) {}

  /** The chain currently in play, creating one if none exists. */
  async currentChain() {
    const [latest] = await this.db
      .select()
      .from(crashChains)
      .orderBy(desc(crashChains.createdAt))
      .limit(1);
    if (latest) {
      const played = await this.redis.get(keys(latest.id).played);
      if (played === null) {
        if (!(await this.abandoned(latest.id)))
          throw new Error(
            "Crash chain counter missing; restore its state before resuming",
          );
        // Its Postgres row was written but its Redis state never was: nothing was played or announced.
        await this.db.delete(crashChains).where(eq(crashChains.id, latest.id));
        this.log.warn(`removed crash chain ${latest.id}, never initialized`);
      } else if (Number(played) < latest.length) return latest;
      else await this.releaseChain(latest.id);
    }
    return this.newChain();
  }

  /** A chain row with no Redis state, no revealed games and no round in preparation. */
  private async abandoned(chainId: string) {
    const k = keys(chainId);
    if ((await this.redis.exists(k.secret, k.chain)) > 0) return false;
    if ((await this.pendingGame())?.chainId === chainId) return false;
    const [game] = await this.db
      .select({ index: crashGames.index })
      .from(crashGames)
      .where(eq(crashGames.chainId, chainId))
      .limit(1);
    return !game;
  }

  private async newChain() {
    const chain = await createCrashChain(CHAIN_LENGTH);
    // Cache the expanded chain as a Redis list so each game is one LINDEX, not a 650 KB JSON parse.
    const all = await expandCrashChain(chain);
    const latestBlock = await this.beacon.evmLatestBlock();
    const id = randomUUID();
    const k = keys(id);
    const saltRef = String(latestBlock + SALT_BLOCK_OFFSET);
    // Public row first, so Redis never holds a secret that Postgres has no commitment for.
    await this.db.insert(crashChains).values({
      id,
      terminatingHash: chain.terminatingHash,
      length: chain.length,
      saltSource: "evm",
      saltRef,
    });
    try {
      const replies = await this.redis
        .multi()
        .del(k.chain)
        .rpush(k.chain, ...all)
        .set(k.secret, chain.secret)
        .set(k.played, 0)
        .exec();
      const failed = replies?.find(([error]) => error);
      if (!replies || failed)
        throw failed?.[0] ?? new Error("Redis discarded the new chain");
    } catch (e) {
      // Drop the row only once Redis is known clean; otherwise keep it with whatever Redis holds.
      // A row left without Redis state is removed by currentChain() as abandoned.
      const cleaned = await this.redis
        .del(k.secret, k.chain, k.played)
        .then(() => true, () => false);
      if (cleaned)
        await this.db
          .delete(crashChains)
          .where(eq(crashChains.id, id))
          .catch(() => undefined);
      throw e;
    }
    this.log.log(
      `new crash chain ${id}, terminating ${chain.terminatingHash}, salt = hash of block ${saltRef}`,
    );
    return (await this.db.query.crashChains.findFirst({
      where: eq(crashChains.id, id),
    }))!;
  }

  /**
   * Delete the secret and cached hash list once the chain's last game is revealed. The secret is
   * that game's hash, so nothing is lost. The played counter stays: it marks the chain as used up.
   */
  async releaseChain(chainId: string) {
    const chain = await this.db.query.crashChains.findFirst({
      where: eq(crashChains.id, chainId),
    });
    if (!chain) return false;
    const k = keys(chainId);
    if (Number((await this.redis.get(k.played)) ?? 0) < chain.length)
      return false;
    if ((await this.pendingGame())?.chainId === chainId) return false;
    const [last] = await this.db
      .select({ index: crashGames.index })
      .from(crashGames)
      .where(
        and(
          eq(crashGames.chainId, chainId),
          eq(crashGames.index, chain.length),
        ),
      )
      .limit(1);
    if (!last) return false;
    await this.redis.del(k.secret, k.chain);
    return true;
  }

  /** Resolve the salt once its block is mined. Null until then; the loop waits. */
  async salt(chainId: string): Promise<string | null> {
    const chain = await this.db.query.crashChains.findFirst({
      where: eq(crashChains.id, chainId),
    });
    if (!chain) return null;
    if (chain.saltValue) return chain.saltValue;
    const hash = await this.beacon.evmBlockHash(Number(chain.saltRef));
    if (!hash) return null;
    await this.db
      .update(crashChains)
      .set({ saltValue: hash })
      .where(eq(crashChains.id, chainId));
    return hash;
  }

  async pendingGame(): Promise<PendingCrash | null> {
    const raw = await this.redis.get("crash:pending");
    return raw ? (JSON.parse(raw) as PendingCrash) : null;
  }

  /** The hash game `index` must link to: game index-1's revealed hash, or the terminating hash. */
  private async previousHash(chainId: string, index: number) {
    if (index === 1) {
      const chain = await this.db.query.crashChains.findFirst({
        where: eq(crashChains.id, chainId),
      });
      return chain?.terminatingHash ?? null;
    }
    const [previous] = await this.db
      .select({ gameHash: crashGames.gameHash })
      .from(crashGames)
      .where(
        and(eq(crashGames.chainId, chainId), eq(crashGames.index, index - 1)),
      )
      .limit(1);
    return previous?.gameHash ?? null;
  }

  /** Prepare privately. History receives the reveal only after the clock has closed the round. */
  async nextGame(chainId: string, salt: string) {
    const pending = await this.pendingGame();
    if (pending) return pending;
    const played = await this.redis.get(keys(chainId).played);
    if (played === null) throw new Error("Crash chain counter missing");
    const index = Number(played) + 1;
    const cached = await this.redis.lindex(keys(chainId).chain, index);
    let gameHash: string;
    if (cached) {
      gameHash = cached;
    } else {
      const secret = await this.redis.get(keys(chainId).secret);
      const chain = await this.db.query.crashChains.findFirst({
        where: eq(crashChains.id, chainId),
      });
      if (!secret || !chain) throw new Error("chain secret missing");
      gameHash = await crashGameHash(
        {
          secret,
          terminatingHash: chain.terminatingHash,
          length: chain.length,
        },
        index,
      );
    }
    const previous = await this.previousHash(chainId, index);
    const label = index === 1 ? "the terminating hash" : `game ${index - 1}`;
    if (!previous)
      throw new CrashIntegrityError(
        `Crash chain ${chainId}: cannot check game ${index}, ${label} has no revealed hash. Engine stopped.`,
      );
    if (!(await verifyCrashLink(gameHash, previous)))
      throw new CrashIntegrityError(
        `Crash chain ${chainId}: the stored hash for game ${index} does not link to ${label} ` +
          "(sha256(next) != previous). Engine stopped; restore the chain cache and secret before resuming.",
      );
    const result = await crashResult(gameHash, salt, HOUSE_EDGE);
    const game = { chainId, index, gameHash, result, salt };
    const saved = await this.redis.eval(
      `
      if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      redis.call('MSET', KEYS[1], ARGV[2], KEYS[2], ARGV[3]); return 1`,
      2,
      keys(chainId).played,
      "crash:pending",
      played,
      index,
      JSON.stringify(game),
    );
    if (saved !== 1)
      throw new Error("Crash chain changed while preparing a round");
    return game;
  }

  /**
   * Reveal a closed round. A voided round is revealed too, with its refund recorded in the audit
   * log in the same transaction, so history never shows the hash without the void.
   */
  async completeGame(game: PendingCrash, voided?: RefundSummary) {
    const state = await this.redis.hgetall("crash:state");
    if (
      state.phase !== (voided ? "void" : "crashed") ||
      state.chainId !== game.chainId ||
      Number(state.index) !== game.index
    )
      throw new Error(
        voided
          ? "Cannot record a void for a round that was not voided"
          : "Cannot reveal an unfinished Crash round",
      );
    const row = {
      chainId: game.chainId,
      index: game.index,
      gameHash: game.gameHash,
      result: game.result.toFixed(2),
    };
    if (!voided) {
      await this.db.insert(crashGames).values(row).onConflictDoNothing();
      return;
    }
    await this.db.transaction(async (tx) => {
      await tx.insert(crashGames).values(row).onConflictDoNothing();
      await tx
        .insert(auditLog)
        .values({
          id: `${VOID_ACTION}:${voidSubject(game.chainId, game.index)}`,
          actor: "crash-engine",
          action: VOID_ACTION,
          subject: voidSubject(game.chainId, game.index),
          detail: {
            chainId: game.chainId,
            index: game.index,
            reason: "the engine could not prove the round ran to its deadline",
            voidedAt: Number(state.voidedAt) || null,
            ...voided,
          },
        })
        .onConflictDoNothing();
    });
  }

  async finishGame(game: PendingCrash) {
    await this.redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
      1,
      "crash:pending",
      JSON.stringify(game),
    );
  }

  /** Public history for the verify page: last N games with hashes. Voided rounds are flagged. */
  async history(limit = 50) {
    const state = await this.redis.hgetall("crash:state");
    const closed = state.phase === "crashed" || state.phase === "void";
    const rows = await this.db
      .select({
        chainId: crashGames.chainId,
        index: crashGames.index,
        gameHash: crashGames.gameHash,
        result: crashGames.result,
        playedAt: crashGames.playedAt,
      })
      .from(crashGames)
      // Hide a legacy row written by the old engine before the round finished.
      .where(
        state.chainId && state.index && !closed
          ? not(
              and(
                eq(crashGames.chainId, state.chainId),
                eq(crashGames.index, Number(state.index)),
              )!,
            )
          : undefined,
      )
      .orderBy(desc(crashGames.playedAt))
      .limit(limit);
    if (!rows.length) return [];
    const voids = await this.db
      .select({ subject: auditLog.subject })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, VOID_ACTION),
          inArray(
            auditLog.subject,
            rows.map((r) => voidSubject(r.chainId, r.index)),
          ),
        ),
      );
    const voided = new Set(voids.map((v) => v.subject));
    return rows.map((r) => ({
      ...r,
      voided: voided.has(voidSubject(r.chainId, r.index)),
    }));
  }

  async chainInfo(chainId: string) {
    const chain = await this.db.query.crashChains.findFirst({
      where: eq(crashChains.id, chainId),
    });
    if (!chain) return null;
    const played = Number((await this.redis.get(keys(chainId).played)) ?? 0);
    return { ...chain, played, houseEdge: HOUSE_EDGE };
  }
}
