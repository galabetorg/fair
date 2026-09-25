import { deriveFloats } from './derive.js';
import { GAMES, isGameName } from './games/index.js';
import { canonicalJson, recordHash } from './record.js';
import { verifyCommitment } from './seeds.js';
import { verifyRecordSignature } from './sign.js';
import type { FairRecord, GameName, GameParams, SeedPair } from './types.js';

export interface PlayInput extends SeedPair {
  game: GameName;
  params?: GameParams;
}

export interface PlayOutput {
  result: unknown;
  cursor: number;
  floats: number[];
}

/** Derive a result. Used both to play (operator side) and to verify (anyone). GFS 4 and 5. */
export async function play(input: PlayInput): Promise<PlayOutput> {
  if (!isGameName(input.game)) throw new Error(`unknown game "${input.game}"`);
  const def = GAMES[input.game];
  const params = input.params ?? {};
  const needed = def.floats(params);
  const { floats, cursor } = await deriveFloats(input, needed);
  return { result: def.map(floats, params), cursor, floats };
}

export interface VerifyOutcome {
  ok: boolean;
  /** What the seeds actually produce. */
  computed: unknown;
  /** What the record claims. */
  claimed: unknown;
  commitmentOk: boolean;
  cursorOk: boolean;
  /** null when the record is unsigned, else whether the signature verifies under `signer`. */
  signatureOk: boolean | null;
  recordHash: string;
  reasons: string[];
}

/**
 * Verify a record that already carries the revealed server seed.
 * Checks: commitment matches the seed, recomputed result equals the claimed result, cursor matches,
 * and the Ed25519 signature when present. Beacon checks live in @galabet/fair-beacon.
 */
export async function verifyRecord(record: FairRecord): Promise<VerifyOutcome> {
  const reasons: string[] = [];
  if (record.spec !== 'GFS/1.0') reasons.push(`unsupported spec ${String(record.spec)}`);
  if (!record.serverSeed) reasons.push('server seed not revealed yet; verify after rotation');
  const commitmentOk = record.serverSeed ? await verifyCommitment(record.serverSeed, record.commitment) : false;
  if (record.serverSeed && !commitmentOk) reasons.push('server seed does not match commitment');

  let computed: unknown = null;
  let cursorOk = false;
  if (record.serverSeed && isGameName(record.game)) {
    const out = await play({
      game: record.game,
      params: record.params,
      serverSeed: record.serverSeed,
      clientSeed: record.clientSeed,
      nonce: record.nonce,
    });
    computed = out.result;
    cursorOk = out.cursor === record.cursor;
    if (!cursorOk) reasons.push(`cursor mismatch: computed ${out.cursor}, record ${record.cursor}`);
    if (canonicalJson(out.result) !== canonicalJson(record.result)) reasons.push('result does not match seeds');
  } else if (!isGameName(record.game)) {
    reasons.push(`unknown game "${String(record.game)}"`);
  }

  let signatureOk: boolean | null = null;
  if (record.signature || record.signer) {
    signatureOk = await verifyRecordSignature(record);
    if (!signatureOk) reasons.push('signature does not verify under signer');
  }

  return {
    ok: reasons.length === 0,
    computed,
    claimed: record.result,
    commitmentOk,
    cursorOk,
    signatureOk,
    recordHash: await recordHash(record),
    reasons,
  };
}
