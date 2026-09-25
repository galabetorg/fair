import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { GamesController } from "../src/demo/games.controller";
import { OpenApiController } from "../src/openapi/openapi.controller";
import { DemoService } from "../src/demo/demo.service";
import { ChipsService } from "../src/demo/chips.service";
import { MinesService } from "../src/demo/mines.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { REDIS } from "../src/redis/redis.module";

@Module({
  controllers: [GamesController, OpenApiController],
  providers: [DemoService, ChipsService, MinesService, MetricsService]
    .map((provide) => ({ provide, useValue: {} }))
    .concat([{ provide: REDIS as any, useValue: {} }]),
})
class ReadOnlyAnalysisTestModule {}

test("HTTP analysis routes and generated OpenAPI agree; malformed card inputs are rejected", async () => {
  const app = await NestFactory.create<NestFastifyApplication>(
    ReadOnlyAnalysisTestModule,
    new FastifyAdapter(),
    { logger: false },
  );
  try {
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const rules = await app.inject({
      method: "GET",
      url: "/api/demo/games/rules",
    });
    assert.equal(rules.statusCode, 200);
    assert.equal(rules.json().wheel.values.length, 10);
    const trace = await app.inject({
      method: "POST",
      url: "/api/demo/games/analyze/blackjack",
      payload: { hand: ["AC", "6D"], following: ["4H", "KS"], hitSoft17: true },
    });
    assert.equal(trace.statusCode, 200);
    assert.equal(trace.json().total, 21);
    assert.equal(trace.json().used, 1);
    for (const payload of [
      { hand: ["AC", "AC"] },
      { hand: ["XX", "6D"] },
      { hand: ["AC", "6D"], following: ["AC"] },
    ]) {
      const invalid = await app.inject({
        method: "POST",
        url: "/api/demo/games/analyze/blackjack",
        payload,
      });
      assert.equal(invalid.statusCode, 400);
    }
    const spec = await app.inject({ method: "GET", url: "/api/openapi.json" });
    assert.equal(spec.statusCode, 200);
    assert.ok(
      spec.json().paths["/api/demo/games/analyze/blackjack"].post.requestBody,
    );
    assert.ok(spec.json().paths["/api/demo/games/rules"].get);
  } finally {
    await app.close();
  }
});

test("POST /api/demo/games/mines/forfeit reaches the Mines service with the session id", async () => {
  const calls: string[] = [];
  @Module({
    controllers: [GamesController],
    providers: [DemoService, ChipsService, MetricsService]
      .map((provide) => ({ provide, useValue: {} as any }))
      .concat([
        {
          provide: MinesService,
          useValue: {
            forfeit: async (sid: string) => {
              calls.push(sid);
              return { over: true, outcome: "forfeit", payout: 0 };
            },
          },
        },
        { provide: REDIS as any, useValue: {} },
      ]),
  })
  class ForfeitRouteTestModule {}
  const app = await NestFactory.create<NestFastifyApplication>(
    ForfeitRouteTestModule,
    new FastifyAdapter(),
    { logger: false },
  );
  try {
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const sid = randomUUID();
    const ended = await app.inject({
      method: "POST",
      url: "/api/demo/games/mines/forfeit",
      headers: { "x-demo-session": sid },
    });
    assert.equal(ended.statusCode, 201);
    assert.equal(ended.json().outcome, "forfeit");
    assert.deepEqual(calls, [sid]);
    const anonymous = await app.inject({
      method: "POST",
      url: "/api/demo/games/mines/forfeit",
    });
    assert.equal(anonymous.statusCode, 400);
    assert.deepEqual(calls, [sid]);
  } finally {
    await app.close();
  }
});
