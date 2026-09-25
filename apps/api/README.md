# api

Galabet Fair API. NestJS on Fastify, Postgres via drizzle, Redis via ioredis.

## Run locally

```bash
# from the repo root
pnpm install
pnpm --filter @galabet/fair build          # the API imports the built library

cd apps/api
cp .env.example .env
docker compose up -d                        # Postgres + Redis
pnpm db:push                                # create tables from src/db/schema.ts
pnpm start:dev                              # http://localhost:3000
```

Smoke test:

```bash
curl http://localhost:3000/api/health
curl -X POST http://localhost:3000/api/verify -H "content-type: application/json" \
  -d '{"game":"dice","serverSeed":"5c1f7d3e8a2b4c6d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d","clientSeed":"galabet","nonce":42}'
curl -X POST http://localhost:3000/api/demo/session
curl http://localhost:3000/badge/example.svg
curl -I http://localhost:3000/api/vectors/gfs-1.0.json
```

## Endpoints in this batch

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | Postgres and Redis status |
| POST | `/api/verify` | Reproduce a result from seeds; returns record and canonical JSON |
| POST | `/api/verify/record` | Verify a full record |
| POST | `/api/demo/session` | New demo seed pair, returns commitment and client seed |
| GET | `/api/demo/session` | Current session view (header `X-Demo-Session`) |
| POST | `/api/demo/client-seed` | Set client seed, resets nonce |
| POST | `/api/demo/bet` | Play a game under the session seeds |
| POST | `/api/demo/rotate` | Reveal the server seed, start a new one |
| GET | `/api/demo/history` | Last records, revealed where possible |
| GET | `/badge/:operator.svg` | Live badge, 60s cache |
| GET | `/api/vectors/gfs-1.0.json` | Published vectors with sha256 header |
| GET | `/api/registry.json` | Registry snapshot |
| GET | `/api/registry/:id` | Operator detail with runs |
| POST | `/api/registry/submissions` | Conformance submission (Turnstile guarded in prod) |
| GET | `/api/registry/disputes` | Public disputes |
| POST | `/api/registry/disputes` | File a dispute with a failing record |

## Domain ownership

A submission returns a `verification` block. The operator must publish it at
`https://<domain>/.well-known/galabet-fair.json` before the conformance runner will execute the run.
Nobody can list a domain they do not control.

## Environment

See `.env.example`. `TURNSTILE_SECRET` empty disables the bot check (local only).
`DEMO_SESSIONS_PER_IP_PER_DAY` caps abuse of the free games. `VECTORS_DIR` overrides where
the vectors file is read from when the API is deployed without the rest of the repo.

Batch 3 adds: notary endpoints, the BullMQ conformance runner and live checks, the crash profile with the WebSocket server, beacon relay.

## Production

`pm2 start ecosystem.config.cjs` after `pnpm build`. Nginx config in `deploy/`.

## Batch 3 endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/beacon/drand/:round` | Cached drand round |
| GET | `/api/beacon/evm/:block` | Cached BSC block hash |
| GET | `/api/notary/key` | Notary public key |
| POST | `/api/notary/commitments` | Escrow (signed by operator) |
| POST | `/api/notary/reveals` | Reveal (signed by operator) |
| GET | `/api/notary/commitments/:hash` | Public lookup with receipt |
| GET | `/api/crash/history` | Last crash games with hashes |
| GET | `/api/crash/chain/:id` | Chain info: terminating hash, salt block, played count |
| WS | `/ws/crash` | Round events: waiting, tick, crash |

## The worker

`pnpm worker:dev` alongside `start:dev`. It runs the conformance queue, the six-hourly live checks
and the crash round loop. Exactly one instance in production (see `ecosystem.config.cjs`).
Generate the notary key once with:

```bash
node -e "import('@galabet/fair').then(async m=>{const k=await m.generateKeyPair();console.log('NOTARY_SIGNING_KEY='+k.secretKey)})"
```

Operator integration contract: `src/notary/README.md`.

## Batch 4: operations and playable games

| Area | What |
|---|---|
| Playable demo | `/api/demo/games/*`: chips wallet, dice, limbo, roulette, wheel, plinko, keno, stateful mines. Payout tables in `src/demo/payouts.ts`, RTP unit tested |
| Crash bets | `POST /api/crash/bet` during the waiting window, `POST /api/crash/cashout` while running, auto cashout settled by the engine, results in the `crash` event |
| Admin | `/api/admin/*` with `Authorization: Bearer ADMIN_TOKEN`: list operators, set status, notary flag, rerun, disputes, audit log |
| Notifications | Signed webhooks (`X-Galabet-Signature`, notary key) to the operator's `webhookUrl`, optional email via `SMTP_URL` |
| Audit log | Every admin action, run result and revocation in `audit_log` |
| OpenAPI | `/api/openapi.json` generated from the zod schemas |
| Metrics | `/metrics` for Prometheus, scrape from localhost only |
| Logging | pino with request ids (`x-request-id`, Cloudflare ray id when present), one error shape from the global filter |
| Errors | Optional Sentry via `SENTRY_DSN` |
| Migrations | `pnpm db:generate` then `pnpm db:migrate` in production; `db:push` for local |
| Vectors | `gfs-1.0-crash.json` and `gfs-1.0-sign.json` alongside the main file, all served under `/api/vectors/` |
| CI | `.github/workflows/ci.yml` runs library tests, vectors check, typecheck, API tests, boots the API against Postgres and Redis and hits it |
| Deploy | `.github/workflows/deploy.yml` on a `v*` tag: build, rsync, migrate, `pm2 startOrReload` |
| Backups | `deploy/backup.sh` nightly pg_dump plus Redis snapshot shipped with rclone, 30 day retention |
| Smoke | `deploy/smoke.sh https://galabets.org` after any deploy |

Never expose `/metrics` or `/api/admin` through Nginx to the public. Add in the server block:

```nginx
location ~ ^/(metrics|api/admin)(/|$) { allow 127.0.0.1; deny all; proxy_pass http://galabet_api; }
```

## Idempotency

Every state-changing POST accepts an `Idempotency-Key` header (8 to 128 chars, a UUID is fine). The first
request runs; its response is stored for 24 hours, scoped to the demo session or operator; a retry with
the same key gets the stored response back with `Idempotency-Replayed: true` and never runs the handler
again. The same key with a different body is refused with 422. A key whose first request is still running
returns 409. If the handler throws, the key is released so the same attempt can be retried.

The site sends a fresh key on every POST and retries once on network failure. Operators should do the
same for bets, notary calls and submissions.

Natively idempotent regardless of the header: notary escrow (same operator, same hash returns the original
receipt), notary reveal (same seed returns the stored result), registry submission (a pending run for the
same operator and vectors is returned rather than queued again), queue jobs (fixed job ids). Webhook
payloads carry an `id`; store it and drop repeats.
