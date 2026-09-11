# Octaraa Financial Data Sync Engine

A financial data synchronization engine built as a take-home assessment. Implements a
resilient provider sync core with idempotent transaction ingestion, two-tier
retry/backoff, cursor-based resumable sync, and per-account concurrency control —
tested against deterministic mock providers and a real Postgres-backed deployment.

## Quick Start (Mock Providers — No DB Required)

```bash
npm install
npm test        # 57 unit + integration tests, all green
npm run demo     # End-to-end demo against scripted flaky providers
```

This runs the complete sync engine against deterministic mock providers that simulate
rate limits, transient failures, mid-sync crashes, and concurrent syncs. No network,
no database needed.

## Live Setup (Docker Postgres + Express + Cron)

```bash
cp .env.example .env   # Defaults work out of the box for local Docker
npm run setup            # Starts Postgres → applies migrations → seeds test account
npm start                 # Express app + cron-scheduled background sync
```

`npm run setup` = `docker:reset` + `migrate:up` + `seed` — use anytime for a clean slate.

### Available Scripts

| Script | Description |
|--------|-------------|
| `npm run docker:up` | Start Postgres, wait until healthy |
| `npm run docker:down` | Stop Postgres, keep data |
| `npm run docker:reset` | **Drop the volume** and start a fresh Postgres |
| `npm run migrate:up` / `migrate:down` | Apply / roll back schema (versioned) |
| `npm run seed` | Link test account (`finvu` / `finvu-acc-1`) — idempotent |
| `npm run setup` | Full rebuild from nothing: reset + migrate + seed |

For ad-hoc DB inspection, use `psql "$DATABASE_URL"` directly or the API endpoints
below — no separate debug script.

