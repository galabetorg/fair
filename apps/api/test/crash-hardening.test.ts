import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Redis from "ioredis";
import { Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { createCrashChain, expandCrashChain } from "@galabet/fair";
import { CrashBets } from "../src/crash/crash.bets";
import { CrashEngine } from "../src/crash/crash.engine";
import { CrashIntegrityError, CrashService } from "../src/crash/crash.service";
import { publicCrashMessage } from "../src/crash/crash.gateway";

// Regression tests for engine-outage voids, chain secret lifecycle and integer-cent payouts.
Logger.overrideLogger(false);
const url = process.env.REDIS_TEST_URL;
const pgUrl = process.env.POSTGRES_TEST_URL;
const redisOnly = {
  skip: !url && "Set REDIS_TEST_URL to a disposable Redis instance.",
};
const withPostgres = {
  skip:
    (!url || !pgUrl) &&
    "Set REDIS_TEST_URL and POSTGRES_TEST_URL to disposable instances.",
};
const TTL = 3600;
const BACKSTOP = 7 * 24 * 60 * 60;
const SALT = "public salt";

async function scan(client: Redis, pattern: string) {
  const found: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await client.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      200,
    );
    cursor = next;
    found.push(...keys);
  } while (cursor !== "0");
  return found;
}

async function redisFixture(t: any) {
  const prefix = `fair-test:${randomUUID()}:`;
  const options = {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  };
  const redis = new Redis(url!, { ...options, keyPrefix: prefix });
  const raw = new Redis(url!, options);
  redis.on("error", () => {});
  raw.on("error", () => {});
  await redis.connect();
  await raw.connect();
  t.after(async () => {
    try {
      const keys = await scan(raw, prefix + "*");
      if (keys.length) await raw.del(...keys);
    } finally {
      redis.disconnect();
      raw.disconnect();
    }
  });
  const bets = new CrashBets(redis, {
    DEMO_START_CHIPS: 1000,
    DEMO_SESSION_TTL: TTL,
  } as any);
  const now = async () => {
    const [s, us] = await redis.time();
    return Number(s) * 1000 + Math.floor(Number(us) / 1000);
  };
  const session = async (balance?: number) => {
    const sid = randomUUID();
    await redis.set(`demo:session:${sid}`, "{}", "EX", TTL);
    if (balance !== undefined) await redis.set(`demo:chips:${sid}`, balance);
    return sid;
  };
  const chips = async (sid: string) =>
    Number(await redis.get(`demo:chips:${sid}`));
  const keysMatching = async (pattern: string) =>
    (await scan(raw, prefix + pattern))
      .map((key) => key.slice(prefix.length))
      .sort();
  /** Rewrite the round clock relative to Redis time; `seenAgo` is the engine's last look. */
  const setClock = async (
    phase: string,
    o: { startedAgo: number; endedAgo: number; seenAgo?: number },
  ) => {
    const time = await now();
    await redis.hset("crash:state", {
      phase,
      startsAt: time - o.startedAgo,
      endsAt: time - o.endedAgo,
    });
    if (o.seenAgo === undefined) await redis.hdel("crash:state", "seen");
    else await redis.hset("crash:state", "seen", time - o.seenAgo);
  };
  const running = async (result: number, elapsed: number) => {
    const time = await now();
    await redis.hset("crash:state", {
      phase: "running",
      startsAt: time - elapsed,
      endsAt: time - elapsed + (Math.log(result) / 0.06) * 1000,
      result,
      seen: time,
    });
  };
  const crashed = async (result: number) => {
    const time = await now();
    await redis.hset("crash:state", {
      phase: "crashed",
      endsAt: time - 1,
      result,
      multiplier: result,
    });
  };
  await bets.prepare("chain", 1, 10, 6000);
  return {
    redis,
    bets,
    now,
    session,
    chips,
    keysMatching,
    setClock,
    running,
    crashed,
  };
}

