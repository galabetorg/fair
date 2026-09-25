/**
 * Generates vectors/gfs-1.0.json from the reference implementation.
 * `--check` fails if the checked-in file differs from a fresh generation.
 * Vectors are frozen once a spec version ships. Never edit them by hand.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commit, deriveDigest, deriveFloats, play, toHex, GAMES, canonicalJson, crashResult, sign, signingPayload, sha256Hex } from '../packages/fair/src/index.js';
import type { FairRecord } from '../packages/fair/src/types.js';
import type { GameName, GameParams } from '../packages/fair/src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../vectors/gfs-1.0.json');
const outCrash = resolve(here, '../vectors/gfs-1.0-crash.json');
const outSign = resolve(here, '../vectors/gfs-1.0-sign.json');

// Fixed, published test key. NEVER use for anything real.
const TEST_SECRET = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';

// Fixed, published seeds. Anyone can regenerate these.
const SERVER_SEEDS = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  '5c1f7d3e8a2b4c6d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d',
  'a3f1c9e2b4d6078f1e2d3c4b5a69788796a5b4c3d2e1f0918273645546372819',
];
const CLIENT_SEEDS = ['galabet', 'a', 'The quick brown fox jumps over the lazy dog', '0123456789abcdef0123456789abcdef'];
const NONCES = [0, 1, 2, 10, 255, 1000, 65535];

const GAME_PARAMS: Record<GameName, GameParams[]> = {
  dice: [{}],
  limbo: [{ houseEdge: 0.01 }, { houseEdge: 0 }, { houseEdge: 0.04 }],
  roulette: [{}],
  wheel: [{ segments: 10 }, { segments: 30 }, { segments: 54 }],
  plinko: [{ rows: 8 }, { rows: 12 }, { rows: 16 }],
  mines: [{ mines: 1 }, { mines: 3 }, { mines: 24 }],
  keno: [{ draws: 10 }, { draws: 1 }, { draws: 40 }],
  blackjack: [{ decks: 1 }, { decks: 8 }],
  hilo: [{ decks: 1 }],
};

async function generate() {
  const commitments = [];
  for (const serverSeed of SERVER_SEEDS) commitments.push({ serverSeed, commitment: (await commit(serverSeed)).commitment });

  const digests = [];
  const floats = [];
  for (const serverSeed of SERVER_SEEDS.slice(0, 2)) {
    for (const clientSeed of CLIENT_SEEDS.slice(0, 2)) {
      for (const nonce of [0, 1, 65535]) {
        for (const cursor of [0, 1]) {
          const d = await deriveDigest({ serverSeed, clientSeed, nonce }, cursor);
          digests.push({ serverSeed, clientSeed, nonce, cursor, digest: toHex(d) });
        }
        const f = await deriveFloats({ serverSeed, clientSeed, nonce }, 16);
        floats.push({ serverSeed, clientSeed, nonce, floats: f.floats, cursor: f.cursor });
      }
    }
  }

  const games = [];
  for (const game of Object.keys(GAMES) as GameName[]) {
    for (const params of GAME_PARAMS[game]) {
      for (const serverSeed of SERVER_SEEDS) {
        for (const clientSeed of CLIENT_SEEDS) {
          for (const nonce of NONCES) {
            const r = await play({ game, params, serverSeed, clientSeed, nonce });
            games.push({ game, params, serverSeed, clientSeed, nonce, cursor: r.cursor, result: r.result });
          }
        }
      }
    }
  }

  return {
    spec: 'GFS/1.0',
    profile: 'single-player',
    generatedBy: '@galabet/fair reference implementation',
    notes: [
      'commitment = SHA-256(serverSeed as UTF-8 hex string)',
      'digest = HMAC-SHA256(key = serverSeed as UTF-8 hex string, message = clientSeed:nonce:cursor)',
      'float = b0/256 + b1/256^2 + b2/256^3 + b3/256^4 over consecutive 4-byte chunks',
      'cursor advances once per 32-byte digest (8 floats)',
      'results must match under canonical JSON comparison',
    ],
    counts: { commitments: commitments.length, digests: digests.length, floats: floats.length, games: games.length },
    commitments,
    digests,
    floats,
    games,
  };
}

async function generateCrash() {
  // A published 12-link chain from a fixed secret, plus results under two salts and two edges.
  const secret = '5c1f7d3e8a2b4c6d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d';
  const length = 12;
  const chain: string[] = [];
  let h = secret;
  chain[length] = h;
  for (let k = length - 1; k >= 0; k--) { h = await sha256Hex(h); chain[k] = h; }
  const salts = ['0x000000000000000000000000000000000000000000000000000000000000abcd', 'galabet'];
  const games = [];
  for (let k = 1; k <= length; k++) for (const salt of salts) for (const houseEdge of [0.01, 0])
    games.push({ index: k, gameHash: chain[k], previousHash: chain[k - 1], salt, houseEdge, result: await crashResult(chain[k]!, salt, houseEdge) });
  return { spec: 'GFS/1.0', profile: 'crash', notes: ['h_0 = secret; h_{i+1} = SHA-256(h_i hex string); terminatingHash = h_N; game k uses h_{N-k}', 'digest = HMAC-SHA256(key = gameHash, message = salt); h = first 52 bits; cents = floor(100 * 2^52 / (h + 1) * (1 - houseEdge)); result = max(100, cents) / 100'], secret, length, terminatingHash: chain[0], games };
}

async function generateSign() {
  const publicKey = TEST_SECRET.slice(64);
  const records: FairRecord[] = [
    { spec: 'GFS/1.0', profile: 'single-player', game: 'dice', params: {}, commitment: '60e05bd1b195af2f94112fa7197a5c88289058840ce7c6df9693756bc6250f55', clientSeed: 'galabet', nonce: 0, cursor: 0, result: 12.34, at: 1700000000000 },
    { spec: 'GFS/1.0', profile: 'single-player', game: 'mines', params: { mines: 3 }, commitment: '60e05bd1b195af2f94112fa7197a5c88289058840ce7c6df9693756bc6250f55', clientSeed: 'a', nonce: 65535, cursor: 2, result: [1, 7, 24], at: 1700000000001 },
  ];
  const items = [];
  for (const record of records) items.push({ record, payload: signingPayload(record), signature: await sign(signingPayload(record), TEST_SECRET), signer: publicKey });
  return { spec: 'GFS/1.0', notes: ['Ed25519 over the canonical JSON of the record without signature and signer', 'secret key layout: 32-byte seed || 32-byte public key, hex'], testSecretKey: TEST_SECRET, publicKey, items };
}

async function main() {
const fresh = await generate();
const crash = await generateCrash();
const signv = await generateSign();
const json = JSON.stringify(fresh, null, 1);

if (process.argv.includes('--check')) {
  const current = readFileSync(out, 'utf8');
  const a = canonicalJson(JSON.parse(current)) + canonicalJson(JSON.parse(readFileSync(outCrash, 'utf8'))) + canonicalJson(JSON.parse(readFileSync(outSign, 'utf8')));
  const b = canonicalJson(fresh) + canonicalJson(crash) + canonicalJson(signv);
  if (a !== b) {
    console.error('vectors drift: regenerate with pnpm vectors:gen and review the diff');
    process.exit(1);
  }
  console.log('vectors match');
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
  writeFileSync(outCrash, JSON.stringify(crash, null, 1));
  writeFileSync(outSign, JSON.stringify(signv, null, 1));
  console.log(`wrote ${out}`, fresh.counts, `+ crash (${crash.games.length}) + sign (${signv.items.length})`);
}
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
