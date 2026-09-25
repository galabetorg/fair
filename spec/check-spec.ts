/** Targeted checks for the public specification. Does not write or regenerate vectors. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canonicalJson, commit, crashResult, deriveDigest, deriveFloats,
  expandCrashChain, GAMES, play, sha256Hex, signingPayload, toHex,
} from '../packages/fair/src/index.js';
import { dice, limbo, plinko, shuffle } from '../packages/fair/src/games/index.js';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../vectors/${name}`, import.meta.url), 'utf8'));
const vectors = read('gfs-1.0.json');
const crash = read('gfs-1.0-crash.json');
const signatures = read('gfs-1.0-sign.json');
const text = readFileSync(new URL('./gfs-1.0.md', import.meta.url), 'utf8');
assert.deepEqual(vectors.counts, { commitments: 4, digests: 24, floats: 12, games: 2240 });
assert.equal(crash.games.length, 48);
assert.equal(signatures.items.length, 2);

const seeds = {
  serverSeed: '5c1f7d3e8a2b4c6d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d',
  clientSeed: 'galabet', nonce: 42,
};
const commitment = (await commit(seeds.serverSeed)).commitment;
const digest = toHex(await deriveDigest(seeds));
const result = await play({ ...seeds, game: 'dice' });
assert.equal(commitment, 'ab37723062965715c5e6eeb54816f909a8e787bd3bfaee67a3cc0a3b90707de7');
assert.equal(digest, '8fa8eae01ccd43120b5028acd55241e63f01343d81935389da84578897a5fe39');
assert.equal(result.floats[0], 0.5611712262034416);
assert.equal(result.result, 56.12);
for (const value of [seeds.serverSeed, commitment, digest, String(result.floats[0]), String(result.result)]) assert.ok(text.includes(value), `worked example missing ${value}`);

const counts = { dice: 1, limbo: 1, roulette: 1, wheel: 1, plinko: 16, mines: 24, keno: 39, blackjack: 51, hilo: 51 };
for (const [game, count] of Object.entries(counts)) {
  assert.equal(GAMES[game as keyof typeof GAMES].floats({}), count);
  assert.equal((await deriveFloats(seeds, count)).cursor, Math.floor((count - 1) / 8));
}
assert.equal((await deriveFloats(seeds, 8)).cursor, 0);
assert.equal((await deriveFloats(seeds, 9)).cursor, 1);
assert.equal(dice(0), 0);
assert.equal(dice(1 - 2 ** -32), 100);
assert.equal(limbo(0, 0.01), 99000000);
assert.deepEqual(plinko(Array(8).fill(0.5), 8), { path: Array(8).fill(1), bucket: 8 });
assert.deepEqual(shuffle([0, 0, 0], 4), [1, 2, 3, 0]);
// JS UTF-16 ordering: the supplementary character sorts before the BMP private-use character.
assert.equal(canonicalJson({ '\uE000': 1, '\u{10000}': 2 }), '{"𐀀":2,"":1}');
assert.equal(canonicalJson(-0), '0');
assert.equal(signingPayload({ ...signatures.items[0].record, signer: 'ignored', signature: 'ignored' }), signatures.items[0].payload);
assert.notEqual(signingPayload(signatures.items[0].record), signingPayload({ ...signatures.items[0].record, serverSeed: seeds.serverSeed }));

const chain = await expandCrashChain({ secret: crash.secret, terminatingHash: crash.terminatingHash, length: crash.length });
assert.equal(chain[0], crash.terminatingHash);
assert.equal(chain[crash.length], crash.secret);
for (const item of crash.games) {
  assert.equal(chain[item.index], item.gameHash);
  assert.equal(await sha256Hex(item.gameHash), item.previousHash);
  assert.equal(await crashResult(item.gameHash, item.salt, item.houseEdge), item.result);
}
console.log('Specification checks passed: worked example, vector counts, mapper consumption, boundary behavior, canonicalization and Crash chain.');
