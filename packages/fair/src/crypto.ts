/**
 * Thin wrapper over Web Crypto. Works unchanged in browsers, Node 18+, Bun, Deno
 * and Cloudflare Workers. No third-party dependency.
 */

type SubtleLike = SubtleCrypto;

async function getCrypto(): Promise<Crypto> {
  const g = globalThis as { crypto?: Crypto };
  if (g.crypto?.subtle) return g.crypto;
  // Node 18 exposes webcrypto under node:crypto only.
  const nodeCrypto = await import('node:crypto');
  return nodeCrypto.webcrypto as unknown as Crypto;
}

let cached: Promise<Crypto> | undefined;
function cryptoApi(): Promise<Crypto> {
  cached ??= getCrypto();
  return cached;
}

const encoder = new TextEncoder();

export function utf8(input: string): Uint8Array {
  return encoder.encode(input);
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new Error('fromHex: input must be an even-length hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function randomBytes(length: number): Promise<Uint8Array> {
  const c = await cryptoApi();
  const bytes = new Uint8Array(length);
  c.getRandomValues(bytes);
  return bytes;
}

export async function sha256(input: string | Uint8Array): Promise<Uint8Array> {
  const c = await cryptoApi();
  const data = typeof input === 'string' ? utf8(input) : input;
  return new Uint8Array(await c.subtle.digest('SHA-256', data as BufferSource));
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  return toHex(await sha256(input));
}

/**
 * HMAC-SHA256. `key` is used as raw UTF-8 bytes of the string you pass.
 * GFS keys the HMAC with the server seed *as a hex string*, not its decoded bytes,
 * so that existing industry implementations remain conformant.
 */
export async function hmacSha256(key: string | Uint8Array, message: string | Uint8Array): Promise<Uint8Array> {
  const c = await cryptoApi();
  const subtle: SubtleLike = c.subtle;
  const keyBytes = typeof key === 'string' ? utf8(key) : key;
  const msgBytes = typeof message === 'string' ? utf8(message) : message;
  const cryptoKey = await subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', cryptoKey, msgBytes as BufferSource));
}

/** Constant-time comparison of two hex strings of equal length. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
