import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyRecord } from "@galabet/fair";
import { DemoService } from "../src/demo/demo.service";
import { MinesService } from "../src/demo/mines.service";
import { ChipsService } from "../src/demo/chips.service";
import { GamesController } from "../src/demo/games.controller";
import { chipPayout, minesMultiplier } from "../src/demo/rules";

// In-memory Redis command double. Validates service sequencing and retry behavior,
// not Redis connectivity or Lua parsing; the Lua operation is modeled explicitly.
class RedisDouble {
  data = new Map<string, string>();
  hashes = new Map<string, Record<string, string>>();
  lists = new Map<string, string[]>();
  failNextBoardSave = false;
  async get(k: string) {
    return this.data.get(k) ?? null;
  }
  async set(k: string, v: unknown, ...args: any[]) {
    if (this.failNextBoardSave && k.startsWith("demo:mines:")) {
      this.failNextBoardSave = false;
      throw new Error("injected save failure");
    }
    if (args.includes("NX") && this.data.has(k)) return null;
    this.data.set(k, String(v));
    return "OK";
  }
  async del(k: string) {
    return Number(this.data.delete(k));
  }
  async hgetall(k: string) {
    return this.hashes.get(k) ?? {};
  }
  async lrange(k: string, a: number, b: number) {
    return (this.lists.get(k) ?? []).slice(a, b + 1);
  }
  multi() {
    const queued: (() => unknown)[] = [];
    const tx = {
      incr: (k: string) => {
        queued.push(() => {
          const n = Number(this.data.get(k) ?? 0) + 1;
          this.data.set(k, String(n));
          return n;
        });
        return tx;
      },
      incrby: (k: string, amount: number) => {
        queued.push(() => {
          const n = Number(this.data.get(k) ?? 0) + amount;
          this.data.set(k, String(n));
          return n;
        });
        return tx;
      },
      expire: (..._: any[]) => {
        queued.push(() => 1);
        return tx;
      },
      hset: (k: string, field: string, value: string) => {
        queued.push(() => {
          this.hashes.set(k, { ...this.hashes.get(k), [field]: value });
          return 1;
        });
        return tx;
      },
      lpush: (k: string, v: string) => {
        queued.push(() => {
          const a = this.lists.get(k) ?? [];
          a.unshift(v);
          this.lists.set(k, a);
          return a.length;
        });
        return tx;
      },
      ltrim: (k: string, a: number, b: number) => {
        queued.push(() => {
          this.lists.set(k, (this.lists.get(k) ?? []).slice(a, b + 1));
          return "OK";
        });
        return tx;
      },
      exec: async () => queued.map((fn) => [null, fn()]),
    };
    return tx;
  }
  async eval(script: string, count: number, ...args: any[]) {
    const keys = args.slice(0, count).map(String),
      argv = args.slice(count);
    // Seed store scripts: session, nonce, revealed, records, then linked keys. Expiry is not modeled.
    if (keys[0]!.startsWith("demo:session:")) {
      const [sessionKey, nonceKey, revealedKey, recordsKey] = keys as [
        string,
        string,
        string,
        string,
      ];
      if (script.includes("local session")) {
        if (!this.data.has(sessionKey)) return null;
        return this.data.has(nonceKey) ? this.data.get(sessionKey) : "";
      }
      if (script.includes("local old")) {
        const [payload, , expected] = argv,
          old = this.data.get(sessionKey),
          next = JSON.parse(payload);
        if (old ? JSON.parse(old).commitment !== expected : expected !== "")
          return 0;
        if (old && JSON.parse(old).commitment === next.commitment) {
          if (!this.data.has(nonceKey)) return 0;
        } else this.data.set(nonceKey, "0");
        this.data.set(sessionKey, payload);
        return 1;
      }
      if (script.includes("'HSET'")) {
        const [commitment, serverSeed] = argv;
        this.hashes.set(revealedKey, {
          ...this.hashes.get(revealedKey),
          [commitment]: serverSeed,
        });
        return null;
      }
      if (script.includes("'LPUSH'")) {
        const [record, keep] = argv;
        const list = [record, ...(this.lists.get(recordsKey) ?? [])];
        this.lists.set(recordsKey, list.slice(0, Number(keep)));
        return null;
      }
      if (!this.data.has(sessionKey) || !this.data.has(nonceKey)) return -1;
      if (JSON.parse(this.data.get(sessionKey)!).commitment !== argv[1])
        return -1;
      const n = Number(this.data.get(nonceKey));
      this.data.set(nonceKey, String(n + 1));
      return n;
    }
    if (script.includes("return redis.call('DEL'")) {
      if (this.data.get(args[0]) === args[1]) return this.del(args[0]);
      return 0;
    }
    if (keys[1]?.startsWith("demo:credited:")) {
      const [balanceKey, creditKey] = keys as [string, string],
        [amount, initial, , marker] = argv;
      let balance = Number(this.data.get(balanceKey) ?? initial);
      const prior = this.data.get(creditKey);
      this.data.set(balanceKey, String(balance));
      if (prior !== undefined) return [balance, prior, 0];
      balance += Number(amount);
      this.data.set(balanceKey, String(balance));
      this.data.set(creditKey, marker);
      return [balance, marker, 1];
    }
    const [key, amount, initial] = args;
    const balance = Number(this.data.get(key) ?? initial);
    if (balance < amount) return -1;
    this.data.set(key, String(balance - amount));
    return balance - amount;
  }
}
async function setup() {
  const redis = new RedisDouble(),
    config = {
      DEMO_START_CHIPS: 10000,
      DEMO_SESSION_TTL: 3600,
      DEMO_SESSIONS_PER_IP_PER_DAY: 100,
    } as any;
  const demo = new DemoService(redis as any, config),
    chips = new ChipsService(redis as any, config);
  const mines = new MinesService(redis as any, config, chips, demo);
  const session = await demo.create("127.0.0.1");
  return { redis, demo, chips, mines, id: session.id };
}
async function safeTile(redis: RedisDouble, id: string) {
  const board = JSON.parse((await redis.get(`demo:mines:${id}`))!);
  return Array.from({ length: 25 }, (_, i) => i).find(
    (i) => !board.record.result.includes(i) && !board.picks.includes(i),
  )!;
}

