# Operator integration: registry, notary and live checks

## 1. The well-known file

Publish `https://<your-domain>/.well-known/galabet-fair.json`:

```json
{
  "operatorId": "your-slug",
  "token": "<token returned by POST /api/registry/submissions>",
  "verifyUrl": "https://api.your-domain/fair/verify",
  "commitmentsUrl": "https://api.your-domain/fair/commitments",
  "publicKey": "<your Ed25519 public key, 64 hex>"
}
```

## 2. verifyUrl contract (conformance runner)

`POST verifyUrl` with `{ game, params, serverSeed, clientSeed, nonce }` must return `{ result, cursor }`
exactly as `@galabet/fair` `play()` would. The runner samples 200 published vectors. Any mismatch fails the run.

## 3. commitmentsUrl contract (live checks)

`GET commitmentsUrl` returns up to 500 recent entries:

```json
[{ "commitment": "<64 hex>", "publishedAt": "2026-09-17T10:00:00Z", "serverSeed": "<64 hex, once revealed>" }]
```

The runner records commitments the first time it sees them and checks the reveal on a later pass.
Three bad reveals revoke the badge.

## 4. Notary (optional, the paid tier)

Sign each request body with your Ed25519 key. Headers: `X-Operator-Id`, `X-Operator-Signature`
(hex signature over the canonical JSON of the body). Bodies carry `at` (unix ms) and are rejected
outside a five minute window.

```
POST /api/notary/commitments   { "hash": "<commitment>", "at": 1726567890000 }
POST /api/notary/reveals       { "hash": "<commitment>", "serverSeed": "<seed>", "at": 1726570000000 }
GET  /api/notary/commitments/:hash
GET  /api/notary/key
```

The escrow response is a receipt signed by the notary key. Show it to players; anyone can check it
against `GET /api/notary/key`.
