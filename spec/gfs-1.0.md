# Galabet Fair Specification — GFS/1.0

**Status: Draft.** This document describes the calculation contract implemented by `@galabet/fair` 0.1.0. It is not a declaration of production readiness, an operator certification or an independently audited standard. Fair 1.0, 2.0 and 3.0 are product editions; they do not change this calculation identifier.

## Contents

1. [Scope and conventions](#1-scope-and-conventions)
2. [Seeds and commitment](#2-seeds-and-commitment)
3. [Digest, floats and cursor](#3-digest-floats-and-cursor)
4. [Game mappings](#4-game-mappings)
5. [Crash chain and endpoint](#5-crash-chain-and-endpoint)
6. [Records and signatures](#6-records-and-signatures)
7. [Verification and limits](#7-verification-and-limits)
8. [Conformance](#8-conformance)

## 1. Scope and conventions

GFS/1.0 defines reproducible outcomes for nine seed-pair games and a separate Crash profile. It specifies hashing inputs, byte extraction, game mappings and single-player record signatures. Wallets, wager acceptance, payout tables, cash-out clocks, transport, session persistence and account identity belong to the application using these calculations.

In this draft, **must** identifies a requirement for reproducing the described calculation or encoding. An **operator obligation** concerns conduct that the pure library cannot establish. An **implementation limit** documents validation or portability boundaries; it must not be mistaken for proof that every entry point enforces the same constraints.

Conventions:

- Hash and signature output is lowercase hexadecimal without a `0x` prefix.
- Strings passed to SHA-256 and HMAC-SHA256 are encoded with UTF-8, as by JavaScript `TextEncoder`. A hexadecimal-looking string remains text unless decoding is explicitly stated.
- Arithmetic uses JavaScript binary64 `Number` evaluation in the order shown, except the explicitly marked Crash integer division. Algebraically equivalent expressions with different rounding are not automatically conformant.
- `floor(x)` rounds toward negative infinity. Array positions and game indices are zero-based except the explicitly one-based Crash game number.
- For portable records, nonce, cursor, timestamps and integer parameters must be safe integers, at most `9007199254740991`, within their narrower game limits. JSON cannot preserve integers outside that range in the reference implementation.
- The rules describe admitted input domains. They are not a promise of perfect rejection of arbitrary JavaScript objects by low-level helpers.

Source: [`crypto.ts`](../packages/fair/src/crypto.ts), [`types.ts`](../packages/fair/src/types.ts).

## 2. Seeds and commitment

### 2.1 Server seed

A server seed is exactly 64 lowercase hexadecimal characters, representing 32 random bytes. `createServerSeed()` obtains those bytes from the platform cryptographic random generator and hex-encodes them.

The commitment is:

```text
commitment = hex(SHA-256(UTF8(serverSeed)))
```

This hashes the **64-character string**, not 32 decoded bytes. Uppercase server seeds are rejected by the seed validator. Do not lowercase, trim or otherwise repair an unknown seed during verification; preserve the committed text.

`commit()` also returns `publishedAt`, a local Unix timestamp in milliseconds. The function does not publish the commitment, persist it or prove its publication time. `verifyCommitment()` hashes the supplied valid seed and compares with the supplied commitment, accepting uppercase commitment text by lowercasing that comparison value.

### 2.2 Client seed and nonce

The client seed is a string with length 1–64 **JavaScript UTF-16 code units**, containing no colon (`:`). It is encoded as UTF-8 for hashing, without Unicode normalization. `createClientSeed()` defaults to 16 random bytes encoded as 32 lowercase hexadecimal characters. User-selected text need not be hexadecimal. Ports must preserve the same string encoding; JavaScript `TextEncoder` replaces unpaired surrogate code units with U+FFFD.

The nonce is a non-negative integer. Operators start at zero for a fresh seed pair and allocate it durably so distinct accepted rounds do not reuse a nonce under the same pair. The pure derivation function neither allocates nonces nor detects reuse. Retrieving an existing idempotent round is not a new allocation.

**Operator obligations:** publish and preserve the commitment before accepting the covered play; keep the live server seed secret; bind the client seed and nonce to the accepted round; reveal retired seeds after rotation; publish the replacement commitment before its use. The library can reproduce a disclosed calculation but cannot prove this chronology.

Source: [`seeds.ts`](../packages/fair/src/seeds.ts), [`derive.ts`](../packages/fair/src/derive.ts).

## 3. Digest, floats and cursor

### 3.1 HMAC input

For digest cursor `c`, initially zero:

```text
key     = UTF8(serverSeed)
message = UTF8(clientSeed + ":" + decimal(nonce) + ":" + decimal(c))
digest  = HMAC-SHA256(key, message)
```

Nonce and cursor use unsigned decimal integer text without separators, exponent notation or leading zeros (except zero itself). The safe-integer domain above has the same spelling as JavaScript interpolation. The low-level `deriveDigest()` checks `Number.isInteger`, not `Number.isSafeInteger`; ports and callers must enforce the portable domain themselves. The bounded inspection API does enforce safe integers.

### 3.2 Four bytes per float

Read each 32-byte digest from the first byte to the last, in non-overlapping groups of four:

```text
f = b0/256 + b1/65536 + b2/16777216 + b3/4294967296
```

Each `b` is an unsigned byte. This is the big-endian 32-bit unsigned integer divided by `2^32`; therefore `0 <= f < 1`. A digest yields eight floats. There is no rejection-sampling step, and game indices use multiplication and flooring rather than modulo reduction of the digest.

To obtain more floats, increment the digest cursor and append all eight floats of the next digest. For a request of `n >= 1` floats, return the first `n` and record:

```text
cursor = floor((n - 1) / 8)
```

This is the **highest digest index consumed**, not the number of floats, bytes or digests. Each new `play()` call starts derivation at cursor zero; the cursor is not state carried between rounds.

### 3.3 Worked public input

```text
serverSeed = 5c1f7d3e8a2b4c6d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d
clientSeed = galabet
nonce      = 42
cursor     = 0
commitment = ab37723062965715c5e6eeb54816f909a8e787bd3bfaee67a3cc0a3b90707de7
message    = galabet:42:0
digest     = 8fa8eae01ccd43120b5028acd55241e63f01343d81935389da84578897a5fe39
firstBytes = 143, 168, 234, 224
firstFloat = 0.5611712262034416
dice       = 56.12
```

This is a public calculation example, not a usable secret or evidence of a live round. [`check-spec.ts`](check-spec.ts) checks these exact values against the source implementation.

## 4. Game mappings

`play()` takes a game name, seed pair and optional `params` object. Omitted parameters take the defaults below. The implementation uses nullish coalescing; portable records should carry explicit valid values or omit them, rather than rely on `null`. Irrelevant parameters are ignored by `play()` but rejected by the bounded inspector. Do not imply that an ignored payout parameter changed the calculated outcome.

| Game | Parameter and default | Floats | Recorded cursor | Result |
| --- | --- | ---: | ---: | --- |
| Dice | None | 1 | 0 | Number from 0.00 through 100.00 |
| Limbo | `houseEdge = 0.01` | 1 | 0 | Multiplier, minimum 1.00 |
| Roulette | None | 1 | 0 | Integer pocket 0–36 |
| Wheel | `segments = 10` | 1 | 0 | Integer index 0–`segments−1` |
| Plinko | `rows = 16`, integer 8–16 | `rows` | 0 for 8 rows; 1 otherwise | `{ path, bucket }` |
| Mines | `mines = 3`, integer 1–24 | 24 | 2 | Sorted zero-based mine positions |
| Keno | `draws = 10`, integer 1–40 | 39 | 4 | Sorted numbers 1–40 |
| Blackjack | `decks = 1`, integer 1–8 | `52*decks−1` | `floor((52*decks−2)/8)` | Card labels in dealing order |
| Hi-Lo (`hilo`) | `decks = 1`, integer 1–8 | `52*decks−1` | Same as Blackjack | Card labels in dealing order |

### 4.1 Dice, Roulette and Wheel

```text
dice(f)              = floor(f * 10001) / 100
roulette(f)          = floor(f * 37)
wheel(f, segments)   = floor(f * segments)
```

Wheel's core mapper accepts integer segment counts of at least two without a game-specific upper bound. The inspector permits 2–100. Segment values, colours, multipliers and their ordering belong to an application table and must be retained separately if needed to explain settlement.

Dice includes both endpoints in its displayed hundredths. A target comparison is separate from this roll. Roulette specifies European pocket numbers, not physical wheel order, colour or wager settlement. Mapping a finite 32-bit float grid into buckets does not imply every bucket has exactly the same number of source values.

### 4.2 Limbo

Evaluate in this order:

```text
raw      = 100000000 / (f * 100000000 + 1)
withEdge = floor(raw * (1 - houseEdge) * 100) / 100
result   = max(1, withEdge)
```

The declared edge affects the `(1 - houseEdge)` factor. The minimum of 1 is a lower bound, not the source of the edge. The result is floored to hundredths; formatting must not substitute ordinary rounding. The core Limbo mapper does not validate `houseEdge`; callers must supply a finite edge in `[0,1)`. The inspector deliberately accepts only `[0,0.5]`. This difference is an application validation limit, not a different formula.

### 4.3 Plinko

For each row, consume one float in sequence: `f < 0.5` means left (`0`), otherwise right (`1`). Return the path array and `bucket = sum(path)`. Buckets range from zero through `rows`. The calculation does not simulate gravity or collisions and does not select a payout table. A renderer follows the recorded path.

### 4.4 Shared shuffle

Mines, Keno and both card games use this descending Fisher–Yates shuffle:

```text
items = [0, 1, ..., size - 1]
k = 0
for i = size - 1 down to 1:
    j = floor(floats[k] * (i + 1))
    swap(items[i], items[j])
    k = k + 1
```

Consume exactly `size−1` floats, one per swap, including swaps of an item with itself. Do not change to ascending shuffling or partial sampling.

- **Mines:** shuffle 25 positions, take the first `mines`, then sort ascending numerically. Tile labels are 0–24. The usual 5×5 renderer reads these in row-major order; the mapper itself returns positions only. Changing the mine count does not shorten the shuffle.
- **Keno:** shuffle 40 positions, take the first `draws`, add one to each, then sort ascending numerically. The returned sorted set does not retain draw order. Changing the draw count does not shorten the shuffle.
- **Blackjack and Hi-Lo:** shuffle `52*decks` positions. Map each shuffled position modulo 52 to a card label; do not sort the output. Before shuffling, suit order is `C, D, H, S`, and rank order within each suit is `A, 2, 3, 4, 5, 6, 7, 8, 9, T, J, Q, K`. Index `suit*13 + rank` maps to `rank + suit` (for example `AC`, `TD`, `KS`). Multiple decks repeat these labels. Both games return the same deck for identical inputs. Decisions, hand values, dealing recipients, ace handling and settlement are separate application rules.

Source: [`games/`](../packages/fair/src/games/), especially [`games/index.ts`](../packages/fair/src/games/index.ts).

## 5. Crash chain and endpoint

Crash does not call the seed-pair `play()` mapper, does not consume its floats and does not use its nonce/cursor fields.

### 5.1 Chain direction

For a chain of length `N`, generate a secret `h0` of 32 random bytes encoded as lowercase hex:

```text
h0     = secret
h(i+1) = hex(SHA-256(UTF8(hi)))
```

Publish `hN` as the terminating commitment. Game `k`, numbered from 1 through `N`, uses `h(N−k)`. Reveal games toward the secret, not away from it:

```text
SHA-256(UTF8(gameHash[k])) = previousHash
previousHash = hN for game 1, otherwise gameHash[k−1]
```

`expandCrashChain()` returns index zero as the terminating hash and index `k` as game `k`'s hash. `createCrashChain()` permits lengths 1–10,000,000. Chain generation, storage and caching need operational resource limits; a valid upper bound is not a latency guarantee.

### 5.2 Salt and multiplier

The salt is a string, used as UTF-8 exactly as supplied. A salt that begins `0x` still includes those two characters; it is not decoded as hexadecimal. Commit to the chain before an agreed external salt becomes known, then keep that salt fixed for the chain if making an external-randomness claim. The library takes a supplied string; it does not obtain or authenticate a blockchain block, drand round or other source and does not establish who controlled it.

The default edge is `0.01`. For a finite `houseEdge` in `[0,1)`:

```text
digest = HMAC-SHA256(key = UTF8(gameHash), message = UTF8(salt))
h      = unsigned integer represented by the first 13 hex digits of digest
```

Those 13 digits are the first 52 bits. Preserve the reference implementation's exact arithmetic stages:

```text
q        = (100 * 2^52 * 1000000) integer-divided by (h + 1)
rawCents = Number(q) / 1000000
cents    = floor(rawCents * (1 - houseEdge))
result   = max(100, cents) / 100
```

The division producing `q` is positive arbitrary-precision integer division, truncated toward zero. Conversion of `q` to binary64 occurs **before** division by one million. A real-number shorthand such as `floor(100*2^52/(h+1)*(1-edge))` is explanatory only: it omits the reference's intermediate truncation and rounding. Ports must reproduce the staged arithmetic.

Core validation rejects malformed game hashes and ordinary out-of-range edges but does not explicitly reject `NaN`. Core salt input has no length limit. The inspector requires a nonempty salt of at most 1,024 UTF-16 code units and a finite edge in `[0,0.999999]`.

**Operator obligations:** keep future hashes and endpoints secret until their rounds end; retain the anchor, index, salt and declared edge; make closed results available; decide wager deadlines and cash-out acceptance on an authoritative server. Neither endpoint reproduction nor a chain-link match proves payout, timing or the acceptance of an action. Galabet Flight uses this endpoint calculation; flight animation and receipt handling do not introduce another GFS calculation version.

Source: [`crash.ts`](../packages/fair/src/crash.ts). See [Crash vectors](../vectors/gfs-1.0-crash.json).

## 6. Records and signatures

### 6.1 Single-player record

The `FairRecord` contract has these fields:

| Field | Meaning |
| --- | --- |
| `spec` | Exactly `GFS/1.0` |
| `profile` | Exactly `single-player` |
| `game` | One of the nine mapper identifiers in §4 |
| `params` | Object containing the round's calculation parameters |
| `serverSeed` | Optional before reveal; required to reproduce the outcome |
| `commitment` | SHA-256 commitment to that seed |
| `clientSeed`, `nonce` | The accepted round's derivation inputs |
| `cursor` | Highest consumed digest index |
| `result` | Number, sorted position array, ordered card array or Plinko object as specified above |
| `at` | Application-supplied Unix milliseconds |
| `signature`, `signer` | Optional Ed25519 signature and public key, carried together |

`at` is included in the signature when present; its accuracy or relationship to commitment publication is not established by recomputing the result. The library's typed record is not a general runtime schema validator.

### 6.2 Canonical JSON

For this contract use plain JSON values: finite binary64 numbers, strings, booleans, null, dense arrays and objects with string keys. Canonical serialization follows the implementation:

1. Serialize strings and numbers with JavaScript `JSON.stringify` semantics; `-0` becomes `0`. Do not use fixed decimal padding. Non-finite numbers throw.
2. Preserve array order and recursively serialize elements.
3. Sort object keys by JavaScript string comparison (`<` / `>`), which is lexicographic **UTF-16 code-unit order**. This is not an assertion of Unicode code-point ordering.
4. Serialize keys as JSON strings and values recursively, using commas and colons with no added whitespace. Do not normalize Unicode.

The helper omits object members with `undefined` values and turns explicit `undefined` array entries into `null`; these are JavaScript conveniences outside the JSON record domain. Sparse arrays, cycles, class instances, functions, symbols and big integers are not portable record inputs. This draft describes the implemented subset; it does not claim complete RFC 8785 validation or compliance.

### 6.3 Payload, hash and Ed25519

```text
payload    = canonicalJson(record with top-level signature and signer removed)
recordHash = hex(SHA-256(UTF8(payload)))
signature  = hex(Ed25519Sign(UTF8(payload), secretKey))
```

All other own enumerable fields, including extra fields, are included in the payload. Ed25519 signs the payload bytes directly, not the hexadecimal record hash. The public key (`signer`) is 32 bytes encoded as 64 lowercase hex characters; the signature is 64 bytes encoded as 128 lowercase hex characters. The signing helper's private-key format is 64 bytes encoded as 128 lowercase hex characters: a 32-byte private seed followed by its 32-byte public key. That private representation is never part of a published record.

A signature verifies against the supplied public key. Establishing which operator owns that key requires a separately trusted publication mechanism. Since `serverSeed` is part of the payload when present, attaching a revealed seed to an already signed pre-reveal record changes both its hash and signed bytes. Preserve the original signed object and its separate reveal evidence, or sign the completed record again; the original signature does not authenticate the modified object.

The core has no equivalent standardized signed Crash/Flight record type. The inspection endpoint accepts supplied Crash/Flight fields for endpoint and link calculations and marks signatures on those records unsupported.

Source: [`record.ts`](../packages/fair/src/record.ts), [`sign.ts`](../packages/fair/src/sign.ts), [`types.ts`](../packages/fair/src/types.ts).

## 7. Verification and limits

For a complete single-player record, a verifier checks the calculation identifier and profile, validates inputs, reproduces the commitment and outcome, compares canonical result encodings, checks the highest consumed cursor, and verifies the signature if one is supplied. Missing required evidence must not be displayed as a complete verification.

`verifyRecord()` is the lower-level typed helper: it checks the spec identifier, revealed seed commitment, result, cursor and optional signature. It does **not** validate `profile`, enforce every field's runtime type, verify timestamps or enforce every parameter bound. It may throw on invalid input. For untrusted pasted records use `inspectRecord()`/`parseInspection()` or equivalent validation before the calculations.

The inspector's input limits are 65,536 UTF-8 bytes and nesting depth at most 12 (root depth zero). It reports individual checks as `matches`, `mismatch`, `not-provided` or `unsupported`, and an overall result of `matches`, `mismatch` or `incomplete`. An unsigned record can reproduce correctly without a signature; that is not authenticated operator identity. Reports retain supplied outcome data and are not a general redaction service.

For Crash, a link check only establishes that a disclosed hash hashes to the supplied adjacent hash. It does not prove that the supplied anchor was publicly committed at an earlier time or that every link of a chain has been examined. For Flight, endpoint checks do not authenticate stakes, cash-out time, accepted multiplier or payout.

The optional `beacon` field mentioned in the type is reserved extension metadata. The current core does not mix it into GFS/1.0 derivation or authenticate its source. The inspector reports beacon validation as unsupported. No implemented GFS/1.1 beacon profile is specified here.

## 8. Conformance

An independent implementation should match the following checked-in vectors without regenerating them to fit its own results:

| File | Coverage |
| --- | --- |
| [`gfs-1.0.json`](../vectors/gfs-1.0.json) | 4 commitments, 24 digests, 12 float streams and 2,240 game cases |
| [`gfs-1.0-crash.json`](../vectors/gfs-1.0-crash.json) | 48 endpoint cases across a 12-link chain, two salts and two edge values |
| [`gfs-1.0-sign.json`](../vectors/gfs-1.0-sign.json) | 2 canonical payload/signature cases |

Signature vectors exercise signing; their example `result` values are not claims that their seed inputs produced those outcomes. All vector seeds and signing keys are public fixtures and must never secure live sessions or operator records.

From the repository root, after installing dependencies:

```sh
node --import tsx scripts/gen-vectors.ts --check
node --import tsx spec/check-spec.ts
```

The first command checks the frozen vectors against the reference source without writing them. The second checks this document's worked fixture and selected implementation-sensitive boundaries. Passing these checks is compatibility evidence, not a security audit, proof of independence or production certification. A port should also test rejected inputs, arithmetic boundaries, multi-digest cursor advancement and record serialization.

This draft deliberately records known boundaries instead of strengthening them silently. Before declaring a final specification, review the safe-integer domain, uniform parameter validation, Unicode input policy, Crash numerical stages and any proposed signed Crash envelope together with the implementation and vectors. A change that alters outcomes or signed encodings requires explicit compatibility review; website edition numbering must not disguise such a change.
