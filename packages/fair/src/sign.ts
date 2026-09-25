/**
 * Ed25519 signing over canonical records, via Web Crypto. GFS 6.2.
 * Secret keys are 64 bytes hex: 32-byte seed followed by the 32-byte public key, the libsodium layout,
 * so a key can be imported as JWK anywhere without deriving the public half.
 * Supported: Node 18.4+, Chrome 113+, Firefox 130+, Safari 17+, Bun, Deno, Workers.
 */
import { fromHex, toHex, utf8 } from './crypto.js';
import { signingPayload } from './record.js';
import type { FairRecord, Hex } from './types.js';

async function subtle(): Promise<SubtleCrypto> {
  const g = globalThis as { crypto?: Crypto };
  if (g.crypto?.subtle) return g.crypto.subtle;
  const node = await import('node:crypto');
  return (node.webcrypto as unknown as Crypto).subtle;
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface KeyPair {
  /** 32 bytes hex. Publish this. */
  publicKey: Hex;
  /** 64 bytes hex: seed || publicKey. Keep secret. */
  secretKey: Hex;
}

export async function generateKeyPair(): Promise<KeyPair> {
  const s = await subtle();
  const kp = (await s.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await s.exportKey('jwk', kp.privateKey);
  const pub = new Uint8Array(await s.exportKey('raw', kp.publicKey));
  const seed = fromBase64Url(jwk.d as string);
  return { publicKey: toHex(pub), secretKey: toHex(seed) + toHex(pub) };
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function splitSecret(secretKey: Hex): { seed: Uint8Array; pub: Uint8Array } {
  if (!/^[0-9a-f]{128}$/.test(secretKey)) throw new Error('secret key must be 128 hex chars (seed || public key)');
  const bytes = fromHex(secretKey);
  return { seed: bytes.slice(0, 32), pub: bytes.slice(32) };
}

export async function sign(message: string | Uint8Array, secretKey: Hex): Promise<Hex> {
  const s = await subtle();
  const { seed, pub } = splitSecret(secretKey);
  const key = await s.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', d: b64url(seed), x: b64url(pub) }, { name: 'Ed25519' }, false, ['sign']);
  const data = typeof message === 'string' ? utf8(message) : message;
  return toHex(new Uint8Array(await s.sign({ name: 'Ed25519' }, key, data as BufferSource)));
}

export async function verifySignature(message: string | Uint8Array, signature: Hex, publicKey: Hex): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(publicKey) || !/^[0-9a-f]{128}$/.test(signature)) return false;
  const s = await subtle();
  const key = await s.importKey('raw', fromHex(publicKey) as BufferSource, { name: 'Ed25519' }, false, ['verify']);
  const data = typeof message === 'string' ? utf8(message) : message;
  return s.verify({ name: 'Ed25519' }, key, fromHex(signature) as BufferSource, data as BufferSource);
}

/** Sign a record: returns a copy with `signature` and `signer` set. */
export async function signRecord(record: FairRecord, secretKey: Hex): Promise<FairRecord> {
  const { pub } = splitSecret(secretKey);
  const signature = await sign(signingPayload(record), secretKey);
  return { ...record, signature, signer: toHex(pub) };
}

/** True when the record carries a signature that verifies under its `signer`. */
export async function verifyRecordSignature(record: FairRecord): Promise<boolean> {
  if (!record.signature || !record.signer) return false;
  return verifySignature(signingPayload(record), record.signature, record.signer);
}
