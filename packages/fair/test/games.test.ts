import { test } from 'node:test';
import assert from 'node:assert/strict';
import { play, verifyRecord, commit, GAMES } from '../src/index.js';
import { dice, limbo, roulette, wheel, plinko, mines, keno, deck, shuffle, cardLabel } from '../src/games/index.js';
import type { FairRecord, GameName } from '../src/types.js';

const seeds = {
  serverSeed: '5c1f7d3e8a2b4c6d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d',
  clientSeed: 'galabet',
  nonce: 7,
};

test('dice maps float to 0.00..100.00 with two decimals', () => {
  assert.equal(dice(0), 0);
  assert.equal(dice(0.5), 50);
  assert.equal(dice(0.99999999), 100);
  assert.equal(dice(0.123456), 12.34);
});

test('limbo never below 1.00 and applies house edge', () => {
  assert.equal(limbo(0.9999999), 1);
  assert.equal(limbo(0.5), 1.97);
  assert.equal(limbo(0.01, 0.01), 98.99);
  assert.equal(limbo(0.01, 0), 99.99);
});

test('roulette and wheel are floor(float * n)', () => {
  assert.equal(roulette(0), 0);
  assert.equal(roulette(0.999), 36);
  assert.equal(wheel(0.5, 10), 5);
  assert.throws(() => wheel(0.5, 1));
});

test('plinko path and bucket', () => {
  const r = plinko([0.1, 0.9, 0.49, 0.5, 0.2, 0.7, 0.3, 0.8], 8);
  assert.deepEqual(r.path, [0, 1, 0, 1, 0, 1, 0, 1]);
  assert.equal(r.bucket, 4);
  assert.throws(() => plinko([0.1], 8));
});

test('shuffle is a permutation and deterministic', () => {
  const floats = Array.from({ length: 51 }, (_, i) => ((i * 37) % 100) / 100);
  const a = shuffle(floats, 52);
  const b = shuffle(floats, 52);
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort((x, y) => x - y), Array.from({ length: 52 }, (_, i) => i));
  assert.throws(() => shuffle(floats.slice(0, 10), 52));
});

test('mines returns sorted unique positions within the grid', () => {
  const floats = Array.from({ length: 24 }, (_, i) => ((i * 61) % 97) / 97);
  const m = mines(floats, 5);
  assert.equal(m.length, 5);
  assert.equal(new Set(m).size, 5);
  for (const p of m) assert.ok(p >= 0 && p < 25);
  assert.deepEqual(m, [...m].sort((a, b) => a - b));
});

test('keno draws 1..40, unique, sorted', () => {
  const floats = Array.from({ length: 39 }, (_, i) => ((i * 53) % 89) / 89);
  const k = keno(floats, 10);
  assert.equal(k.length, 10);
  assert.equal(new Set(k).size, 10);
  for (const n of k) assert.ok(n >= 1 && n <= 40);
});

test('deck is 52 unique labelled cards', () => {
  const floats = Array.from({ length: 51 }, (_, i) => ((i * 29) % 83) / 83);
  const d = deck(floats, 1);
  assert.equal(d.length, 52);
  assert.equal(new Set(d).size, 52);
  assert.equal(cardLabel(0), 'AC');
  assert.equal(cardLabel(51), 'KS');
});

test('play produces a result and cursor for every game', async () => {
  for (const game of Object.keys(GAMES) as GameName[]) {
    const out = await play({ ...seeds, game });
    assert.ok(out.result !== undefined, game);
    assert.ok(out.cursor >= 0, game);
    assert.equal(out.floats.length, GAMES[game].floats({}), game);
  }
});

test('shuffle games advance the cursor', async () => {
  assert.equal((await play({ ...seeds, game: 'dice' })).cursor, 0);
  assert.equal((await play({ ...seeds, game: 'mines' })).cursor, 2); // 24 floats
  assert.equal((await play({ ...seeds, game: 'keno' })).cursor, 4); // 39 floats
  assert.equal((await play({ ...seeds, game: 'blackjack' })).cursor, 6); // 51 floats
});

test('verifyRecord accepts an honest record and rejects a tampered one', async () => {
  const { commitment } = await commit(seeds.serverSeed);
  const out = await play({ ...seeds, game: 'dice' });
  const record: FairRecord = {
    spec: 'GFS/1.0',
    profile: 'single-player',
    game: 'dice',
    params: {},
    serverSeed: seeds.serverSeed,
    commitment,
    clientSeed: seeds.clientSeed,
    nonce: seeds.nonce,
    cursor: out.cursor,
    result: out.result,
    at: 1700000000000,
  };
  const ok = await verifyRecord(record);
  assert.equal(ok.ok, true, ok.reasons.join('; '));
  assert.equal(ok.commitmentOk, true);
  assert.equal(ok.cursorOk, true);
  assert.match(ok.recordHash, /^[0-9a-f]{64}$/);

  const tampered = await verifyRecord({ ...record, result: (out.result as number) + 0.01 });
  assert.equal(tampered.ok, false);
  assert.ok(tampered.reasons.some((r) => r.includes('result')));

  const wrongCommit = await verifyRecord({ ...record, commitment: commitment.replace(/^./, 'f') });
  assert.equal(wrongCommit.ok, false);
  assert.equal(wrongCommit.commitmentOk, false);

  const unrevealed = await verifyRecord({ ...record, serverSeed: undefined });
  assert.equal(unrevealed.ok, false);
});