/** A throwaway schema with the checked-in baseline's DDL for the tables Crash uses. */
async function postgresFixture(t: any) {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const schema = await import("../src/db/schema");
  const namespace = "fair_test_" + randomUUID().replaceAll("-", "");
  const admin = new Pool({
    connectionString: pgUrl,
    connectionTimeoutMillis: 2000,
  });
  const pool = new Pool({
    connectionString: pgUrl,
    options: "-c search_path=" + namespace,
    connectionTimeoutMillis: 2000,
  });
  await admin.query(`CREATE SCHEMA "${namespace}"`);
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin.end();
  });
  const ddl = readFileSync(
    join(__dirname, "../drizzle/0000_baseline.sql"),
    "utf8",
  )
    .split("--> statement-breakpoint")
    .filter((statement) =>
      /CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS "(audit_log|audit_log_subject_idx|crash_chains|crash_games|crash_games_chain_index_idx)"/.test(
        statement,
      ),
    );
  assert.equal(ddl.length, 5);
  for (const statement of ddl) await pool.query(statement);
  // The baseline's foreign key names the public schema, so it is added here instead.
  await pool.query(
    "ALTER TABLE crash_games ADD FOREIGN KEY (chain_id) REFERENCES crash_chains(id)",
  );
  return { db: drizzle(pool, { schema }), pool, schema };
}

/** A short real chain, stored the way CrashService stores one. */
async function smallChain(db: any, schema: any, redis: Redis, length = 3) {
  const chain = await createCrashChain(length);
  const all = await expandCrashChain(chain);
  const id = randomUUID();
  await db.insert(schema.crashChains).values({
    id,
    terminatingHash: chain.terminatingHash,
    length,
    saltSource: "evm",
    saltRef: "20",
    saltValue: SALT,
  });
  await redis
    .multi()
    .rpush(`crash:chain:${id}`, ...all)
    .set(`crash:secret:${id}`, chain.secret)
    .set(`crash:played:${id}`, 0)
    .exec();
  return { id, chain, all };
}

/** Prepare, close and reveal one game in the order the engine uses. */
async function playThrough(crash: CrashService, redis: Redis, chainId: string) {
  const game = await crash.nextGame(chainId, SALT);
  await redis.hset("crash:state", {
    chainId,
    index: game.index,
    phase: "crashed",
  });
  await crash.completeGame(game);
  await crash.finishGame(game);
  await crash.releaseChain(chainId);
  return game;
}

// 1. Engine outage: void and refund instead of crashing a round nobody could watch.

test(
  "Redis: a round never seen running is voided at its deadline and each unsettled stake is refunded once",
  redisOnly,
  async (t) => {
    const { redis, bets, session, chips, setClock } = await redisFixture(t);
    const [a, b, c] = [await session(), await session(), await session()];
    await bets.place(a, 100, null);
    await bets.place(b, 250, 2);
    await bets.place(c, 40, null);
    // The worker last looked during betting, then was down past the round's deadline.
    await setClock("waiting", {
      startedAgo: 20_000,
      endedAgo: 5_000,
      seenAgo: 30_000,
    });
    assert.equal((await bets.advance()).phase, "void");
    assert.equal((await bets.advance()).phase, "void");
    assert.ok(Number(await redis.hget("crash:state", "voidedAt")) > 0);
    await assert.rejects(() => bets.settle("chain", 1), /not crashed/);
    await assert.rejects(() => bets.cashout(a), /no round running/);
    // c's balance expired meanwhile: like ChipsService, it restarts from the demo stake.
    await redis.del(`demo:chips:${c}`);
    const summaries = await Promise.all(
      Array.from({ length: 12 }, () => bets.refund("chain", 1)),
    );
    for (const summary of summaries)
      assert.deepEqual(summary, { bets: 3, refunded: 3, totalRefund: 390 });
    assert.deepEqual(
      [await chips(a), await chips(b), await chips(c)],
      [1000, 1000, 1040],
    );
    const { settled, refunded, payout, cashedAt } = (await bets.myBet(b))!;
    assert.deepEqual(
      { settled, refunded, payout, cashedAt },
      { settled: true, refunded: true, payout: 250, cashedAt: null },
    );
    const late = await session();
    await assert.rejects(() => bets.place(late, 10, null), /waiting/);
  },
);

