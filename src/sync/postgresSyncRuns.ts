import { SyncResult } from './syncOrchestrator';
import { DbClient } from '../db/dbClient';
import { ensureProviderAccount } from '../db/providerAccounts';

/**
 * Append-only `sync_runs` audit around each orchestrated run.
 *
 * startSyncRun inserts a RUNNING row; the partial unique index rejects a
 * second RUNNING row for the same account, which is the cross-machine
 * backstop behind the orchestrator's in-memory lock — null means "another
 * worker owns this account right now". finishSyncRun closes the row the
 * orchestrator's result describes.
 */
export const startSyncRun = async (
  db: DbClient,
  providerId: string,
  accountId: string,
): Promise<number | null> => {
  const accountRowId = await ensureProviderAccount(db, providerId, accountId);
  const result = await db.query(
    `INSERT INTO sync_runs (provider_account_id, status)
     VALUES ($1, 'RUNNING')
     ON CONFLICT (provider_account_id) WHERE status = 'RUNNING' DO NOTHING
     RETURNING id`,
    [accountRowId],
  );
  const row = result.rows[0];
  return row ? Number(row['id'] ?? 0) : null;
};

export interface SyncRunSummary {
  id: number;
  accountId: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  pagesProcessed: number;
  newRecords: number;
  error: string | null;
  /** This account's current retry backoff state (src/db/providerAccounts.ts). */
  consecutiveFailures: number;
  nextRetryAt: string | null;
}

/** Most recent sync_runs for a provider, newest first — backs GET /sync/status. */
export const listRecentSyncRuns = async (
  db: DbClient,
  providerId: string,
  limit: number,
): Promise<SyncRunSummary[]> => {
  const result = await db.query(
    `SELECT sr.id, pa.external_account_ref AS account_id, sr.status, sr.started_at,
            sr.finished_at, sr.pages_processed, sr.new_records, sr.error,
            pa.consecutive_failures, pa.next_retry_at
     FROM sync_runs sr
     JOIN provider_accounts pa ON pa.id = sr.provider_account_id
     WHERE pa.provider_id = $1
     ORDER BY sr.started_at DESC
     LIMIT $2`,
    [providerId, limit],
  );
  return result.rows.map((row) => ({
    id: Number(row['id']),
    accountId: String(row['account_id']),
    status: String(row['status']),
    startedAt: String(row['started_at']),
    finishedAt: row['finished_at'] ? String(row['finished_at']) : null,
    pagesProcessed: Number(row['pages_processed']),
    newRecords: Number(row['new_records']),
    error: row['error'] ? String(row['error']) : null,
    consecutiveFailures: Number(row['consecutive_failures'] ?? 0),
    nextRetryAt: row['next_retry_at'] ? String(row['next_retry_at']) : null,
  }));
};

export const finishSyncRun = async (db: DbClient, runId: number, result: SyncResult): Promise<void> => {
  if (result.status === 'skipped') {
    await db.query(`DELETE FROM sync_runs WHERE id = $1`, [runId]);
    return;
  }
  await db.query(
    `UPDATE sync_runs
     SET finished_at = now(), status = $1, pages_processed = $2, new_records = $3, error = $4
     WHERE id = $5`,
    [
      result.status === 'completed' ? 'COMPLETED' : 'FAILED',
      result.pagesProcessed,
      result.newRecords,
      result.status === 'failed' ? JSON.stringify(result.error) : null,
      runId,
    ],
  );
};