test("Active Mines hides positions from responses/history and blocks seed reveals and changes", async () => {
  const { redis, demo, mines, id } = await setup();
  const started = await mines.start(id, 100, 3);
  assert.equal(started.record.result, undefined);
  assert.deepEqual(await demo.history(id), []);
  await assert.rejects(() => demo.rotate(id), /finish the active Mines/);
  await assert.rejects(
    () => demo.setClientSeed(id, "new-client"),
    /finish the active Mines/,
  );
  // A legacy record already in history is also redacted.
  const stored = JSON.parse((await redis.get(`demo:mines:${id}`))!);
  await demo.publishRecord(id, stored.record);
  assert.equal((await demo.history(id))[0]!.result, undefined);
  await mines.pick(id, await safeTile(redis, id));
  const finished = await mines.cashout(id);
  assert.equal(finished.next, null);
  assert.ok(Array.isArray(finished.record.result));
  await demo.rotate(id);
  const history = await demo.history(id);
  assert.equal(history.length, 1);
  assert.equal((await verifyRecord(history[0]!)).ok, true);
});

test("Concurrent cash-outs credit only once and repeat requests cannot settle a finished board", async () => {
  const { redis, demo, chips, mines, id } = await setup();
  await mines.start(id, 100, 3);
  await mines.pick(id, await safeTile(redis, id));
  const outcomes = await Promise.allSettled([
    mines.cashout(id),
    mines.cashout(id),
  ]);
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  const paid = outcomes.find(
    (o) => o.status === "fulfilled",
  ) as PromiseFulfilledResult<any>;
  assert.equal(await chips.balance(id), 9900 + paid.value.payout);
  await assert.rejects(() => mines.cashout(id), /game is over/);
  assert.equal((await demo.history(id)).length, 1);
});

test("A failed state write after credit can be retried without a second credit", async () => {
  const { redis, chips, mines, id } = await setup();
  await mines.start(id, 100, 3);
  await mines.pick(id, await safeTile(redis, id));
  redis.failNextBoardSave = true;
  await assert.rejects(() => mines.cashout(id), /injected save failure/);
  const credited = await chips.balance(id);
  const retry = await mines.cashout(id);
  assert.equal(await chips.balance(id), credited);
  assert.equal(retry.over, true);
});

test("After a paid cash-out loses its board write, more picks are refused and the retry reports the credited payout", async () => {
  const { redis, demo, chips, mines, id } = await setup();
  await mines.start(id, 100, 3);
  await mines.pick(id, await safeTile(redis, id));
  redis.failNextBoardSave = true;
  await assert.rejects(() => mines.cashout(id), /injected save failure/);
  const paid = chipPayout(100, minesMultiplier(3, 1));
  assert.equal(await chips.balance(id), 9900 + paid);
  // The board is still live in storage, so its published record stays redacted.
  assert.equal((await mines.current(id)).over, false);
  assert.equal((await demo.history(id))[0]!.result, undefined);
  // Before the fix this pick succeeded and the next cash-out reported a two-pick payout.
  const another = await safeTile(redis, id);
  await assert.rejects(() => mines.pick(id, another), /already cashed out/);
  await assert.rejects(() => mines.forfeit(id), /already cashed out/);
  const retry = await mines.cashout(id);
  assert.equal(retry.payout, paid);
  assert.equal(retry.picks.length, 1);
  assert.equal(retry.outcome, "cashout");
  assert.equal(await chips.balance(id), 9900 + paid);
  assert.equal((await mines.current(id)).payout, paid);
  const history = await demo.history(id);
  assert.equal(history.length, 1);
  assert.deepEqual(history[0]!.result, retry.record.result);
});

