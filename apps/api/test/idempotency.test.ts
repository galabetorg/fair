import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { HttpException } from "@nestjs/common";
import { firstValueFrom, of, defer } from "rxjs";
import { IdempotencyInterceptor } from "../src/common/idempotency.interceptor";
const options = {
  skip: !process.env.REDIS_TEST_URL
    ? "Set REDIS_TEST_URL for real idempotency tests."
    : false,
};
async function setup(t: any) {
  const prefix = `idem-test:${randomUUID()}:`;
  const redis = new Redis(process.env.REDIS_TEST_URL!, { keyPrefix: prefix });
  t.after(async () => {
    const keys = await redis.keys(prefix + "*");
    for (const key of keys) await redis.del(key.slice(prefix.length));
    await redis.quit();
  });
  const interceptor = new IdempotencyInterceptor(redis);
  const key = randomUUID(),
    sid = randomUUID();
  const invoke = (
    body: any,
    handler: any,
    override: Record<string, string> = {},
    instance = interceptor,
  ) => {
    const req = {
      method: "POST",
      headers: { "idempotency-key": key, "x-demo-session": sid, ...override },
      routeOptions: { url: "/test" },
      body,
      ip: "127.0.0.1",
    };
    const reply: any = {
      statusCode: 201,
      header() {
        return this;
      },
      status(n: number) {
        this.statusCode = n;
        return this;
      },
    };
    const ctx: any = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => reply }),
    };
    return firstValueFrom(instance.intercept(ctx, { handle: handler }));
  };
  return { redis, invoke, key, sid, prefix };
}
test(
  "idempotency waits for stored response; a new interceptor replays without the handler",
  options,
  async (t) => {
    const f = await setup(t);
    let runs = 0;
    const handler = () => {
      runs++;
      return of({ balance: 975 });
    };
    assert.deepEqual(await f.invoke({ amount: 25 }, handler), { balance: 975 });
    assert.deepEqual(
      await f.invoke(
        { amount: 25 },
        handler,
        {},
        new IdempotencyInterceptor(f.redis),
      ),
      { balance: 975 },
    );
    assert.equal(runs, 1);
    await assert.rejects(
      f.invoke({ amount: 26 }, handler),
      (e: any) => e.getStatus() === 422,
    );
  },
);
test("concurrent retry cannot enter the handler", options, async (t) => {
  const f = await setup(t);
  let release!: () => void, entered!: () => void;
  const start = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  let runs = 0;
  const handler = () =>
    defer(async () => {
      runs++;
      entered();
      await gate;
      return { ok: true };
    });
  const first = f.invoke({}, handler);
  await start;
  await assert.rejects(
    f.invoke({}, handler),
    (e: any) => e.getStatus() === 409,
  );
  release();
  await first;
  assert.equal(runs, 1);
});
test(
  "uncertain handler failure remains blocked instead of executing a second debit",
  options,
  async (t) => {
    const f = await setup(t);
    let runs = 0;
    const handler = () =>
      defer(async () => {
        runs++;
        throw new Error("response lost after side effect");
      });
    await assert.rejects(f.invoke({}, handler), /response lost/);
    await assert.rejects(
      f.invoke({}, handler),
      (e: any) => e.getStatus() === 409,
    );
    assert.equal(runs, 1);
    const keys = await f.redis.keys(f.prefix + "*");
    assert.equal(keys.length, 1);
    assert.ok((await f.redis.ttl(keys[0]!.slice(f.prefix.length))) > 86000);
  },
);
test(
  "definite refusal is replayed and does not run later under the same key",
  options,
  async (t) => {
    const f = await setup(t);
    let runs = 0;
    const handler = () =>
      defer(() => {
        runs++;
        throw new HttpException("round closed", 409);
      });
    await assert.rejects(
      f.invoke({}, handler),
      (e: any) => e.getStatus() === 409,
    );
    await assert.rejects(
      f.invoke({}, handler),
      (e: any) => e.getStatus() === 409,
    );
    assert.equal(runs, 1);
  },
);
test(
  "response cache failure is awaited and preserves pending ownership",
  options,
  async (t) => {
    const f = await setup(t);
    let runs = 0;
    const broken = Object.create(f.redis);
    broken.eval = async () => {
      throw new Error("cache write failed");
    };
    const handler = () => {
      runs++;
      return of({ paid: 25 });
    };
    await assert.rejects(
      f.invoke({}, handler, {}, new IdempotencyInterceptor(broken)),
      /cache write failed/,
    );
    await assert.rejects(
      f.invoke({}, handler),
      (e: any) => e.getStatus() === 409,
    );
    assert.equal(runs, 1);
  },
);
