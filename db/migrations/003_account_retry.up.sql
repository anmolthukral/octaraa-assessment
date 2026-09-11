-- 003_account_retry.up.sql — Account-level retry backoff state.
--
-- sync_attempts (002) audits retries *inside* one run. This tracks retry
-- *scheduling* across runs: how many whole-account syncs have failed in a
-- row, and when this account is next eligible to be picked up again.
-- Mirrors the existing last_sync_cursor column on this same table — mutable
-- "where things stand" state, cheap to query per scheduler tick, with the
-- durable history still fully reconstructable from sync_runs/sync_attempts.

ALTER TABLE provider_accounts
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS provider_accounts_next_retry_idx
  ON provider_accounts (provider_id, next_retry_at);
