# @galabet/fair

Reference implementation of the Galabet Fair Spec (GFS/1.0). Seeds, commitments, HMAC derivation, float extraction, every v1.0 game mapper, canonical records and verification. Zero runtime dependencies. Same bytes in browsers, Node 18+, Bun, Deno and Workers.

```bash
npm install @galabet/fair
```

## Operator side

```ts
import { createServerSeed, createClientSeed, commit, play } from '@galabet/fair';

const serverSeed = await createServerSeed();          // keep secret until rotation
const { commitment } = await commit(serverSeed);     // publish this to the player first
const clientSeed = await createClientSeed();         // or let the player set one

const { result, cursor } = await play({ game: 'dice', serverSeed, clientSeed, nonce: 0 });
// result: 57.31   cursor: 0
```

## Player side

```ts
import { verifyRecord } from '@galabet/fair';

const outcome = await verifyRecord(record);   // record carries the revealed serverSeed
outcome.ok          // true when commitment, cursor and result all check out
outcome.reasons     // [] or a list of what failed
```

## Games

`dice`, `limbo`, `roulette`, `wheel`, `plinko`, `mines`, `keno`, `blackjack`, `hilo`. Mappers are pure functions in `@galabet/fair/games`; the `GAMES` table declares how many floats each needs.

## Conformance

`vectors/gfs-1.0.json` in the repo holds 2,280 published seed, nonce and result triples. A port in any language passes conformance when it reproduces every one under canonical JSON comparison.

MIT.
