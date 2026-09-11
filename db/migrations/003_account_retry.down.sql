-- 003_account_retry.down.sql — Rollback account-level retry backoff state.

DROP INDEX IF EXISTS provider_accounts_next_retry_idx;

ALTER TABLE provider_accounts
  DROP COLUMN IF EXISTS consecutive_failures,
  DROP COLUMN IF EXISTS next_retry_at;
