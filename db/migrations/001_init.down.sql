-- 001_init.down.sql — Rollback core schema

DROP TABLE IF EXISTS migrations;
DROP TABLE IF EXISTS sync_runs;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS provider_accounts;