test(
  "Redis: a run the engine stopped watching long before its deadline is voided; cash-outs already paid stay paid",
  redisOnly,
  async (t) => {
    const { bets, session, chips, setClock, running } = await redisFixture(t);
    const manual = await session();
    const capped = await session();
    const auto = await session();
    const plain = await session();
    await bets.place(manual, 100, null);
    await bets.place(capped, 100, 1.5);
    await bets.place(auto, 100, 5);
    await bets.place(plain, 200, null);
    await running(10, (Math.log(3) / 0.06) * 1000);
    const paidManual = await bets.cashout(manual);
    // The automatic target was already reached, so this cash-out is the auto payout.
    const paidCapped = await bets.cashout(capped);
    assert.equal(paidCapped.payout, 150);
    // The last tick was 7 s before the deadline; the engine came back after it.
    await setClock("running", {
      startedAgo: 40_000,
      endedAgo: 1_000,
      seenAgo: 8_000,
    });
    assert.equal((await bets.advance()).phase, "void");
    const first = await bets.refund("chain", 1);
    const again = await bets.refund("chain", 1);
    assert.deepEqual(first, { bets: 4, refunded: 2, totalRefund: 300 });
    assert.deepEqual(again, first);
    assert.deepEqual(
      [await chips(manual), await chips(capped), await chips(auto), await chips(plain)],
      [900 + paidManual.payout!, 1050, 1000, 1000],
    );
    const kept = (await bets.myBet(manual))!;
    assert.equal(kept.refunded, undefined);
    assert.equal(kept.payout, paidManual.payout);
  },
);

test(
  "Redis: a crash stands only when the engine can prove the round ran to its deadline",
  redisOnly,
  async (t) => {
    const { redis, bets, setClock } = await redisFixture(t);
    const cases: [string, string, number, number, number | undefined, string][] = [
      ["engine down through the whole run", "waiting", 20_000, 5_000, 30_000, "void"],
      ["engine left mid-run, 7 s before the deadline", "running", 20_000, 5_000, 12_000, "void"],
      ["state written without look times", "running", 20_000, 5_000, undefined, "void"],
      ["last look 300 ms before the deadline", "running", 20_000, 5_000, 5_300, "crashed"],
      ["short round between two consecutive looks", "waiting", 150, 20, 120, "crashed"],
      ["engine back before the deadline resumes", "waiting", 3_000, -60_000, 30_000, "running"],
    ];
    for (const [label, phase, startedAgo, endedAgo, seenAgo, expected] of cases) {
      await setClock(phase, { startedAgo, endedAgo, seenAgo });
      assert.equal((await bets.advance()).phase, expected, label);
    }
    // Closed rounds are final: a later look cannot turn a crash into a void or back.
    await setClock("crashed", { startedAgo: 20_000, endedAgo: 5_000, seenAgo: 60_000 });
    assert.equal((await bets.advance()).phase, "crashed");
    await redis.hset("crash:state", "phase", "void");
    assert.equal((await bets.advance()).phase, "void");
  },
);

