/**
 * Multiplayer crash profile. GFS 5.10.
 * A chain of hashes is generated backwards from a secret; the terminating hash is published before
 * game 1; games are played from the end of the chain towards the secret, each revealing its hash.
 * The salt is a value neither party controlled at chain creation (a block hash or drand round),
 * published once known and fixed for the whole chain.
 *
 *   h_0 = secret (32 random bytes, hex)
 *   h_{i+1} = SHA-256(h_i as hex string)
 *   terminatingHash = h_N
 *   game k (1-based) uses gameHash = h_{N-k}
 *   check: SHA-256(gameHash_k) == gameHash_{k-1}, with gameHash_0 = terminatingHash
 *   digest = HMAC-SHA256(key = gameHash, message = salt)
 *   h = first 52 bits of digest as an integer
 *   result = max(1.00, floor((100 * 2^52 / (h + 1)) * (1 - houseEdge)) / 100)
 */
import { hmacSha256, randomBytes, sha256Hex, toHex, timingSafeEqualHex } from './crypto.js';
import type { Hex } from './types.js';

export interface CrashChain {
  /** h_0. Keep secret until the chain is exhausted. */
  secret: Hex;
  /** Published before game 1. */
  terminatingHash: Hex;
  length: number;
}

export async function createCrashChain(length: number): Promise<CrashChain> {
  if (!Number.isInteger(length) || length < 1 || length > 10_000_000) throw new Error('chain length must be 1 to 10,000,000');
  const secret = toHex(await randomBytes(32));
  let h = secret;
  for (let i = 0; i < length; i++) h = await sha256Hex(h);
  return { secret, terminatingHash: h, length };
}

/** gameHash for 1-based game k. O(N - k) hashes; operators cache the chain. */
export async function crashGameHash(chain: CrashChain, k: number): Promise<Hex> {
  if (!Number.isInteger(k) || k < 1 || k > chain.length) throw new Error('game index out of range');
  let h = chain.secret;
  for (let i = 0; i < chain.length - k; i++) h = await sha256Hex(h);
  return h;
}

/** The full chain as an array where index k (1-based) is game k's hash. index 0 is the terminating hash. */
export async function expandCrashChain(chain: CrashChain): Promise<Hex[]> {
  const out: Hex[] = new Array(chain.length + 1);
  let h = chain.secret;
  out[chain.length] = h;
  for (let k = chain.length - 1; k >= 0; k--) {
    h = await sha256Hex(h);
    out[k] = h;
  }
  return out;
}

/** Verify that game k's hash links to the previously revealed hash (game k-1, or the terminating hash for k = 1). */
export async function verifyCrashLink(gameHash: Hex, previousHash: Hex): Promise<boolean> {
  return timingSafeEqualHex(await sha256Hex(gameHash), previousHash.toLowerCase());
}

const TWO_52 = 2n ** 52n;

export async function crashResult(gameHash: Hex, salt: string, houseEdge = 0.01): Promise<number> {
  if (!/^[0-9a-f]{64}$/.test(gameHash)) throw new Error('game hash must be 64 lowercase hex chars');
  if (houseEdge < 0 || houseEdge >= 1) throw new Error('house edge must be in [0, 1)');
  const digest = await hmacSha256(gameHash, salt);
  const hex = toHex(digest).slice(0, 13); // 52 bits
  const h = BigInt('0x' + hex);
  // raw is the multiplier in cents: 100 means 1.00x. Apply the edge, floor to a cent, floor at 1.00x.
  const rawCents = Number((100n * TWO_52 * 1_000_000n) / (h + 1n)) / 1_000_000;
  const cents = Math.floor(rawCents * (1 - houseEdge));
  return Math.max(100, cents) / 100;
}