test("A failed write on the final safe pick is closed by cash-out with the credited board", async () => {
  const { redis, chips, mines, id } = await setup();
  await mines.start(id, 100, 24);
  const tile = await safeTile(redis, id);
  redis.failNextBoardSave = true;
  await assert.rejects(() => mines.pick(id, tile), /injected save failure/);
  const paid = chipPayout(100, minesMultiplier(24, 1));
  assert.equal(paid, 2475);
  assert.equal(await chips.balance(id), 9900 + paid);
  await assert.rejects(() => mines.pick(id, tile), /already cashed out/);
  // The saved board has no picks; the credit marker supplies them instead of "pick at least one".
  const closed = await mines.cashout(id);
  assert.deepEqual(closed.picks, [tile]);
  assert.equal(closed.payout, paid);
  assert.equal(closed.multiplier, minesMultiplier(24, 1));
  assert.equal(await chips.balance(id), 9900 + paid);
});

test("Forfeit ends an abandoned board as lost, publishes its record and frees rotation", async () => {
  const { redis, demo, chips, mines, id } = await setup();
  const controller = new GamesController(demo, chips, mines, {
    demoBets: { inc() {} },
  } as any);
  await assert.rejects(() => controller.minesForfeit(id), /no mines game/);
  await mines.start(id, 100, 3);
  await mines.pick(id, await safeTile(redis, id));
  await assert.rejects(() => demo.rotate(id), /finish the active Mines/);
  const ended = await controller.minesForfeit(id);
  assert.equal(ended.over, true);
  assert.equal(ended.outcome, "forfeit");
  assert.equal(ended.boom, false);
  assert.equal(ended.payout, 0);
  assert.equal((ended.record.result as number[]).length, 3);
  assert.equal(await chips.balance(id), 9900);
  await assert.rejects(() => mines.forfeit(id), /game is over/);
  await assert.rejects(() => mines.pick(id, 0), /game is over/);
  await assert.rejects(() => mines.cashout(id), /game is over/);
  assert.equal((await mines.current(id)).outcome, "forfeit");
  const history = await demo.history(id);
  assert.equal(history.length, 1);
  assert.deepEqual(history[0]!.result, ended.record.result);
  await demo.rotate(id);
  assert.equal((await verifyRecord((await demo.history(id))[0]!)).ok, true);
  const next = await mines.start(id, 100, 3);
  assert.equal(next.record.result, undefined);
  assert.equal(await chips.balance(id), 9800);
});

test("The final safe pick auto-settles with no infinite next multiplier", async () => {
  const { redis, mines, id } = await setup();
  await mines.start(id, 100, 24);
  const ended = await mines.pick(id, await safeTile(redis, id));
  assert.equal(ended.over, true);
  assert.equal(ended.next, null);
});

test("Selecting a previous client seed cannot repeat an old server/client/nonce combination", async () => {
  const { demo, id } = await setup();
  const first = await demo.setClientSeed(id, "client-a");
  await demo.bet(id, "dice", {});
  const same = await demo.setClientSeed(id, "client-a");
  assert.equal(same.nonce, 1);
  assert.equal(same.commitment, first.commitment);
  await demo.setClientSeed(id, "client-b");
  const again = await demo.setClientSeed(id, "client-a");
  assert.notEqual(again.commitment, first.commitment);
  assert.equal(again.nonce, 0);
  assert.equal((await verifyRecord((await demo.history(id))[0]!)).ok, true);
});

test("A conflicting session action rejects before debiting a one-shot game", async () => {
  const { demo, chips, mines, id } = await setup();
  const controller = new GamesController(demo, chips, mines, {
    demoBets: { inc() {} },
  } as any);
  await demo.withSession(id, async () => {
    await assert.rejects(
      () => controller.dice(id, { amount: 100, target: 50, over: true }),
      /another action/,
    );
  });
  assert.equal(await chips.balance(id), 10000);
  const completed = await controller.dice(id, {
    amount: 100,
    target: 50,
    over: true,
  });
  assert.equal(completed.settlement.stake, 100);
  assert.deepEqual(completed.settlement.selection, { target: 50, over: true });
  assert.equal(completed.settlement.returned, completed.payout);
  assert.equal(completed.settlement.net, completed.chips - 10000);
});

test("A missing nonce is rejected before a one-shot game can debit chips", async () => {
  const { redis, demo, chips, mines, id } = await setup();
  await redis.del(`demo:nonce:${id}`);
  const controller = new GamesController(demo, chips, mines, {
    demoBets: { inc() {} },
  } as any);
  await assert.rejects(
    () => controller.dice(id, { amount: 100, target: 50, over: true }),
    /nonce missing/,
  );
  assert.equal(await chips.balance(id), 10000);
});
