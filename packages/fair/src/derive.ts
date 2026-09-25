import { hmacSha256 } from './crypto.js';
import { assertClientSeed, assertServerSeed } from './seeds.js';
import type { SeedPair } from './types.js';

export const BYTES_PER_DIGEST = 32;
export const FLOATS_PER_DIGEST = 8;

/**
 * One HMAC digest for a seed pair, nonce and cursor. GFS 4.1.
 *   key     = serverSeed (as the hex string)
 *   message = `${clientSeed}:${nonce}:${cursor}`
 */
export async function deriveDigest(seeds: SeedPair, cursor = 0): Promise<Uint8Array> {
  assertServerSeed(seeds.serverSeed);
  assertClientSeed(seeds.clientSeed);
  if (!Number.isInteger(seeds.nonce) || seeds.nonce < 0) throw new Error('nonce must be a non-negative integer');
  if (!Number.isInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative integer');
  return hmacSha256(seeds.serverSeed, `${seeds.clientSeed}:${seeds.nonce}:${cursor}`);
}

/**
 * Four bytes to a float in [0, 1). GFS 4.2.
 *   f = b0/256 + b1/256^2 + b2/256^3 + b3/256^4
 * No modulo anywhere in the spec.
 */
export function bytesToFloat(b0: number, b1: number, b2: number, b3: number): number {
  return b0 / 256 + b1 / 65536 + b2 / 16777216 + b3 / 4294967296;
}

/** All eight floats in one 32-byte digest, in order. */
export function digestToFloats(digest: Uint8Array): number[] {
  if (digest.length !== BYTES_PER_DIGEST) throw new Error('digest must be 32 bytes');
  const out: number[] = [];
  for (let i = 0; i < BYTES_PER_DIGEST; i += 4) {
    out.push(bytesToFloat(digest[i]!, digest[i + 1]!, digest[i + 2]!, digest[i + 3]!));
  }
  return out;
}

export interface FloatStream {
  floats: number[];
  /** Highest cursor consumed. Goes into the record. */
  cursor: number;
}

/**
 * The first `count` floats for a bet. Cursor 0 covers floats 0..7, cursor 1 covers 8..15, and so on.
 * Games that need more than 8 floats (card shuffles, keno, mines) advance the cursor automatically.
 */
export async function deriveFloats(seeds: SeedPair, count: number): Promise<FloatStream> {
  if (!Number.isInteger(count) || count < 1) throw new Error('count must be a positive integer');
  const floats: number[] = [];
  let cursor = 0;
  while (floats.length < count) {
    const digest = await deriveDigest(seeds, cursor);
    floats.push(...digestToFloats(digest));
    if (floats.length < count) cursor++;
  }
  return { floats: floats.slice(0, count), cursor };
}
