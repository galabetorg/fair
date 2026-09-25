import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createCrashChain, crashGameHash, expandCrashChain, verifyCrashLink, crashResult } from '../src/index.js';

test('chain links back to the terminating hash', async () => {
  const chain = await createCrashChain(20);
  const all = await expandCrashChain(chain);
  assert.equal(all.length, 21);
  assert.equal(all[0], chain.terminatingHash);
  assert.equal(all[20], chain.secret);
  let prev = chain.terminatingHash;
  for (let k = 1; k <= 20; k++) {
    const gh = await crashGameHash(chain, k);
    assert.equal(gh, all[k]);
    assert.equal(await verifyCrashLink(gh, prev), true);
    assert.equal(createHash('sha256').update(gh).digest('hex'), prev);
    prev = gh;
  }
  assert.equal(await verifyCrashLink(all[5]!, all[3]!), false);
});

test('crash result formula, cross-checked with node:crypto', async () => {
  const gameHash = '5c1f7d3e8a2b4c6d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d';
  const salt = '0x000000000000000000000000000000000000000000000000000000000000abcd';
  const digest = createHmac('sha256', gameHash).update(salt).digest('hex');
  const h = BigInt('0x' + digest.slice(0, 13));
  const rawCents = Number((100n * 2n ** 52n * 1_000_000n) / (h + 1n)) / 1_000_000;
  const expected = Math.max(100, Math.floor(rawCents * 0.99)) / 100;
  assert.equal(await crashResult(gameHash, salt, 0.01), expected);
  assert.ok((await crashResult(gameHash, salt, 0)) >= 1);
});

test('crash results are >= 1.00 across many hashes and roughly half are below 2x', async () => {
  const chain = await createCrashChain(400);
  const all = await expandCrashChain(chain);
  let under2 = 0;
  for (let k = 1; k <= 400; k++) {
    const r = await crashResult(all[k]!, 'salt', 0.01);
    assert.ok(r >= 1);
    if (r < 2) under2++;
  }
  assert.ok(under2 > 140 && under2 < 260, `under2=${under2}`);
});
