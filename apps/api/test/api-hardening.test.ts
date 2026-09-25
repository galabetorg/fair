import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { commit, play } from "@galabet/fair";
import { VerifyController } from "../src/verify/verify.controller";
import { DemoController } from "../src/demo/demo.controller";
import { DemoService } from "../src/demo/demo.service";
import { HealthController } from "../src/health/health.controller";
import { HttpExceptionFilter } from "../src/common/http-exception.filter";
import { REDIS } from "../src/redis/redis.module";
import { DB } from "../src/db/db.module";
import { publicCrashMessage } from "../src/crash/crash.gateway";
import { CrashService } from "../src/crash/crash.service";
import { CrashEngine } from "../src/crash/crash.engine";
import { CrashController } from "../src/crash/crash.controller";
import { CrashBets } from "../src/crash/crash.bets";

let postgresUp = true,
  redisUp = true,
  hung = false;
@Module({
  controllers: [
    VerifyController,
    DemoController,
    HealthController,
    CrashController,
  ],
  providers: [
    {
      provide: DemoService,
      useValue: {
        setClientSeed: async () => ({ ok: true }),
        history: async () => [],
      },
    },
    { provide: CrashService, useValue: { history: async () => [] } },
    { provide: CrashBets, useValue: {} },
    {
      provide: REDIS,
      useValue: {
        ping: async () => {
          if (hung) return new Promise(() => {});
          if (!redisUp) throw Error("private Redis details");
          return "PONG";
        },
      },
    },
    {
      provide: DB,
      useValue: {
        execute: async () => {
          if (!postgresUp) throw Error("private database details");
          return [];
        },
      },
    },
  ],
})
class HardeningTestModule {}
const serverSeed =
  "5c1f7d3e8a2b4c6d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d";

test("HTTP validation returns 400 for malformed inputs; valid verification still matches", async () => {
  const app = await NestFactory.create<NestFastifyApplication>(
    HardeningTestModule,
    new FastifyAdapter(),
    { logger: false },
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  try {
    const inputs = {
      game: "dice" as const,
      serverSeed,
      clientSeed: "galabet",
      nonce: 42,
    };
    const output = await play(inputs),
      { commitment } = await commit(serverSeed);
    const record = {
      ...inputs,
      spec: "GFS/1.0",
      profile: "single-player",
      params: {},
      commitment,
      cursor: output.cursor,
      result: output.result,
      at: 0,
    };
    for (const [url, payload] of [
      ["/api/verify", { ...inputs, clientSeed: "bad:seed" }],
      ["/api/verify", { ...inputs, params: { rows: 1000000 } }],
      ["/api/verify/record", { ...record, clientSeed: "bad:seed" }],
      ["/api/verify/record", { ...record, nonce: Number.MAX_SAFE_INTEGER + 1 }],
      ["/api/verify/record", { ...record, result: undefined }],
      [
        "/api/verify/record",
        { ...record, serverSeed: undefined, result: undefined },
      ],
      ["/api/demo/client-seed", { clientSeed: "bad:seed" }],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url,
        payload,
        headers: { "x-demo-session": "11111111-1111-4111-8111-111111111111" },
      });
      assert.equal(response.statusCode, 400, url + ": " + response.body);
    }
    const result = await app.inject({
      method: "POST",
      url: "/api/verify/record",
      payload: record,
    });
    assert.equal(result.statusCode, 201);
    assert.equal(result.json().ok, true);
    for (const route of ["/api/crash/history", "/api/demo/history"]) {
      for (const limit of ["1.5", "invalid", "Infinity", "201"]) {
        const invalid = await app.inject({
          method: "GET",
          url: route + "?limit=" + limit,
          headers: { "x-demo-session": "11111111-1111-4111-8111-111111111111" },
        });
        assert.equal(invalid.statusCode, 400);
      }
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: route,
            headers: {
              "x-demo-session": "11111111-1111-4111-8111-111111111111",
            },
          })
        ).statusCode,
        200,
      );
    }
    for (const dependency of ["postgres", "redis"]) {
      postgresUp = dependency !== "postgres";
      redisUp = dependency !== "redis";
      const unhealthy = await app.inject({ method: "GET", url: "/api/health" });
      assert.equal(unhealthy.statusCode, 503);
      assert.equal(unhealthy.json().ok, false);
      assert.equal(unhealthy.body.includes("private"), false);
    }
    postgresUp = redisUp = true;
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/health" })).statusCode,
      200,
    );
    hung = true;
    const timeout = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(timeout.statusCode, 503);
  } finally {
    hung = false;
    postgresUp = redisUp = true;
    await app.close();
  }
});