### API Endpoints (when running `npm start`)

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness check |
| `POST /sync/trigger` | Sync now — `{}` for all *due* accounts, or `{ "accountId": "..." }` for one (bypasses backoff) |
| `GET /sync/status?limit=20` | Recent `sync_runs`, newest first, with each account's current retry-backoff state |
| `GET /sync/runs/:runId/attempts` | Every retry attempt inside a run (page, attempt #, outcome, error, backoff delay) |

```bash
curl -X POST http://localhost:3000/sync/trigger -H 'Content-Type: application/json' -d '{}'
curl http://localhost:3000/sync/status
curl http://localhost:3000/sync/runs/1/attempts
```

## Architecture

See `architecture-diagram.md` for the system diagram (Mermaid — target shape at scale,
with the single-process reality called out explicitly) and `technical-note.md` for the
full technical design, including:

- Two-tier retry: per-page (ms) and per-account (min/hr), both jittered exponential
  backoff, sharing one formula (`computeBackoffMs`)
- Idempotent dedupe key: `providerId:accountId:providerTransactionId`, with a fuzzy
  fallback for providers that don't return stable transaction ids
- Resumable sync cursor, persisted only after each page is durably committed
- Per-account concurrency lock (in-memory within a process; a Postgres partial unique
  index enforces the same guarantee across machines)
- Per-attempt audit trail in `sync_attempts` — not just a run's terminal status
- Account-level retry backoff via `consecutive_failures` / `next_retry_at` on
  `provider_accounts`, so a failing account is retried sooner than the next cron tick
  without being hammered every tick either

### What's Implemented

**Core engine** (in-memory, no external services):
- `src/retry.ts` — exponential backoff, honors provider `retryAfterMs`, stops on
  fatal errors
- `src/ingestion/transactionRepository.ts` — idempotent upsert keyed by a stable
  composite key
- `src/sync/syncOrchestrator.ts` — paginates a provider, persists the cursor after
  each page, refuses a second concurrent sync for the same account
- `src/providers/reliableProvider.ts` + `flakyProvider.ts` — deterministic fixture
  providers reproducing rate limits, transient failures, mid-sync crashes
- `src/demo.ts` — runnable end-to-end demo (`npm run demo`)

**Production path** (Docker Postgres + Express + cron):
- `src/ingestion/postgresTransactionRepository.ts` — async Postgres I/O
- `src/sync/postgresSyncStateStore.ts` / `postgresSyncRuns.ts` — cursor + audit
  persistence
- `src/providers/finvuAdapter.ts` — Finvu sandbox provider (mock FIP data, no auth)
- `db/migrations/` — versioned schema with rollback (`migrate:up` / `migrate:down`)
- `src/sync/scheduler.ts` — cron-driven background scheduler, backoff-aware, plus an
  on-demand `triggerNow`
- `src/app.ts` + `src/server.ts` — Express API wired to Postgres, the scheduler, and
  the Finvu adapter; `npm start` is the single entrypoint
- `src/sync/postgresSyncAttempts.ts` + `db/migrations/002_sync_attempts.up.sql` — the
  per-attempt retry audit trail
- `src/db/providerAccounts.ts` + `db/migrations/003_account_retry.up.sql` —
  account-level retry with backoff

### What's Described But Not Implemented

- A durable job queue (SQS/BullMQ) fanning work out to autoscaled workers — today's
  scheduler is single-process, in-process
- A consolidated-data read API (`GET /accounts/:id/transactions` and friends)
- Consent/credential storage and OAuth token lifecycle for a real provider (Finvu's
  sandbox needs none)
- A permanent circuit-breaker for an account failing for a reason backoff can't fix
  (expired token, revoked access) — it currently retries forever at the capped
  interval instead of eventually surfacing as "needs manual reconnect"

See `technical-note.md` §3–4 for the full reasoning.

## Environment

Copy `.env.example` to `.env` and adjust. Never commit `.env`.

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | Postgres connection string (includes password) | `postgresql://postgres:postgres@localhost:5432/octaraa` |
| `POSTGRES_PASSWORD` | Docker Postgres password (must match `DATABASE_URL`) | `postgres` |
| `SYNC_CRON_PATTERN` | Cron expression for scheduled sync | `0 */6 * * *` (every 6 hours) |
| `SYNC_MAX_ATTEMPTS` | Max retry attempts per page | `4` |
| `SYNC_RETRY_BASE_MS` | Base backoff for page retry (ms) | `500` |
| `SYNC_RETRY_MAX_MS` | Max backoff for page retry (ms) | `8000` |
| `ACCOUNT_RETRY_BASE_MS` | Base backoff for a failed account (ms) | `60000` (1 min) |
| `ACCOUNT_RETRY_MAX_MS` | Max backoff for a failed account (ms) | `21600000` (6 hrs) |
| `PORT` | HTTP port for the Express app | `3000` |

### macOS Gotcha

If queries fail with `permission denied for table ...` even as the `postgres`
superuser, you likely have a local Postgres (e.g. Homebrew) on port 5432 shadowing the
Docker container:

```bash
lsof -nP -iTCP:5432 -sTCP:LISTEN
brew services stop postgresql@16  # or whichever version is running
```

This is an environment conflict, not a schema/permissions bug — the two servers have
completely independent role tables.

## Testing

```bash
npm test    # All tests (Jest + ts-jest)
npm run demo # In-memory end-to-end demo
```

## Project Structure

```
src/
├── config.ts                 # Environment config with validation
├── logger.ts                 # Structured JSON logging
├── retry.ts                  # Retry/backoff logic (reusable page- and account-level)
├── types.ts                  # Core interfaces (Provider, Transaction, etc.)
├── app.ts                    # Express app wiring (routes)
├── server.ts                 # Live entrypoint: DB wiring, scheduler, HTTP boot
├── demo.ts                   # In-memory end-to-end demo
├── db/
│   ├── dbClient.ts           # DbClient interface — pg.Pool is adapted to it in server.ts
│   ├── migrate.ts            # Migration runner (up/down, tracked in a migrations table)
│   ├── seed.ts                # Idempotent test account seeding
│   └── providerAccounts.ts   # Account upsert + due-account listing + retry backoff state
├── ingestion/
│   ├── transactionRepository.ts          # Interface + in-memory impl
│   └── postgresTransactionRepository.ts  # Postgres impl
├── sync/
│   ├── syncOrchestrator.ts         # Core sync logic (pagination, cursor, lock)
│   ├── scheduler.ts                 # Cron + on-demand trigger, backoff-aware
│   ├── postgresSyncStateStore.ts   # Cursor persistence
│   ├── postgresSyncRuns.ts         # sync_runs audit
│   └── postgresSyncAttempts.ts     # Per-attempt retry audit trail
└── providers/
    ├── finvuAdapter.ts        # Finvu sandbox adapter
    ├── reliableProvider.ts    # Deterministic success provider
    └── flakyProvider.ts        # Deterministic failure provider (test fixture)

db/migrations/    # Versioned schema — 001 core tables, 002 sync_attempts, 003 account retry
```

## Documentation

- `architecture-diagram.md` — system diagram (Mermaid)
- `technical-note.md` — full technical design, scaling analysis, key decisions

## License

ISC
