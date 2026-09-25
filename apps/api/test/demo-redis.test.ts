import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { verifyRecord } from "@galabet/fair";
import { RedisSeedStore } from "../src/demo/seed-store";
import { DemoService } from "../src/demo/demo.service";
import { ChipsService } from "../src/demo/chips.service";
import { MinesService } from "../src/demo/mines.service";
import { chipPayout, minesMultiplier } from "../src/demo/rules";

// Demo seed/Mines scripts against real Redis. Crash scripts are covered in redis-hardening.test.ts.
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
  return { redis, sid: randomUUID() };
}

test(
  "Redis: revealed seeds, records and a linked Mines board keep the session's expiry",
  options,
  async (t) => {
    const { redis, sid } = await fixture(t);
    const store = new RedisSeedStore(redis, ["mines"]);
    const session = {
      id: sid,
      serverSeed: "a".repeat(64),
      commitment: "b".repeat(64),
      clientSeed: "client",
      betsUnderSeed: 0,
      createdAt: Date.now(),
    };
    const parts = ["session", "nonce", "revealed", "records", "mines"];
    const expiries = async () =>
      (await parts
        .reduce((tx, part) => tx.pttl(`demo:${part}:${sid}`), redis.multi())
        .exec())!.map(([, value]) => value as number);
    const assertPaired = async (atLeast: number) => {
      const expiry = await expiries();
      assert.ok(expiry[0]! > atLeast, `session expiry ${expiry[0]}`);
      assert.deepEqual(expiry, parts.map(() => expiry[0]));
    };
    await store.put(session, 10);
    await store.reveal(sid, "e".repeat(64), "f".repeat(64), 10);
    await store.pushRecord(
      sid,
      { commitment: "e".repeat(64) } as any,
      100,
      10,
    );
    await redis.set(`demo:mines:${sid}`, "{}", "EX", 10);
    // Before the fix only session and nonce moved here; the revealed seed kept its 10 s.
    await store.get(sid, 1000);
    await assertPaired(10_000);
    await store.reserveNonce(sid, 2000, session.commitment);
    await assertPaired(1_000_000);
    await store.put({ ...session, betsUnderSeed: 1 }, 3000, session.commitment);
    await assertPaired(2_000_000);
    await store.reveal(sid, "1".repeat(64), "2".repeat(64), 4000);
    await assertPaired(3_000_000);
    await store.pushRecord(sid, { commitment: "1".repeat(64) } as any, 100, 5000);
    await assertPaired(4_000_000);
    assert.deepEqual(Object.keys(await store.revealed(sid)).sort(), [
      "1".repeat(64),
      "e".repeat(64),
    ]);
    assert.equal((await store.records(sid, 10)).length, 2);
  },
);

test(
  "Redis: a retried Mines cash-out reports the credited payout, and forfeit frees an abandoned board",
  options,
  async (t) => {
    const { redis } = await fixture(t);
    let failBoardSave = false;
    const flaky = new Proxy(redis, {
      get(target, prop) {
        if (prop === "set")
          return (key: string, ...rest: any[]) => {
            if (failBoardSave && key.startsWith("demo:mines:")) {
              failBoardSave = false;
              return Promise.reject(new Error("injected save failure"));
            }
            return (target as any).set(key, ...rest);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Redis;
    const config = {
      DEMO_START_CHIPS: 1000,
      DEMO_SESSION_TTL: 3600,
      DEMO_SESSIONS_PER_IP_PER_DAY: 100,
    } as any;
    const demo = new DemoService(flaky, config),
      chips = new ChipsService(flaky, config),
      mines = new MinesService(flaky, config, chips, demo);
    const { id } = await demo.create("192.0.2.1");
    const safe = async () => {
      const board = JSON.parse((await redis.get(`demo:mines:${id}`))!);
      return Array.from({ length: 25 }, (_, i) => i).find(
        (i) => !board.record.result.includes(i) && !board.picks.includes(i),
      )!;
    };
    await mines.start(id, 100, 3);
    await mines.pick(id, await safe());
    failBoardSave = true;
    await assert.rejects(() => mines.cashout(id), /injected save failure/);
    const paid = chipPayout(100, minesMultiplier(3, 1));
    assert.equal(await chips.balance(id), 900 + paid);
    const another = await safe();
    await assert.rejects(() => mines.pick(id, another), /already cashed out/);
    const retry = await mines.cashout(id);
    assert.equal(retry.payout, paid);
    assert.equal(await chips.balance(id), 900 + paid);
    const { commitment, clientSeed, nonce } = retry.record;
    assert.deepEqual(
      JSON.parse(
        (await redis.get(
          `demo:credited:${id}:mines:${commitment}:${clientSeed}:${nonce}`,
        ))!,
      ),
      { picks: retry.picks, payout: paid },
    );

    // An abandoned board now expires with the session instead of on its own.
    await mines.start(id, 100, 5);
    await redis.expire(`demo:mines:${id}`, 5);
    await demo.view(id);
    const [session, board] = (await redis
      .multi()
      .pttl(`demo:session:${id}`)
      .pttl(`demo:mines:${id}`)
      .exec())!.map(([, value]) => value as number);
    assert.ok(session! > 5000);
    assert.equal(board, session);
    await assert.rejects(() => demo.rotate(id), /finish the active Mines/);
    assert.equal((await demo.history(id)).length, 1);
    const ended = await mines.forfeit(id);
    assert.equal(ended.outcome, "forfeit");
    assert.equal(ended.payout, 0);
    assert.equal(await chips.balance(id), 800 + paid);
    await demo.rotate(id);
    const history = await demo.history(id);
    assert.equal(history.length, 2);
    for (const record of history)
      assert.equal((await verifyRecord(record)).ok, true);
  },
);
