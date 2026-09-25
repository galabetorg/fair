import { sha256Hex } from './crypto.js';
import type { FairRecord } from './types.js';

/**
 * Canonical JSON (RFC 8785 subset sufficient for records): object keys sorted by code point,
 * no whitespace, no undefined members, numbers as shortest round-trip JS serialisation.
 * The same record canonicalises to the same bytes in every language that follows the spec.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}

/** The bytes an operator signs: the canonical record without `signature` and `signer`. */
export function signingPayload(record: FairRecord): string {
  const { signature: _s, signer: _k, ...rest } = record;
  return canonicalJson(rest);
}

/** SHA-256 of the signing payload. Stable id for a record. */
export async function recordHash(record: FairRecord): Promise<string> {
  return sha256Hex(signingPayload(record));
}
