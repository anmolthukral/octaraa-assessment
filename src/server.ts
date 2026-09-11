import { Pool } from 'pg';
import { loadConfig } from './config';
import { createLogger, runLeaf } from './logger';
import { DbClient, DbRow } from './db/dbClient';
import { listDueAccountsForProvider, recordAccountSyncSuccess, recordAccountSyncFailure } from './db/providerAccounts';
import { createPostgresTransactionRepository } from './ingestion/postgresTransactionRepository';
import { createFinvuProvider } from './providers/finvuAdapter';
import { createSyncOrchestrator, SyncResult } from './sync/syncOrchestrator';
import { createPostgresSyncStateStore } from './sync/postgresSyncStateStore';
import { finishSyncRun, startSyncRun, listRecentSyncRuns } from './sync/postgresSyncRuns';
import { recordSyncAttempt, listAttemptsForRun } from './sync/postgresSyncAttempts';
import { createScheduler } from './sync/scheduler';
import { createApp } from './app';

/**
 * Live entrypoint: Finvu sandbox → Postgres, wrapped in an Express app.
 *
 * The cron scheduler (SYNC_CRON_PATTERN, default every 6 hours) re-syncs
 * every *due* linked account in the background — one that failed backs off
 * with jittered exponential delay (ACCOUNT_RETRY_BASE_MS/MAX_MS) rather than
 * waiting for the next full tick or being hammered every tick either. The
 * HTTP server exposes GET /health, POST /sync/trigger (an explicit accountId
 * bypasses backoff), GET /sync/status, and GET /sync/runs/:id/attempts.
 *
 * Run with: npm start   (requires DATABASE_URL, see .env.example)
 */
const PROVIDER_ID = 'finvu';

const main = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger();
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const pool = new Pool({ connectionString: config.databaseUrl });
  const db: DbClient = {
    query: async (text, params) => {
      const result = await pool.query(text, params);
      return { rows: result.rows as DbRow[], rowCount: result.rowCount ?? 0 };
    },
  };

  const repository = createPostgresTransactionRepository(db, PROVIDER_ID);
  const stateStore = createPostgresSyncStateStore(db, PROVIDER_ID);
  const provider = createFinvuProvider(PROVIDER_ID, { logger });
  const orchestrator = createSyncOrchestrator(
    provider,
    repository,
    stateStore,
    {
      maxAttempts: config.syncMaxAttempts,
      baseDelayMs: config.syncRetryBaseMs,
      maxDelayMs: config.syncRetryMaxMs,
      sleep,
    },
    logger,
    (runId, pageIndex, info) => recordSyncAttempt(db, runId, pageIndex, info),
  );

  const runAccount = async (accountId: string): Promise<SyncResult> => {
    const runId = await startSyncRun(db, PROVIDER_ID, accountId);
    if (runId === null) {
      logger.info('sync_skipped_cross_worker', { accountId });
      return { status: 'skipped', reason: 'already_in_progress' };
    }
    const result = await orchestrator.runSync(accountId, runId);

    // Record backoff state BEFORE finishSyncRun — that call flips sync_runs
    // out of RUNNING, releasing the cross-machine lock on this account. A
    // second worker could otherwise start syncing it and race the
    // read-then-write inside recordAccountSyncFailure.
    if (result.status === 'completed') {
      await recordAccountSyncSuccess(db, PROVIDER_ID, accountId);
    } else if (result.status === 'failed') {
      await recordAccountSyncFailure(db, PROVIDER_ID, accountId, {
        baseDelayMs: config.accountRetryBaseMs,
        maxDelayMs: config.accountRetryMaxMs,
      });
    }
    await finishSyncRun(db, runId, result);
    return result;
  };

  const scheduler = createScheduler({
    // Backoff-aware: an account mid-cooldown is skipped until it's due.
    // An explicit accountId (POST /sync/trigger with a body) bypasses this
    // entirely — the scheduler never calls listAccounts for that path.
    listAccounts: () => listDueAccountsForProvider(db, PROVIDER_ID),
    runAccount,
    cronPattern: config.syncCronPattern,
    logger,
  });
  scheduler.start();

  const app = createApp({
    scheduler,
    listRecentRuns: (limit) => listRecentSyncRuns(db, PROVIDER_ID, limit),
    listAttempts: (runId) => listAttemptsForRun(db, runId),
    logger,
  });

  const httpServer = app.listen(config.port, () => {
    logger.info('server_started', { port: config.port, cronPattern: config.syncCronPattern });
  });

  const shutdown = (): void => {
    scheduler.stop();
    httpServer.close();
    void pool.end();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

runLeaf(main);
