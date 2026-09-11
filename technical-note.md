# Octaraa Financial Data Sync Engine — Technical Note

## 1. Overview

Octaraa aggregates a user's financial data from multiple external providers (banks,
aggregators such as Plaid or Yodlee) into one consolidated, queryable view. Each user
may hold several accounts across different providers, and the system must refresh that
data periodically while tolerating everything providers do in practice: respond slowly,
go temporarily unavailable, enforce rate limits, return the same records more than
once, return records out of order, or fail halfway through a sync.

What is built is the failure-handling core of that system — a provider sync engine
plus transaction ingestion with idempotent dedup (`src/`), covered by 59 tests and a
runnable end-to-end demo (`npm run demo`) — plus a working single-process production
path on top of it: a cron scheduler that backs off failing accounts with jittered
exponential delay, Postgres-backed stores, a real (sandbox) provider adapter (Finvu), a
per-attempt retry audit trail (`sync_attempts`), and a thin Express API (`GET /health`,
`POST /sync/trigger`, `GET /sync/status`, `GET /sync/runs/:id/attempts`; see §5). The
uniform `Provider` interface, the retry/backoff policy (both per-page and per-account),
the dedupe-key design, the resumable sync cursor, and the per-account concurrency lock
are all implemented and proven by tests, both against in-memory fixtures and against
real Postgres. What is described but deliberately not implemented is the *distributed*
form of this: a durable job queue fanning work out to autoscaled workers, a
consolidated-data read API (`GET /accounts/:id/transactions` and friends), and the
credential/consent lifecycle a real OAuth-based provider would need — including a
permanent circuit-breaker for an account that's failing for a reason backoff can't
fix (expired token, revoked access), which is a distinct problem from backoff itself
(§3–4 cover why and how). The in-memory repository and sync-state store used in tests
sit behind the same interfaces the Postgres implementations satisfy, so that swap is
already proven, not theoretical.

## 2. Architecture

*What's below is the target shape at scale. What's actually running (§5) is its
single-process form: one cron scheduler, iterating accounts in-process and calling
the orchestrator directly — no queue, no separate workers yet. §3 covers exactly
where that in-process loop stops being enough and becomes a real queue.*

**Components.** A Sync Scheduler (cron plus on-demand user triggers) enqueues sync
jobs. Sync Orchestrator workers (one run per account at a time) drive a Provider
Adapter through a uniform paginated interface, wrapping each page fetch in a shared
retry handler. Ingested pages land in the Transaction Repository (Postgres), raw
provider payloads are retained in a Raw Payload Store for audit and replay, and sync
progress lives in Sync State plus an append-only `sync_runs` audit table. A thin API
layer serves consolidated data and accepts manual sync triggers — implemented today
as `POST /sync/trigger`; a `GET` route for consolidated transaction data is the
described-but-not-built half of that layer. Provider Adapters (one per external
provider) translate proprietary APIs into the uniform interface, so adding a provider
means writing one adapter, never touching orchestration.

**Data flow.** Trigger (schedule tick or user action) → Scheduler enqueues a job per
account → Orchestrator worker claims it (per-account lock; a duplicate run for an
account already syncing is skipped) → Provider Adapter fetches one page →
retry/backoff handler absorbs transient and rate-limit failures → page upserted by
stable dedupe key → Postgres commits, then the pagination cursor is persisted →
repeat until `hasMore` is false → run recorded as completed/failed in `sync_runs` →
API serves the consolidated rows.

**Auditability and correctness.** The brief names auditability alongside correctness,
and the design treats them as the same mechanism: every ingested page keeps its raw
provider payload (referenced by `raw_payload_ref`) alongside the normalized row, every
run appends to `sync_runs` with pages processed, new records, and the terminal error
if any, and — implemented, not just described — every individual retry attempt inside
that run appends to `sync_attempts`: which page, which attempt number, whether it
succeeded, is retrying, or gave up, the error kind/message, and the backoff delay
(`src/retry.ts`'s `onAttempt` hook, wired in `src/server.ts`; queryable via
`GET /sync/runs/:runId/attempts`). A `FAILED` run's terminal error tells you *that*
it failed; `sync_attempts` tells you exactly *where* — which page, after how many
tries, against which specific error — without needing raw provider payloads or log
correlation to reconstruct it. Any user-visible figure can therefore be traced back to
the exact provider response and the exact run that wrote it, and a dedupe-key
migration or a suspected provider format change can be validated by replaying raw
payloads through the new logic and diffing before cutover. Nothing is ever updated in
place without that trail — corrections are new writes, so the history of what the
user saw and when is itself queryable.

