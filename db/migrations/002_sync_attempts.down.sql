-- 002_sync_attempts.down.sql — Rollback the retry audit trail.

DROP TABLE IF EXISTS sync_attempts;
