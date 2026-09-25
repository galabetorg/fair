import { z } from "zod";

const hex64 = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex chars")
  .transform((s) => s.toLowerCase());
const gameName = z.enum([
  "dice",
  "limbo",
  "roulette",
  "wheel",
  "plinko",
  "mines",
  "keno",
  "blackjack",
  "hilo",
]);
export const clientSeed = z
  .string()
  .min(1)
  .max(64)
  .refine((s) => !s.includes(":"), 'client seed must not contain ":"');

export const gameParams = z
  .object({
    houseEdge: z.number().min(0).max(0.5).optional(),
    segments: z.number().int().min(2).max(100).optional(),
    rows: z.number().int().min(8).max(16).optional(),
    mines: z.number().int().min(1).max(24).optional(),
    draws: z.number().int().min(1).max(40).optional(),
    decks: z.number().int().min(1).max(8).optional(),
  })
  .strict();

/** POST /api/verify: reproduce a result from raw inputs. */
export const verifyBody = z
  .object({
    game: gameName,
    params: gameParams.optional(),
    serverSeed: hex64,
    clientSeed,
    nonce: z.number().int().min(0).max(1_000_000_000),
  })
  .strict();
export type VerifyBody = z.infer<typeof verifyBody>;

/** POST /api/verify/record: verify a full record. */
export const recordBody = z
  .object({
    spec: z.literal("GFS/1.0"),
    profile: z.literal("single-player"),
    game: gameName,
    params: gameParams,
    serverSeed: hex64.optional(),
    commitment: hex64,
    clientSeed,
    nonce: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    result: z.unknown(),
    at: z.number().int().min(0),
    beacon: z
      .object({
        source: z.enum(["drand", "evm"]),
        ref: z.string(),
        value: z.string(),
      })
      .optional(),
    signature: z
      .string()
      .regex(/^[0-9a-f]{128}$/)
      .optional(),
    signer: hex64.optional(),
  })
  .strict()
  .refine((record) => Object.prototype.hasOwnProperty.call(record, "result"), {
    path: ["result"],
    message: "result is required",
  });
export type RecordBody = z.infer<typeof recordBody>;
