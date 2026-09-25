import { randomBytes, sha256Hex, timingSafeEqualHex, toHex } from './crypto.js';
import type { Commitment, Hex } from './types.js';

export const SERVER_SEED_BYTES = 32;
export const CLIENT_SEED_DEFAULT_BYTES = 16;
export const CLIENT_SEED_MAX_LENGTH = 64;

/** 32 random bytes from the platform CSPRNG, hex encoded. GFS 3.1. */
export async function createServerSeed(): Promise<Hex> {
  return toHex(await randomBytes(SERVER_SEED_BYTES));
}

/** Default client seed: 16 random bytes, hex encoded. Players may replace it with any string up to 64 chars. */
export async function createClientSeed(): Promise<string> {
  return toHex(await randomBytes(CLIENT_SEED_DEFAULT_BYTES));
}

export function assertClientSeed(clientSeed: string): void {
  if (typeof clientSeed !== 'string' || clientSeed.length < 1 || clientSeed.length > CLIENT_SEED_MAX_LENGTH) {
    throw new Error(`client seed must be 1 to ${CLIENT_SEED_MAX_LENGTH} characters`);
  }
  if (clientSeed.includes(':')) {
    throw new Error('client seed must not contain ":" (reserved as the HMAC message separator)');
  }
}

export function assertServerSeed(serverSeed: string): void {
  if (!/^[0-9a-f]{64}$/.test(serverSeed)) {
    throw new Error('server seed must be 64 lowercase hex characters');
  }
}

/** The commitment is SHA-256 over the hex string of the server seed. GFS 3.2. */
export async function commit(serverSeed: Hex): Promise<Commitment> {
  assertServerSeed(serverSeed);
  return { commitment: await sha256Hex(serverSeed), publishedAt: Date.now() };
}

/** True if `serverSeed` hashes to `commitment`. */
export async function verifyCommitment(serverSeed: Hex, commitment: Hex): Promise<boolean> {
  assertServerSeed(serverSeed);
  const actual = await sha256Hex(serverSeed);
  return timingSafeEqualHex(actual, commitment.toLowerCase());
}
