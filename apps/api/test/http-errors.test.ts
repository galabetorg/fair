import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Body, Controller, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { HttpExceptionFilter } from "../src/common/http-exception.filter";

@Controller()
class EchoController {
  @Post("/echo")
  echo(@Body() body: unknown) {
    return body;
  }

  @Post("/boom")
  boom() {
    throw new Error("database password is hunter2");
  }
}

@Module({ controllers: [EchoController] })
class EchoModule {}

test("requests Fastify rejects keep their 4xx status; other errors stay a bare 500", async () => {
  const app = await NestFactory.create<NestFastifyApplication>(
    EchoModule,
    new FastifyAdapter({ bodyLimit: 1024 }),
    { logger: false },
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  try {
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const big = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ pad: "x".repeat(4096) }),
    });
    assert.equal(big.statusCode, 413);
    assert.equal(big.json().statusCode, 413);

    const broken = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      payload: '{"a":',
    });
    assert.equal(broken.statusCode, 400);

    const ok = await app.inject({ method: "POST", url: "/echo", payload: { a: 1 } });
    assert.equal(ok.statusCode, 201);

    const boom = await app.inject({ method: "POST", url: "/boom" });
    assert.equal(boom.statusCode, 500);
    assert.equal(boom.json().message, "unexpected error");
    assert.ok(!boom.body.includes("hunter2"));
  } finally {
    await app.close();
  }
});
