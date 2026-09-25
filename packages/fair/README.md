# @galabet/fair

The reference implementation of GFS 1.0, the Galabet Fair specification. It commits to a server seed, combines it with the player's seed and a counter, turns the result into a game outcome, and lets anyone recheck that outcome later. No runtime dependencies. It runs on Web Crypto, in browsers and in Node 18 or newer.

Documentation: https://galabets.org/docs/

```bash
npm install @galabet/fair
```

## A Round

```js
import { play } from '@galabet/fair';

const { result, cursor } = await play({
  game: 'dice',
  serverSeed: '5c1f7d3e8a2b4c6d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d',
  clientSeed: 'galabet',
  nonce: 42,
});

console.log(result, cursor); // 56.12 0
```

That seed is public, for trying the library. A real server makes its own with `createServerSeed()`, shows players `(await commit(serverSeed)).commitment` before the first bet, and keeps the seed secret until it rotates to a new one.

## Checking a Round

```js
import { verifyRecord } from '@galabet/fair';

const outcome = await verifyRecord(record); // a record that carries its revealed serverSeed
outcome.ok;      // true when the commitment, cursor and result all check out
outcome.reasons; // what failed, if anything
```

For records pasted in by other people, use `inspectRecord`, which validates the input first and reports each check separately.

## Games

`dice`, `limbo`, `roulette`, `wheel`, `plinko`, `mines`, `keno`, `blackjack` and `hilo`, plus the Crash hash-chain profile. The mappers are also exported on their own from `@galabet/fair/games`.

## Ports

`vectors/gfs-1.0.json` in the repository holds 2,240 game results with their inputs, and the specification is `spec/gfs-1.0.md`. A port in another language matches the reference when it reproduces every vector.

## Limits

A verified round shows the result was fixed by seeds committed in advance. It does not show when the commitment was published, that payouts were correct, or that an operator can be trusted. The library does not handle money, storage or networking.

MIT