test(
  "Crash engine: restarted after the deadline, it voids the round, refunds, reveals and announces the void",
  redisOnly,
  async (t) => {
    const { redis, bets, session, chips, setClock } = await redisFixture(t);
    const a = await session();
    const b = await session();
    await bets.place(a, 100, null);
    await bets.place(b, 250, 2);
    await setClock("waiting", {
      startedAgo: 20_000,
      endedAgo: 5_000,
      seenAgo: 30_000,
    });
    const game = {
      chainId: "chain",
      index: 1,
      gameHash: "a".repeat(64),
      result: 10,
      salt: "salt",
    };
    const order: string[] = [];
    const completed: unknown[] = [];
    const messages: any[] = [];
    const service = {
      pendingGame: async () => game,
      completeGame: async (...args: unknown[]) => {
        order.push("reveal");
        completed.push(args);
      },
      finishGame: async () => {
        order.push("finish");
      },
      releaseChain: async () => {
        order.push("release");
        return false;
      },
    };
    const retire = bets.retire.bind(bets);
    bets.retire = async (chainId: string, index: number) => {
      order.push("retire");
      return retire(chainId, index);
    };
    const engine = new CrashEngine(
      {
        publish: async (_: string, message: string) => {
          messages.push(JSON.parse(message));
        },
      } as any,
      service as any,
      bets,
    );
    await (engine as any).round();
    const refunded = { bets: 2, refunded: 2, totalRefund: 350 };
    const announced = { type: "void", ...game, refunded };
    assert.deepEqual(messages, [announced]);
    assert.deepEqual(completed, [[game, refunded]]);
    assert.deepEqual(order, ["reveal", "retire", "finish", "release"]);
    assert.deepEqual([await chips(a), await chips(b)], [1000, 1000]);
    // A retried round (lost reply, restart) reports the same refund and credits nothing more.
    await (engine as any).round();
    assert.deepEqual(messages, [announced, announced]);
    assert.deepEqual([await chips(a), await chips(b)], [1000, 1000]);
    for (const key of [
      "crash:bets:chain:1",
      `crash:bet:chain:1:${a}`,
      `crash:bet:chain:1:${b}`,
    ]) {
      const ttl = await redis.ttl(key);
      assert.ok(ttl > 0 && ttl <= TTL, `${key} ttl ${ttl}`);
    }
    // The public socket message keeps the reveal and the aggregate refund only.
    const relayed = publicCrashMessage(
      JSON.stringify({ ...announced, sid: a, bets: [{ sid: b }] }),
    )!;
    assert.deepEqual(JSON.parse(relayed), announced);
    assert.equal(relayed.includes(a) || relayed.includes(b), false);
  },
);

test("Crash engine: a failure while expiring bet keys keeps the round pending for the retry", async () => {
  const order: string[] = [];
  const game = {
    chainId: "chain",
    index: 1,
    gameHash: "a".repeat(64),
    result: 2,
    salt: "salt",
  };
  const service = {
    pendingGame: async () => game,
    completeGame: async () => {
      order.push("reveal");
    },
    finishGame: async () => {
      order.push("finish");
    },
    releaseChain: async () => {
      order.push("release");
    },
  };
  const bets = {
    prepare: async () => {},
    advance: async () => ({ phase: "crashed", multiplier: 2, startsAt: 0, elapsed: 0 }),
    settle: async () => ({ bets: 0, paid: 0, totalPayout: 0 }),
    retire: async () => {
      order.push("retire");
      throw new Error("Redis unavailable");
    },
  };
  const engine = new CrashEngine(
    { publish: async () => {} } as any,
    service as any,
    bets as any,
  );
  await assert.rejects(() => (engine as any).round(), /Redis unavailable/);
  assert.deepEqual(order, ["reveal", "retire"]);
});

