import { Controller, Get, Res } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import type { FastifyReply } from "fastify";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { recordBody, verifyBody } from "../verify/verify.dto";
import { blackjackAnalysisBody } from "../demo/games.controller";

extendZodWithOpenApi(z);

/**
 * OpenAPI 3.1 generated from the same zod schemas that validate requests, so the docs cannot drift.
 * The site renders this at /docs/api with Scalar; operators generate clients from it.
 */
function build() {
  const r = new OpenAPIRegistry();
  r.registerPath({
    method: "get",
    path: "/api/health",
    tags: ["health"],
    summary: "Check Postgres and Redis availability",
    responses: {
      200: { description: "Both dependencies responded" },
      503: {
        description:
          "A dependency failed or exceeded the two-second check deadline",
      },
    },
  });
  r.registerPath({
    method: "post",
    path: "/api/verify/inspect",
    tags: ["verify"],
    summary: "Inspect a seed, Crash or Flight record with per-check results",
    description:
      "Uses the shared bounded inspector. Maximum 64 KB; supported calculation version GFS/1.0. Endpoint verification does not authenticate Flight settlement.",
    request: {
      body: {
        content: { "application/json": { schema: z.record(z.unknown()) } },
      },
    },
    responses: {
      200: {
        description:
          "{ kind, status, computed, claimed, checks, difference, recordHash?, note }; status is matches, mismatch or incomplete",
      },
      400: { description: "Malformed or unsupported record" },
    },
  });
  r.registerPath({
    method: "get",
    path: "/api/demo/games/rules",
    summary: "Versioned public demo rules and probability tables",
    tags: ["demo"],
    responses: {
      200: {
        description:
          "Configured rules, multipliers and table returns; no private session state",
      },
    },
  });
  r.registerPath({
    method: "post",
    path: "/api/demo/games/analyze/blackjack",
    summary: "Trace a dealer hand using explicit public cards",
    tags: ["demo"],
    request: {
      body: {
        content: { "application/json": { schema: blackjackAnalysisBody } },
      },
    },
    responses: {
      200: {
        description:
          "Rule version, dealer cards, draw steps, final total and whether the supplied sequence completed the hand",
      },
    },
  });
  const hex64 = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .openapi({
      example:
        "5c1f7d3e8a2b4c6d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d",
    });

  r.registerPath({
    method: "post",
    path: "/api/verify",
    summary: "Reproduce a result from seeds",
    tags: ["verify"],
    request: {
      body: { content: { "application/json": { schema: verifyBody } } },
    },
    responses: {
      200: {
        description:
          "Result, cursor, floats, commitment and the canonical record",
      },
    },
  });
  r.registerPath({
    method: "post",
    path: "/api/verify/record",
    summary: "Verify a full record, including signature when present",
    tags: ["verify"],
    request: {
      body: { content: { "application/json": { schema: recordBody } } },
    },
    responses: {
      200: {
        description:
          "{ ok, computed, claimed, commitmentOk, cursorOk, signatureOk, recordHash, reasons }",
      },
    },
  });
  r.registerPath({
    method: "get",
    path: "/api/vectors/{version}",
    summary: "Published test vectors",
    tags: ["spec"],
    request: {
      params: z.object({
        version: z.string().openapi({ example: "gfs-1.0.json" }),
      }),
    },
    responses: { 200: { description: "Vectors JSON" } },
  });
  r.registerPath({
    method: "get",
    path: "/badge/{operator}.svg",
    summary: "Live conformance badge",
    tags: ["registry"],
    request: { params: z.object({ operator: z.string() }) },
    responses: { 200: { description: "SVG" } },
  });
  r.registerPath({
    method: "get",
    path: "/api/registry.json",
    summary: "Registry snapshot",
    tags: ["registry"],
    responses: { 200: { description: "Entries" } },
  });
  r.registerPath({
    method: "get",
    path: "/api/registry/{id}",
    summary: "Operator detail",
    tags: ["registry"],
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Operator, entry, runs" } },
  });
  r.registerPath({
    method: "post",
    path: "/api/registry/submissions",
    summary: "Submit a conformance run",
    tags: ["registry"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              operatorId: z.string(),
              name: z.string(),
              domain: z.string(),
              contact: z.string().email(),
              publicKey: hex64.optional(),
              specVersion: z.literal("GFS/1.0"),
              profiles: z.array(z.enum(["single-player", "crash"])),
              extensions: z.array(z.enum(["beacon"])).optional(),
              verifyUrl: z.string().url().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description:
          "runId, verification token and the well-known file to publish",
      },
    },
  });
  r.registerPath({
    method: "post",
    path: "/api/notary/commitments",
    summary: "Escrow a commitment (operator-signed)",
    tags: ["notary"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ hash: hex64, at: z.number() }),
          },
        },
      },
    },
    responses: { 200: { description: "Signed receipt" } },
  });
  r.registerPath({
    method: "post",
    path: "/api/notary/reveals",
    summary: "Reveal an escrowed seed (operator-signed)",
    tags: ["notary"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              hash: hex64,
              serverSeed: hex64,
              at: z.number(),
            }),
          },
        },
      },
    },
    responses: { 200: { description: "valid" } },
  });
  r.registerPath({
    method: "get",
    path: "/api/notary/commitments/{hash}",
    summary: "Look up an escrowed commitment",
    tags: ["notary"],
    request: { params: z.object({ hash: hex64 }) },
    responses: { 200: { description: "Receipt and reveal state" } },
  });
  r.registerPath({
    method: "get",
    path: "/api/crash/history",
    summary: "Completed crash games with revealed hashes",
    tags: ["crash"],
    responses: { 200: { description: "Games" } },
  });
  r.registerPath({
    method: "get",
    path: "/api/crash/chain/{id}",
    summary: "Crash chain info",
    tags: ["crash"],
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: { 200: { description: "Chain" } },
  });
  r.registerPath({
    method: "post",
    path: "/api/demo/session",
    summary: "New demo seed session",
    tags: ["demo"],
    responses: { 200: { description: "commitment, clientSeed, nonce, id" } },
  });
  r.registerPath({
    method: "get",
    path: "/api/beacon/drand/{round}",
    summary: "Cached drand round",
    tags: ["beacon"],
    request: { params: z.object({ round: z.number().int() }) },
    responses: { 200: { description: "round, randomness, signature" } },
  });

  return new OpenApiGeneratorV31(r.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Galabet Fair API",
      version: "0.3.0",
      description:
        "Provably fair verification, registry, notary and demo endpoints. Spec: https://galabets.org/fair",
      license: { name: "MIT" },
    },
    servers: [{ url: "https://galabets.org" }],
  });
}

let cached: unknown;

@Controller()
export class OpenApiController {
  @Get("/api/openapi.json")
  @SkipThrottle()
  spec(@Res() reply: FastifyReply) {
    cached ??= build();
    reply.header("cache-control", "public, max-age=3600").send(cached);
  }
}
