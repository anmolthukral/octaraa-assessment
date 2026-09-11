import { DbClient } from '../db/dbClient';
import { RetryAttemptInfo } from '../retry';

/**
 * Per-attempt retry audit trail backing `sync_attempts`. One row per page
 * fetch attempt inside a sync run — see db/migrations/002_sync_attempts.up.sql.
 */
export const recordSyncAttempt = async (
  db: DbClient,
  runId: number,
  pageIndex: number,
  info: RetryAttemptInfo,
): Promise<void> => {
  await db.query(
    `INSERT INTO sync_attempts
       (sync_run_id, page_index, attempt_number, outcome, error_kind, error_message, delay_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      runId,
      pageIndex,
      info.attempt,
      info.outcome,
      info.error?.kind ?? null,
      info.error?.message ?? null,
      info.delayMs ?? null,
    ],
  );
};

export interface SyncAttemptSummary {
  id: number;
  pageIndex: number;
  attemptNumber: number;
  outcome: string;
  errorKind: string | null;
  errorMessage: string | null;
  delayMs: number | null;
  attemptedAt: string;
}

/** Full attempt trail for one sync run, in the order they happened. */
export const listAttemptsForRun = async (db: DbClient, runId: number): Promise<SyncAttemptSummary[]> => {
  const result = await db.query(
    `SELECT id, page_index, attempt_number, outcome, error_kind, error_message, delay_ms, attempted_at
     FROM sync_attempts
     WHERE sync_run_id = $1
     ORDER BY page_index ASC, attempt_number ASC`,
    [runId],
  );
  return result.rows.map((row) => ({
    id: Number(row['id']),
    pageIndex: Number(row['page_index']),
    attemptNumber: Number(row['attempt_number']),
    outcome: String(row['outcome']),
    errorKind: row['error_kind'] ? String(row['error_kind']) : null,
    errorMessage: row['error_message'] ? String(row['error_message']) : null,
    delayMs: row['delay_ms'] !== null && row['delay_ms'] !== undefined ? Number(row['delay_ms']) : null,
    attemptedAt: String(row['attempted_at']),
  }));
};
