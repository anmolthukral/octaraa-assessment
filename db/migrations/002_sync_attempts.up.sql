-- 002_sync_attempts.up.sql — Per-attempt retry audit trail.
--
-- sync_runs records one row per whole account sync (start/finish/status).
-- sync_attempts records one row per *retry attempt* inside that run — every
-- page fetch, whether it succeeded outright, is being retried, or gave up —
-- so a failure can be diagnosed from "which page, which attempt, which
-- error, after how long" instead of just the run's terminal status.

CREATE TABLE IF NOT EXISTS sync_attempts (
  id             BIGSERIAL PRIMARY KEY,
  sync_run_id    BIGINT NOT NULL REFERENCES sync_runs (id) ON DELETE CASCADE,
  page_index     INTEGER NOT NULL,
  attempt_number INTEGER NOT NULL,
  outcome        TEXT NOT NULL, -- 'success' | 'retrying' | 'gave_up'
  error_kind     TEXT,          -- null on success
  error_message  TEXT,
  delay_ms       INTEGER,       -- backoff before the next attempt, null unless 'retrying'
  attempted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_attempts_run_idx
  ON sync_attempts (sync_run_id, page_index, attempt_number);
