import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import Redis from "ioredis";
import { CrashBets } from "../src/crash/crash.bets";
import { RedisSeedStore } from "../src/demo/seed-store";

const url = process.env.REDIS_TEST_URL;
const options = {
  skip:
    !url &&
    "Set REDIS_TEST_URL to a disposable Redis instance to run the real-Lua regression tests.",
};
async function fixture(t: any) {
  const prefix = `fair-test:${randomUUID()}:`;
  const redis = new Redis(url!, {
    keyPrefix: prefix,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  redis.on("error", () => {});
  await redis.connect();
  t.after(async () => {
    const cleanup = new Redis(url!, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    cleanup.on("error", () => {});
    try {
      await cleanup.connect();
      let cursor = "0";
      do {
        const [next, keys] = await cleanup.scan(
          cursor,
          "MATCH",
          prefix + "*",
          "COUNT",
          100,
        );
        cursor = next;
        if (keys.length) await cleanup.del(...keys);
      } while (cursor !== "0");
    } finally {
      redis.disconnect();
      cleanup.disconnect();
    }
  });
  const config = { DEMO_START_CHIPS: 1000, DEMO_SESSION_TTL: 3600 } as any;
  const bets = new CrashBets(redis, config);
  const sid = randomUUID();
  await redis.set(`demo:session:${sid}`, "{}", "EX", 3600);
  const now = async () => {
    const [s, us] = await redis.time();
    return Number(s) * 1000 + Math.floor(Number(us) / 1000);
  };
  const running = async (
    result = 10,
    elapsed = (Math.log(3) / 0.06) * 1000,
  ) => {
    const time = await now();
    await redis.hset("crash:state", {
      phase: "running",
      startsAt: time - elapsed,
      endsAt: time - elapsed + (Math.log(result) / 0.06) * 1000,
      result,
      multiplier: 1,
    });
  };
  const crashed = async (result = 10) => {
    const time = await now();
    await redis.hset("crash:state", {
      phase: "crashed",
      endsAt: time - 1,
      result,
      multiplier: result,
    });
  };
  await bets.prepare("chain", 1, 10, 6000);
  return { redis, bets, sid, running, crashed, now };
}

test(
  "Redis: concurrent bets debit once, even with different request keys",
  options,
  async (t) => {
    const { redis, bets, sid } = await fixture(t);
    const placed = await Promise.allSettled(
      Array.from({ length: 24 }, () => bets.place(sid, 100, 2)),
    );
    assert.equal(placed.filter((p) => p.status === "fulfilled").length, 1);
    assert.equal(await redis.get(`demo:chips:${sid}`), "900");
    assert.equal((await bets.myBet(sid))!.amount, 100);
  },
);

test(
  "Redis: closed betting deadline rejects even when the worker still says waiting",
  options,
  async (t) => {
    const { redis, bets, sid, now } = await fixture(t);
    await redis.hset("crash:state", "startsAt", (await now()) - 1);
    await assert.rejects(() => bets.place(sid, 100, 2), /waiting/);
    assert.equal(await redis.get(`demo:chips:${sid}`), null);
  },
);

test(
  "Redis: concurrent manual cash-outs pay once and respect an already-reached auto target",
  options,
  async (t) => {
    const { redis, bets, sid, running, crashed } = await fixture(t);
    await bets.place(sid, 100, 2);
    await running();
    const paid = await Promise.allSettled(
      Array.from({ length: 24 }, () => bets.cashout(sid)),
    );
    assert.equal(paid.filter((p) => p.status === "fulfilled").length, 1);
    assert.equal(await redis.get(`demo:chips:${sid}`), "1100");
    assert.equal((await bets.myBet(sid))!.cashedAt, 2);
    await crashed();
    await Promise.all([bets.settle("chain", 1), bets.settle("chain", 1)]);
    assert.equal(await redis.get(`demo:chips:${sid}`), "1100");
  },
);

test(
  "Redis: cash-out after the deadline fails even when the last phase/tick is stale",
  options,
  async (t) => {
    const { redis, bets, sid, running, now } = await fixture(t);
    await bets.place(sid, 100, null);
    await running();
    await redis.hset("crash:state", {
      endsAt: (await now()) - 1,
      multiplier: 10,
    });
    await assert.rejects(() => bets.cashout(sid), /no round running/);
    assert.equal(await redis.get(`demo:chips:${sid}`), "900");
  },
);

test(
  "Redis: auto ties lose, retries cannot pay twice, and a delayed cash-out cannot race settlement",
  options,
  async (t) => {
    const { redis, bets, sid, crashed } = await fixture(t);
    const winner = randomUUID();
    await redis.set(`demo:session:${winner}`, "{}");
    await bets.place(sid, 100, 2);
    await bets.place(winner, 100, 1.5);
    await crashed(2);
    const calls = await Promise.allSettled([
      bets.cashout(winner),
      bets.settle("chain", 1),
      bets.settle("chain", 1),
    ]);
    assert.equal(calls[0]!.status, "rejected");
    assert.equal(await redis.get(`demo:chips:${sid}`), "900");
    assert.equal(await redis.get(`demo:chips:${winner}`), "1050");
    const summary = await bets.settle("chain", 1);
    assert.deepEqual(summary, { bets: 2, paid: 1, totalPayout: 150 });
    assert.equal(await redis.get(`demo:chips:${winner}`), "1050");
  },
);

test(
  "Redis: an instant crash has no running tick and prepare does not reset a recovered clock",
  options,
  async (t) => {
    const { redis, bets, now } = await fixture(t);
    await bets.prepare("other", 2, 1, 0);
    assert.equal((await bets.advance()).phase, "crashed");
    const original = await redis.hget("crash:state", "startsAt");
    await bets.prepare("other", 2, 1, 6000);
    assert.equal(await redis.hget("crash:state", "startsAt"), original);
    await redis.hset("crash:state", {
      phase: "running",
      startsAt: (await now()) - 1000,
      endsAt: (await now()) - 1,
    });
    assert.equal((await bets.advance()).phase, "crashed");
  },
);

test(
  "Redis: an orphan bet index has no debit and cannot block settlement",
  options,
  async (t) => {
    const { redis, bets, sid, crashed } = await fixture(t);
    await redis.hset("crash:bets:chain:1", sid, "1");
    await crashed();
    assert.deepEqual(await bets.settle("chain", 1), {
      bets: 0,
      paid: 0,
      totalPayout: 0,
    });
    assert.equal(await redis.get(`demo:chips:${sid}`), null);
  },
);

test(
  "Redis: nonce reservation is unique, expiry stays paired, and missing counters fail closed",
  options,
  async (t) => {
    const { redis, sid } = await fixture(t);
    await redis.del(`demo:session:${sid}`);
    const store = new RedisSeedStore(redis);
    const session = {
      id: sid,
      serverSeed: "a".repeat(64),
      commitment: "b".repeat(64),
      clientSeed: "client",
      betsUnderSeed: 0,
      createdAt: Date.now(),
    };
    await store.put(session, 10);
    const nonces = await Promise.all(
      Array.from({ length: 30 }, () =>
        store.reserveNonce(sid, 10, session.commitment),
      ),
    );
    assert.deepEqual(
      nonces.sort((a, b) => a - b),
      Array.from({ length: 30 }, (_, i) => i),
    );
    await store.put({ ...session, betsUnderSeed: 30 }, 100, session.commitment);
    const expiry = await redis
      .multi()
      .pttl(`demo:session:${sid}`)
      .pttl(`demo:nonce:${sid}`)
      .exec();
    assert.equal(expiry![0]![1], expiry![1]![1]);
    assert.equal(await store.peekNonce(sid), 30);
    await redis.del(`demo:nonce:${sid}`);
    await assert.rejects(
      () => store.reserveNonce(sid, 100, session.commitment),
      /nonce unavailable/,
    );
    await assert.rejects(
      () => store.put(session, 100, session.commitment),
      /nonce missing/,
    );
    await store.put(
      { ...session, commitment: "c".repeat(64), serverSeed: "d".repeat(64) },
      100,
      session.commitment,
    );
    assert.equal(await store.reserveNonce(sid, 100, "c".repeat(64)), 0);
    await assert.rejects(
      () => store.reserveNonce(sid, 100, session.commitment),
      /nonce unavailable/,
    );
    await assert.rejects(
      () => store.put(session, 100, session.commitment),
      /session changed/,
    );
    await redis.del(`demo:session:${sid}`, `demo:nonce:${sid}`);
    await assert.rejects(
      () => store.put(session, 100, session.commitment),
      /expired/,
    );
  },
);

test(
  "Postgres + Redis: Crash history contains completed reveals only, including legacy-row filtering",
  {
    skip:
      (!url || !process.env.POSTGRES_TEST_URL) &&
      "Set REDIS_TEST_URL and POSTGRES_TEST_URL for the history integration test.",
  },
  async (t) => {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { CrashService } = await import("../src/crash/crash.service");
    const schema = await import("../src/db/schema");
    const { redis } = await fixture(t);
    const namespace = "fair_test_" + randomUUID().replaceAll("-", "");
    const admin = new Pool({
      connectionString: process.env.POSTGRES_TEST_URL,
      connectionTimeoutMillis: 2000,
    });
    const pool = new Pool({
      connectionString: process.env.POSTGRES_TEST_URL,
      options: "-c search_path=" + namespace,
      connectionTimeoutMillis: 2000,
    });
    try {
      await admin.query('CREATE SCHEMA "' + namespace + '"');
      await pool.query(`
      CREATE TABLE crash_chains (id text PRIMARY KEY, terminating_hash text NOT NULL, length integer NOT NULL,
        salt_source text NOT NULL, salt_ref text NOT NULL, salt_value text, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE crash_games (chain_id text REFERENCES crash_chains(id), index integer NOT NULL, game_hash text NOT NULL,
        result text NOT NULL, played_at timestamptz NOT NULL DEFAULT now(), UNIQUE(chain_id, index));
      CREATE TABLE audit_log (id text PRIMARY KEY, actor text NOT NULL, action text NOT NULL, subject text NOT NULL,
        detail jsonb, at timestamptz NOT NULL DEFAULT now());
    `);
      const db = drizzle(pool, { schema });
      await db
        .insert(schema.crashChains)
        .values({
          id: "chain",
          // Game 1 must link to the terminating hash: sha256(game 1's hash) == terminatingHash.
          terminatingHash: createHash("sha256").update("a".repeat(64)).digest("hex"),
          length: 10,
          saltSource: "evm",
          saltRef: "20",
        });
      await redis.set("crash:played:chain", "0");
      await redis.rpush("crash:chain:chain", "unused", "a".repeat(64));
      const crash = new CrashService(db, redis, {} as any);
      const game = await crash.nextGame("chain", "public salt");
      assert.deepEqual(await crash.history(), []);
      assert.equal((await db.select().from(schema.crashGames)).length, 0);
      await assert.rejects(() => crash.completeGame(game), /unfinished/);
      await redis.hset("crash:state", "phase", "crashed");
      await crash.completeGame(game);
      await crash.completeGame(game);
      const history = await crash.history();
      assert.equal(history.length, 1);
      assert.equal(history[0]!.gameHash, game.gameHash);
      await db
        .insert(schema.crashGames)
        .values({
          chainId: "chain",
          index: 2,
          gameHash: "c".repeat(64),
          result: "99.99",
        });
      await redis.hset("crash:state", { phase: "running", index: 2 });
      assert.equal((await crash.history()).length, 1);
      assert.equal(
        JSON.stringify(await crash.history()).includes("99.99"),
        false,
      );
    } finally {
      await pool.end();
      await admin.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
      await admin.end();
    }
  },
);