test(
  "Postgres + Redis: a voided round is revealed and flagged in history, recorded once, and the chain continues",
  withPostgres,
  async (t) => {
    const { redis, bets, session, chips, setClock } = await redisFixture(t);
    const { db, schema } = await postgresFixture(t);
    const crash = new CrashService(db, redis, {} as any);
    const { id, all } = await smallChain(db, schema, redis);
    const first = await playThrough(crash, redis, id);
    const game = await crash.nextGame(id, SALT);
    await bets.prepare(id, 2, game.result, 6000);
    const sid = await session();
    await bets.place(sid, 100, null);
    await setClock("waiting", {
      startedAgo: 20_000,
      endedAgo: 5_000,
      seenAgo: 30_000,
    });
    const summary = { bets: 1, refunded: 1, totalRefund: 100 };
    await assert.rejects(() => crash.completeGame(game, summary), /not voided/);
    assert.equal((await bets.advance()).phase, "void");
    // A voided round is never revealed as an ordinary crash.
    await assert.rejects(() => crash.completeGame(game), /unfinished/);
    const refunded = await bets.refund(id, 2);
    assert.deepEqual(refunded, summary);
    await crash.completeGame(game, refunded);
    await crash.completeGame(game, refunded);
    assert.equal(await chips(sid), 1000);
    const history = await crash.history();
    assert.deepEqual(
      history.map((row) => [row.index, row.gameHash, row.result, row.voided]),
      [
        [2, all[2], game.result.toFixed(2), true],
        [1, all[1], first.result.toFixed(2), false],
      ],
    );
    const audit = await db.select().from(schema.auditLog);
    assert.equal(audit.length, 1);
    assert.deepEqual(
      { ...audit[0], at: undefined },
      {
        id: `crash.void:${id}:2`,
        actor: "crash-engine",
        action: "crash.void",
        subject: `${id}:2`,
        at: undefined,
        detail: {
          chainId: id,
          index: 2,
          reason: "the engine could not prove the round ran to its deadline",
          voidedAt: Number(await redis.hget("crash:state", "voidedAt")),
          ...summary,
        },
      },
    );
    // The void consumed game 2's hash; game 3 links to it.
    await crash.finishGame(game);
    assert.equal((await crash.nextGame(id, SALT)).gameHash, all[3]);
  },
);

// 2. Chain secret, cache and bet-key lifecycle.

