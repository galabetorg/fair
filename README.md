# Galabet Fair

Provably fair game outcomes you can check. A server seed is committed before play, combined with the player's seed and a counter, and turned into a result by published arithmetic. Anyone holding the revealed inputs can recalculate the result and compare it with what the site recorded.

This repository holds:

| Path | What it is |
|---|---|
| `packages/fair` | `@galabet/fair`, the library. Seeds, commitments, derivation, nine game mappings, the Crash profile, records, signing and verification. No runtime dependencies |
| `spec/gfs-1.0.md` | The GFS 1.0 specification (draft) |
| `vectors/` | Test vectors: 2,240 game results, 48 Crash results and the signing cases. Frozen per spec version |
| `apps/api` | A reference API in NestJS: verify endpoints, demo seed sessions, chip games and a multiplayer Crash engine. Postgres and Redis |

Documentation: https://galabets.org/docs/

## Install

```bash
npm install @galabet/fair
```

```js
import { play } from '@galabet/fair';

const { result } = await play({
  game: 'dice',
  serverSeed: '5c1f7d3e8a2b4c6d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d',
  clientSeed: 'galabet',
  nonce: 42,
});

console.log(result); // 56.12
```

## Working on this repository

Node 18 or newer and pnpm 9.

```bash
pnpm install
pnpm --filter @galabet/fair build
pnpm --filter @galabet/fair test
pnpm vectors:check
node --import tsx spec/check-spec.ts
```

The API needs Postgres and Redis. `apps/api/docker-compose.yml` starts both:

```bash
cd apps/api
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm start:dev
```

Its tests use a real Redis and Postgres when these are set, and skip those cases otherwise:

```bash
REDIS_TEST_URL=redis://127.0.0.1:6379/15 POSTGRES_TEST_URL=postgres://fair:fair@127.0.0.1:5432/fair pnpm --filter api test
```

## What verification proves

A match means the revealed seed hashes to the commitment in the record and the inputs reproduce the recorded result. It does not prove when the commitment was shown, that payouts were honest, or that an operator is trustworthy. https://galabets.org/docs/concepts/what-verification-proves/ covers the limits.

## Changes to the rules

A change that alters a calculated result or a record's canonical form needs a new spec version and new vectors. Published vectors are never edited.

## License

MIT
