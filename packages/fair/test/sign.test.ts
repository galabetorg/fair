import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, sign, verifySignature, signRecord, verifyRecordSignature, verifyRecord, commit, play } from '../src/index.js';
import type { FairRecord } from '../src/types.js';

test('keypair, sign, verify round trip', async () => {
  const kp = await generateKeyPair();
  assert.match(kp.publicKey, /^[0-9a-f]{64}$/);
  assert.match(kp.secretKey, /^[0-9a-f]{128}$/);
  assert.equal(kp.secretKey.slice(64), kp.publicKey);
  const sig = await sign('hello', kp.secretKey);
  assert.match(sig, /^[0-9a-f]{128}$/);
  assert.equal(await verifySignature('hello', sig, kp.publicKey), true);
  assert.equal(await verifySignature('hello!', sig, kp.publicKey), false);
  const other = await generateKeyPair();
  assert.equal(await verifySignature('hello', sig, other.publicKey), false);
});

test('signed record verifies, tampered record fails, verifyRecord reports signatureOk', async () => {
  const kp = await generateKeyPair();
  const seeds = { serverSeed: '5c1f7d3e8a2b4c6d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d', clientSeed: 'galabet', nonce: 3 };
  const { commitment } = await commit(seeds.serverSeed);
  const out = await play({ ...seeds, game: 'dice' });
  const record: FairRecord = { spec: 'GFS/1.0', profile: 'single-player', game: 'dice', params: {}, ...seeds, commitment, cursor: out.cursor, result: out.result, at: 1 };
  const signed = await signRecord(record, kp.secretKey);
  assert.equal(signed.signer, kp.publicKey);
  assert.equal(await verifyRecordSignature(signed), true);
  assert.equal(await verifyRecordSignature({ ...signed, nonce: 4 }), false);
  const v = await verifyRecord(signed);
  assert.equal(v.ok, true, v.reasons.join(';'));
  assert.equal(v.signatureOk, true);
  const bad = await verifyRecord({ ...signed, at: 2 });
  assert.equal(bad.ok, false);
  assert.equal(bad.signatureOk, false);
  assert.equal((await verifyRecord(record)).signatureOk, null);
});
