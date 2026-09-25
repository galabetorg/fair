export * from './types.js';
export { toHex, fromHex, sha256, sha256Hex, hmacSha256, randomBytes, timingSafeEqualHex } from './crypto.js';
export {
  createServerSeed,
  createClientSeed,
  commit,
  verifyCommitment,
  assertClientSeed,
  assertServerSeed,
  SERVER_SEED_BYTES,
  CLIENT_SEED_MAX_LENGTH,
} from './seeds.js';
export { deriveDigest, deriveFloats, digestToFloats, bytesToFloat, BYTES_PER_DIGEST, FLOATS_PER_DIGEST } from './derive.js';
export type { FloatStream } from './derive.js';
export { canonicalJson, signingPayload, recordHash } from './record.js';
export { play, verifyRecord } from './verify.js';
export type { PlayInput, PlayOutput, VerifyOutcome } from './verify.js';
export { GAMES, isGameName } from './games/index.js';
export type { GameDefinition } from './games/index.js';

export { generateKeyPair, sign, verifySignature, signRecord, verifyRecordSignature } from './sign.js';
export type { KeyPair } from './sign.js';
export { createCrashChain, crashGameHash, expandCrashChain, verifyCrashLink, crashResult } from './crash.js';
export type { CrashChain } from './crash.js';

export const SPEC_VERSION = 'GFS/1.0' as const;
export { inspectRecord, parseInspection, validateInspectionParams, MAX_RECORD_BYTES } from './inspect.js';
export type { Inspection, InspectionCheck, CheckState } from './inspect.js';