test("WebSocket messages strip session credentials from legacy and new settlement payloads", () => {
  const raw = {
    type: "crash",
    chainId: "chain",
    index: 1,
    result: 2,
    gameHash: "public-hash",
    salt: "public-salt",
    sid: "private-session",
    settled: [{ sid: "private-session", payout: 200, at: 2 }],
  };
  const sanitized = publicCrashMessage(JSON.stringify(raw))!;
  assert.equal(sanitized.includes("private-session"), false);
  assert.deepEqual(JSON.parse(sanitized).settled, {
    bets: 1,
    paid: 1,
    totalPayout: 200,
  });
  raw.type = "tick";
  const tick = publicCrashMessage(JSON.stringify(raw))!;
  assert.equal(tick.includes("gameHash"), false);
  assert.equal(tick.includes("settled"), false);
  assert.equal(publicCrashMessage("{broken"), null);
});

test("Crash preparation keeps its hash out of history storage and only completed rounds can be persisted", async () => {
  let inserts = 0;
  let state: Record<string, string> = {
    phase: "running",
    chainId: "chain",
    index: "1",
  };
  let pending: string | null = null;
  const redis = {
    get: async (key: string) => (key === "crash:pending" ? pending : "0"),
    lindex: async () => serverSeed,
    eval: async (...args: any[]) => {
      pending = args.at(-1);
      return 1;
    },
    hgetall: async () => state,
  };
  const db = {
    // Game 1 is checked against the chain's terminating hash before it is prepared.
    query: {
      crashChains: {
        findFirst: async () => ({
          terminatingHash: createHash("sha256").update(serverSeed).digest("hex"),
          length: 10,
        }),
      },
    },
    insert: () => {
      inserts++;
      return { values: () => ({ onConflictDoNothing: async () => {} }) };
    },
  };
  const service = new CrashService(db as any, redis as any, {} as any);
  const game = await service.nextGame("chain", "public salt");
  assert.equal(inserts, 0);
  assert.deepEqual(await service.pendingGame(), game);
  await assert.rejects(() => service.completeGame(game), /unfinished/);
  assert.equal(inserts, 0);
  state.phase = "crashed";
  await service.completeGame(game);
  assert.equal(inserts, 1);
});

test("Crash engine closes the round before reveal and publishes no final tick at the endpoint", async () => {
  const messages: any[] = [],
    order: string[] = [];
  const game = {
    chainId: "chain",
    index: 1,
    gameHash: serverSeed,
    result: 1,
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
    releaseChain: async () => false,
  };
  const bets = {
    prepare: async () => {},
    advance: async () => {
      order.push("closed");
      return { phase: "crashed", multiplier: 1, elapsed: 0 };
    },
    settle: async () => {
      order.push("settle");
      return { bets: 0, paid: 0, totalPayout: 0 };
    },
    retire: async () => {},
  };
  const engine = new CrashEngine(
    {
      publish: async (_: string, msg: string) => {
        messages.push(JSON.parse(msg));
      },
    } as any,
    service as any,
    bets as any,
  );
  await (engine as any).round();
  assert.deepEqual(order, ["closed", "settle", "reveal", "finish"]);
  assert.deepEqual(
    messages.map((m) => m.type),
    ["crash"],
  );
  assert.equal(JSON.stringify(messages).includes('"sid"'), false);
});
