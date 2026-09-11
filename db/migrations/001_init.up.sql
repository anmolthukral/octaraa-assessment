-- 001_init.up.sql — Initialize core schema
-- Tables: provider_accounts, transactions, sync_runs

CREATE TABLE IF NOT EXISTS provider_accounts (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  provider_id TEXT NOT NULL,
  external_account_ref TEXT NOT NULL,
  last_sync_cursor TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, external_account_ref)
);

CREATE TABLE IF NOT EXISTS transactions (
  id BIGSERIAL PRIMARY KEY,
  provider_account_id BIGINT NOT NULL REFERENCES provider_accounts (id) ON DELETE CASCADE,
  provider_transaction_id TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  currency TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  posted_at TIMESTAMPTZ NOT NULL,
  dedupe_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_account_id, provider_transaction_id)
);

CREATE INDEX IF NOT EXISTS transactions_account_posted_idx
  ON transactions (provider_account_id, posted_at);

CREATE TABLE IF NOT EXISTS sync_runs (
  id BIGSERIAL PRIMARY KEY,
  provider_account_id BIGINT NOT NULL REFERENCES provider_accounts (id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  pages_processed INTEGER NOT NULL DEFAULT 0,
  new_records INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS sync_runs_single_running_idx
  ON sync_runs (provider_account_id) WHERE status = 'RUNNING';

CREATE INDEX IF NOT EXISTS sync_runs_account_started_idx
  ON sync_runs (provider_account_id, started_at DESC);

-- Migration tracking table
CREATE TABLE IF NOT EXISTS migrations (
  version INT PRIMARY KEY,
  name TEXT NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
