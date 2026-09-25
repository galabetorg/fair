import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import {
  createServerSeed,
  createClientSeed,
  commit,
  verifyCommitment,
  deriveDigest,
  deriveFloats,
  bytesToFloat,
  digestToFloats,
  toHex,
  fromHex,
  canonicalJson,
  signingPayload,
} from '../src/index.js';

const seeds = {
  serverSeed: '5c1f7d3e8a2b4c6d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d',
  clientSeed: 'galabet',
  nonce: 42,
};

test('server seed is 64 lowercase hex chars and unique', async () => {
  const a = await createServerSeed();
  const b = await createServerSeed();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('client seed default is 32 hex chars', async () => {
  assert.match(await createClientSeed(), /^[0-9a-f]{32}$/);
});

test('commitment equals SHA-256 of the hex string, cross-checked with node:crypto', async () => {
  const { commitment } = await commit(seeds.serverSeed);
  const expected = createHash('sha256').update(seeds.serverSeed, 'utf8').digest('hex');
  assert.equal(commitment, expected);
  assert.equal(await verifyCommitment(seeds.serverSeed, commitment), true);
  assert.equal(await verifyCommitment(seeds.serverSeed, commitment.replace(/^./, 'f')), false);
});

test('digest equals HMAC-SHA256(serverSeed, clientSeed:nonce:cursor), cross-checked with node:crypto', async () => {
  for (const cursor of [0, 1, 7]) {
    const digest = await deriveDigest(seeds, cursor);
    const expected = createHmac('sha256', seeds.serverSeed).update(`${seeds.clientSeed}:${seeds.nonce}:${cursor}`).digest('hex');
    assert.equal(toHex(digest), expected);
  }
});

test('float extraction formula matches the spec, hand computed', () => {
  assert.equal(bytesToFloat(0, 0, 0, 0), 0);
  assert.equal(bytesToFloat(128, 0, 0, 0), 0.5);
  assert.equal(bytesToFloat(255, 255, 255, 255), 1 - 1 / 4294967296);
  assert.equal(bytesToFloat(1, 2, 3, 4), 1 / 256 + 2 / 65536 + 3 / 16777216 + 4 / 4294967296);
  const digest = new Uint8Array(32);
  digest.set([0, 0, 0, 0, 128, 0, 0, 0, 64, 0, 0, 0], 0);
  const f = digestToFloats(digest);
  assert.equal(f.length, 8);
  assert.deepEqual(f.slice(0, 3), [0, 0.5, 0.25]);
});

test('every float is in [0, 1)', async () => {
  const { floats } = await deriveFloats(seeds, 8 * 20);
  assert.equal(floats.length, 160);
  for (const f of floats) assert.ok(f >= 0 && f < 1);
});

test('cursor advances once per 8 floats and reports the highest consumed', async () => {
  assert.equal((await deriveFloats(seeds, 1)).cursor, 0);
  assert.equal((await deriveFloats(seeds, 8)).cursor, 0);
  assert.equal((await deriveFloats(seeds, 9)).cursor, 1);
  assert.equal((await deriveFloats(seeds, 24)).cursor, 2);
  assert.equal((await deriveFloats(seeds, 51)).cursor, 6);
});

test('float stream is a prefix-stable sequence across cursors', async () => {
  const short = await deriveFloats(seeds, 5);
  const long = await deriveFloats(seeds, 30);
  assert.deepEqual(long.floats.slice(0, 5), short.floats);
});

test('changing any input changes the digest', async () => {
  const base = toHex(await deriveDigest(seeds));
  assert.notEqual(toHex(await deriveDigest({ ...seeds, nonce: 43 })), base);
  assert.notEqual(toHex(await deriveDigest({ ...seeds, clientSeed: 'galabet2' })), base);
  assert.notEqual(toHex(await deriveDigest(seeds, 1)), base);
});

test('rejects bad inputs', async () => {
  await assert.rejects(deriveDigest({ ...seeds, serverSeed: 'abc' }));
  await assert.rejects(deriveDigest({ ...seeds, clientSeed: '' }));
  await assert.rejects(deriveDigest({ ...seeds, clientSeed: 'a:b' }));
  await assert.rejects(deriveDigest({ ...seeds, nonce: -1 }));
  await assert.rejects(deriveDigest({ ...seeds, nonce: 1.5 }));
});

test('hex round trip', () => {
  const bytes = new Uint8Array([0, 1, 254, 255]);
  assert.equal(toHex(bytes), '0001feff');
  assert.deepEqual(fromHex('0001feff'), bytes);
  assert.throws(() => fromHex('abc'));
});

test('canonical JSON sorts keys, drops undefined, no whitespace', () => {
  const out = canonicalJson({ b: 1, a: { z: [1, 2, { y: 'x' }], m: undefined }, c: 'str', d: null });
  assert.equal(out, '{"a":{"z":[1,2,{"y":"x"}]},"b":1,"c":"str","d":null}');
  assert.equal(canonicalJson([1, undefined, 3]), '[1,null,3]');
  assert.throws(() => canonicalJson({ a: Infinity }));
});

test('signing payload excludes signature and signer', () => {
  const payload = signingPayload({
    spec: 'GFS/1.0',
    profile: 'single-player',
    game: 'dice',
    params: {},
    commitment: 'c',
    clientSeed: 'x',
    nonce: 0,
    cursor: 0,
    result: 1,
    at: 1,
    signature: 'sig',
    signer: 'key',
  });
  assert.ok(!payload.includes('signature'));
  assert.ok(!payload.includes('signer'));
});