test(
  "Postgres + Redis: a new chain is written to Postgres before Redis, and neither failure leaves a secret behind",
  withPostgres,
  async (t) => {
    const { redis, keysMatching } = await redisFixture(t);
    const { db, pool, schema } = await postgresFixture(t);
    const beacon = { evmLatestBlock: async () => 100 };
    const crash = new CrashService(db, redis, beacon as any);
    const chainKeys = async () => [
      ...(await keysMatching("crash:secret:*")),
      ...(await keysMatching("crash:chain:*")),
      ...(await keysMatching("crash:played:*")),
    ];
    const rows = async () =>
      (await db.select({ id: schema.crashChains.id }).from(schema.crashChains)).map(
        (row) => row.id,
      );

    // Postgres refuses the row: nothing reaches Redis.
    await pool.query(
      "ALTER TABLE crash_chains ADD CONSTRAINT refuse_rows CHECK (false) NOT VALID",
    );
    await assert.rejects(() => crash.currentChain(), /refuse_rows/);
    assert.deepEqual(await chainKeys(), []);
    await pool.query("ALTER TABLE crash_chains DROP CONSTRAINT refuse_rows");

    // Redis fails after the row is written: the row is removed and Redis is left clean.
    const failing = new Proxy(redis, {
      get(target, prop) {
        if (prop === "multi")
          return () => {
            const transaction = target.multi();
            transaction.exec = async () => {
              throw new Error("Redis write failed");
            };
            return transaction;
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await assert.rejects(
      () => new CrashService(db, failing, beacon as any).currentChain(),
      /Redis write failed/,
    );
    assert.deepEqual(await rows(), []);
    assert.deepEqual(await chainKeys(), []);

    // The worker died between the two writes: the row without Redis state is replaced.
    await db.insert(schema.crashChains).values({
      id: "abandoned",
      terminatingHash: "b".repeat(64),
      length: 10,
      saltSource: "evm",
      saltRef: "20",
    });
    const chain = await crash.currentChain();
    assert.deepEqual(await rows(), [chain.id]);
    assert.equal(await redis.get(`crash:played:${chain.id}`), "0");
    assert.equal(await redis.llen(`crash:chain:${chain.id}`), 10_001);
    assert.equal(
      await redis.lindex(`crash:chain:${chain.id}`, 0),
      chain.terminatingHash,
    );
    assert.equal(await redis.exists(`crash:secret:${chain.id}`), 1);

    // A chain whose secret exists but whose counter is gone still fails closed.
    await redis.del(`crash:played:${chain.id}`);
    await assert.rejects(() => crash.currentChain(), /counter missing/);
  },
);

test(
  "Postgres + Redis: hashes are link-checked before use, and the secret and cache go once the last game is revealed",
  withPostgres,
  async (t) => {
    const { redis, keysMatching } = await redisFixture(t);
    const { db, schema } = await postgresFixture(t);
    const crash = new CrashService(db, redis, {} as any);
    const { id, chain, all } = await smallChain(db, schema, redis);
    const integrity = (pattern: RegExp) => (e: unknown) =>
      e instanceof CrashIntegrityError && pattern.test(e.message);
    assert.equal((await playThrough(crash, redis, id)).gameHash, all[1]);

    // A tampered cache entry for game 2 is refused, and nothing is prepared.
    await redis.lset(`crash:chain:${id}`, 2, "f".repeat(64));
    await assert.rejects(
      () => crash.nextGame(id, SALT),
      integrity(/game 2 does not link to game 1 \(sha256\(next\) != previous\)/),
    );
    assert.equal(await crash.pendingGame(), null);
    assert.equal(await redis.get(`crash:played:${id}`), "1");
    await redis.lset(`crash:chain:${id}`, 2, all[2]!);

    // Without game 1's reveal there is nothing to check against: also refused.
    const [revealed] = await db
      .delete(schema.crashGames)
      .where(eq(schema.crashGames.index, 1))
      .returning();
    await assert.rejects(
      () => crash.nextGame(id, SALT),
      integrity(/game 1 has no revealed hash/),
    );
    await db.insert(schema.crashGames).values(revealed!);

    assert.equal((await playThrough(crash, redis, id)).gameHash, all[2]);
    const last = await crash.nextGame(id, SALT);
    // Prepared but not yet revealed: the secret stays.
    assert.equal(await crash.releaseChain(id), false);
    assert.equal(await redis.exists(`crash:secret:${id}`, `crash:chain:${id}`), 2);
    await redis.hset("crash:state", { chainId: id, index: 3, phase: "crashed" });
    await crash.completeGame(last);
    await crash.finishGame(last);
    assert.equal(await crash.releaseChain(id), true);
    assert.equal(await crash.releaseChain(id), true);
    assert.deepEqual(await keysMatching(`crash:*:${id}`), [`crash:played:${id}`]);
    assert.equal(await redis.get(`crash:played:${id}`), "3");
    // The deleted secret is the last game's hash, which history now shows.
    assert.equal(last.gameHash, chain.secret);
    assert.equal(
      (await crash.history()).some((row) => row.gameHash === chain.secret),
      true,
    );
  },
);

test("Crash engine: a failed link check stops the loop instead of retrying", async () => {
  const messages: any[] = [];
  let attempts = 0;
  const service = {
    pendingGame: async () => null,
    currentChain: async () => ({ id: "chain", saltRef: "20" }),
    salt: async () => "salt",
    nextGame: async () => {
      attempts++;
      throw new CrashIntegrityError("stored hash for game 2 does not link");
    },
  };
  const engine = new CrashEngine(
    {
      publish: async (_: string, message: string) => {
        messages.push(JSON.parse(message));
      },
    } as any,
    service as any,
    {} as any,
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      engine.start(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("engine kept retrying")), 3_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    engine.onModuleDestroy();
  }
  assert.equal(attempts, 1);
  assert.deepEqual(messages, [
    {
      type: "paused",
      reason: "engine stopped: Crash chain failed its integrity check",
    },
  ]);
});

test(
  "Redis: bet keys expire from placement on, and settlement re-applies the expiry that MSET clears",
  redisOnly,
  async (t) => {
    const { redis, bets, session, crashed } = await redisFixture(t);
    const sid = await session();
    await bets.place(sid, 100, 2);
    const betKey = `crash:bet:chain:1:${sid}`;
    for (const key of [betKey, "crash:bets:chain:1"]) {
      const ttl = await redis.ttl(key);
      assert.ok(ttl > BACKSTOP - 10 && ttl <= BACKSTOP, `${key} ttl ${ttl}`);
    }
    await crashed(10);
    await bets.settle("chain", 1);
    const ttl = await redis.ttl(betKey);
    assert.ok(ttl > 0 && ttl <= TTL, `settled bet ttl ${ttl}`);
  },
);

// 3. Payouts in integer cents, and one missing-balance rule for debit and credit.

test(
  "Redis: automatic cash-outs pay floor(amount x cents / 100), so 100 x 2.01 pays 201",
  redisOnly,
  async (t) => {
    const { redis, bets, session, chips, crashed } = await redisFixture(t);
    const targets = [1.01, 1.13, 1.15, 2.01, 4.35, 9.95, 57.99, 1234.56, 4999.99];
    const amounts = [1, 3, 7, 100, 333, 99_999, 100_000];
    const placed: { sid: string; amount: number; target: number; expected: number }[] = [];
    for (const target of targets)
      for (const amount of amounts) {
        const sid = await session(1_000_000);
        await bets.place(sid, amount, target);
        const cents = BigInt(Math.round(target * 100));
        placed.push({ sid, amount, target, expected: Number((BigInt(amount) * cents) / 100n) });
      }
    await crashed(5000);
    const summary = await bets.settle("chain", 1);
    let floatWouldDiffer = 0;
    for (const { sid, amount, target, expected } of placed) {
      const bet = JSON.parse((await redis.get(`crash:bet:chain:1:${sid}`))!);
      assert.equal(bet.payout, expected, `${amount} x ${target}`);
      assert.equal(await chips(sid), 1_000_000 - amount + expected);
      if (Math.floor(amount * target) !== expected) floatWouldDiffer++;
    }
    assert.ok(floatWouldDiffer > 0, "the table includes cases the old formula got wrong");
    assert.equal(
      placed.find((p) => p.amount === 100 && p.target === 2.01)!.expected,
      201,
    );
    assert.deepEqual(summary, {
      bets: placed.length,
      paid: placed.length,
      totalPayout: placed.reduce((total, p) => total + p.expected, 0),
    });
  },
);

test(
  "Redis: a manual cash-out at 1.13x pays 113 for 100, not floor(112.99999999999999)",
  redisOnly,
  async (t) => {
    const { bets, session, running } = await redisFixture(t);
    const sid = await session();
    await bets.place(sid, 100, null);
    // Put Redis's clock in the middle of the 1.13x step, where exp(0.06 t) is in [1.13, 1.14).
    await running(10, ((Math.log(1.13) + Math.log(1.14)) / 2 / 0.06) * 1000);
    assert.deepEqual(await bets.cashout(sid), {
      multiplier: 1.13,
      payout: 113,
      chips: 1013,
    });
  },
);

test(
  "Redis: a balance that expires mid-round restarts from the demo stake on credit, as it does on debit",
  redisOnly,
  async (t) => {
    const { redis, bets, session, chips, crashed } = await redisFixture(t);
    const sid = await session();
    await bets.place(sid, 100, 2.01);
    assert.equal(await chips(sid), 900);
    await redis.del(`demo:chips:${sid}`);
    await crashed(10);
    await bets.settle("chain", 1);
    assert.equal(await chips(sid), 1000 + 201);
    const ttl = await redis.ttl(`demo:chips:${sid}`);
    assert.ok(ttl > 0 && ttl <= TTL);
  },
);