**Postgres schema.**

- `provider_accounts(id, user_id, provider_id, external_account_ref, encrypted_credentials_ref, consecutive_failures, next_retry_at, created_at)` — one row per user account per provider; all reads scoped by `user_id`. `consecutive_failures`/`next_retry_at` are **implemented** — account-level retry backoff state, mirroring the existing `last_sync_cursor` pattern of mutable "where things stand" state on this same row (*production target*: `encrypted_credentials_ref` is not — no credentials to store while Finvu needs none).
- `transactions(id, provider_account_id, provider_transaction_id, amount_cents, currency, description, posted_at, dedupe_key, raw_payload_ref, UNIQUE(provider_account_id, provider_transaction_id))` — the unique constraint is the database-level backstop behind the application dedupe key, so even a bug in the worker cannot create a duplicate. (*production target*: `raw_payload_ref` isn't in the implemented migration either — see §1.)
- `sync_runs(id, provider_account_id, started_at, finished_at, status, pages_processed, new_records, error)` — **implemented as-is.** Partial unique index on `(provider_account_id) WHERE status = 'RUNNING'` enforces at most one running sync per account even across machines (the in-memory `Set` in `syncOrchestrator.ts` is the single-process stand-in for the same guarantee within one process).
- `sync_attempts(id, sync_run_id, page_index, attempt_number, outcome, error_kind, error_message, delay_ms, attempted_at)` — **implemented as-is.** One row per retry attempt; `ON DELETE CASCADE` from `sync_runs`, so rolling back or pruning a run cleans up its attempt trail automatically.

**Retries and backoff — two tiers.** Every page fetch runs inside `withRetry`:
rate-limit errors wait exactly the provider-supplied `retryAfterMs` (no guessing, no
hammering), transient errors wait an exponential backoff with ±20% jitter (so a fleet
of workers does not retry in lockstep), and fatal errors (bad credentials, malformed
requests) are never retried. After `maxAttempts` the run fails with the cursor left at
the last committed page, so the next run resumes rather than restarts.

That's retry *within* one sync. Above it, a whole account whose sync just failed gets
the same exponential+jitter treatment at a different timescale: `consecutive_failures`
and `next_retry_at` on `provider_accounts` (§ schema above) push the account's next
eligible sync out by `computeBackoffMs(consecutive_failures, ACCOUNT_RETRY_BASE_MS,
ACCOUNT_RETRY_MAX_MS)` — the identical formula `withRetry` uses, just reused at
minutes/hours instead of milliseconds (`src/db/providerAccounts.ts`). The cron
scheduler only lists accounts that are due (`listDueAccountsForProvider`); a success
resets the streak to zero. This closes the gap a single-tier retry leaves open: without
it, an account failing every 6-hour tick either gets hammered every tick (no backoff) or
waits a fixed 6 hours regardless of how many times it's already failed (no escalation);
with it, failure 1 waits ~1 minute, failure 2 ~2, and so on up to the cap — diagnosable
in real time via `sync_attempts`, and an operator can always force an immediate retry
of one account with `POST /sync/trigger {"accountId": "..."}`, which bypasses backoff
entirely. What this does *not* do is stop retrying — an account failing for a reason
backoff can't fix (revoked consent, expired token) just retries forever at the capped
interval; see §4's credential-lifecycle point for the piece still missing.

**Dedup.** The primary key is the stable composite
`providerId:accountId:providerTransactionId`, upserted idempotently — re-fetching an
overlapping or reordered page is a no-op. For providers that do not return stable
transaction ids, the fallback is a fuzzy key: a hash of
`accountId + amount + postedAt + description`. The trade-off is explicit: fuzzy keys
can collide on genuinely distinct same-day, same-amount transactions with identical
descriptions (daily coffee purchases are the classic case), either merging two real
transactions or requiring manual review queues. Stable provider ids are therefore
preferred wherever offered, and the fuzzy path is quarantined behind a per-provider
flag with a monitored collision rate, not applied blindly.

**Monitoring and logging.** The implementation emits one JSON line per event
(`sync_completed`, `retrying`, `sync_failed`, …) with no `console.log` anywhere — the
contract a log aggregator can parse. Production adds metrics: sync success rate per
provider, p50/p95 sync duration, retry rate per error kind, and dedup-collision rate;
and alerts: a streak of `sync_runs.status = 'failed'` for one provider (provider
outage or revoked credentials), and a rising rate-limit-hit ratio (our request budget
needs renegotiation or throttling).

**Security.** OAuth tokens and provider credentials live in a secrets manager with
KMS envelope encryption and are fetched at sync time — never stored beside the data,
never logged (structured log fields are allow-listed, and credential fields are
excluded by construction). Tenancy is enforced by scoping every query on `user_id`
(plus Postgres row-level security as a second barrier). All provider and client
traffic uses TLS. Database roles follow least privilege: the sync worker role can
write `transactions`/`sync_runs` but cannot read the credentials table; the read-API
role can read consolidated data but cannot write sync state.

## 3. Scaling: 10K → 1M → 10M users

| Stage | What breaks first | Response |
|---|---|---|
| 10K users | Single-node Postgres write throughput during overlapping scheduled syncs; the single scheduler loop starts missing its refresh windows | Connection pooling, one read replica for the API, staggered per-account schedules so syncs spread across the window |
| 1M users | `transactions` table size and write contention; one scheduler cannot fan out hundreds of thousands of jobs on time | Partition `transactions` by `provider_account_id` hash (or by month for time-range queries); replace the scheduler loop with a durable queue (SQS/BullMQ) and autoscaled workers; shard scheduling by provider so one slow provider cannot starve the others |
| 10M users | Provider rate limits become the binding constraint — thousands of workers hitting the same provider API for different accounts get the whole integration throttled; downstream consumers polling Postgres add read load | Per-provider rate-limit budgets via a token bucket in Redis shared across all workers (the per-account lock is necessary but no longer sufficient); an event bus/ledger of committed transactions so downstream consumers subscribe instead of polling |

What changes structurally is the execution substrate: in-process locks become database
constraints, the scheduler loop becomes a queue with autoscaling workers, and
Polling-Postgres becomes publish-on-commit. What stays simple on purpose is the
dedupe-key design and the `Result`-based error handling — those are pure logic with no
scaling dimension, so only their storage backend changes, never their shape.

## 4. Key decisions (production concerns)

1. **Idempotency and dedup correctness under partial failure and replay.** A wrong
   dedupe key silently corrupts users' financial totals — balances drift, duplicates
   inflate spending — and unlike a crash, nothing alerts on it. That makes this the
   worst possible failure mode for this domain. It needs a migration/backfill plan
   for key-format changes and a monitored dedup-collision rate before launch, not
   just a unit test.
2. **Per-provider rate-limit coordination across many concurrent workers.** The
   in-memory lock in this implementation only stops two syncs of the *same account*.
   At real scale, thousands of workers sync *different* accounts against the *same*
   provider simultaneously, and without a shared provider-scoped budget the provider
   throttles or bans the whole integration. The Redis token bucket above is not an
   optimization — it is a launch requirement.
3. **Credential and token lifecycle, including re-auth flows.** OAuth tokens expire
   and users revoke access; a sync failing on an expired token must surface as
   "reconnect this account" rather than masquerading as a transient outage and
   retrying forever. That path spans provider error taxonomy, user-facing UX, and
   secure token storage, and it is easy to under-scope because the happy path never
   exercises it.

## 5. Getting Started — Finvu Sandbox + Docker Postgres

Finvu's free sandbox returns mock FIP data with no authentication, so this is the
fastest path from "running unit tests on mock providers" to "a real HTTP service
syncing into a real database":

1. **Start Postgres**: `cp .env.example .env && docker-compose up -d`
2. **Apply migrations**: `npm run migrate:up` (versioned, rollback with `migrate:down`;
   creates `provider_accounts`, `transactions`, `sync_runs`, `migrations`).
3. **Link a test account**:
   ```sql
   INSERT INTO provider_accounts (provider_id, external_account_ref)
   VALUES ('finvu', 'finvu-acc-1');
   ```
4. **Start the service**: `npm start` boots an Express app (`src/server.ts`) with a
   cron-scheduled background sync (`SYNC_CRON_PATTERN`, default every 6 hours) plus:
   - `GET /health` — liveness check
   - `POST /sync/trigger` — sync now, optionally `{ "accountId": "..." }` for one account
   - `GET /sync/status?limit=20` — recent `sync_runs`, newest first

Full details: see `docs/finvu-setup-guide.md`.
