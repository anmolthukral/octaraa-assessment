import { DbClient, numberOf, textOf } from './dbClient';
import { computeBackoffMs } from '../retry';

/**
 * Account rows backing the live sync.
 *
 * `provider_accounts.external_account_ref` is the `accountId` the sync
 * engine passes around to a provider adapter's `fetchTransactions`.
 */
export const ensureProviderAccount = async (
  db: DbClient,
  providerId: string,
  externalRef: string,
): Promise<number> => {
  // DO UPDATE (a no-op — re-assigns the same value) rather than DO NOTHING so
  // RETURNING always yields a row, insert or conflict. One round trip instead
  // of insert-then-fallback-select. Hot path: called on every page upsert,
  // every cursor save, and every run start.
  const result = await db.query(
    `INSERT INTO provider_accounts (provider_id, external_account_ref)
     VALUES ($1, $2)
     ON CONFLICT (provider_id, external_account_ref)
     DO UPDATE SET provider_id = EXCLUDED.provider_id
     RETURNING id`,
    [providerId, externalRef],
  );
  const row = result.rows[0];
  if (!row) throw new Error('ensureProviderAccount: upsert returned no row');
  return numberOf(row, 'id');
};

/**
 * Account ids currently eligible to sync: never failed, or their retry
 * backoff window has elapsed. This is what the cron scheduler (and a
 * no-accountId "sync everyone" trigger) actually iterates — an account
 * mid-backoff is skipped until it's due, rather than hammered every tick.
 */
export const listDueAccountsForProvider = async (db: DbClient, providerId: string): Promise<string[]> => {
  const result = await db.query(
    `SELECT external_account_ref FROM provider_accounts
     WHERE provider_id = $1 AND (next_retry_at IS NULL OR next_retry_at <= now())
     ORDER BY id ASC`,
    [providerId],
  );
  return result.rows.map((row) => textOf(row, 'external_account_ref'));
};

/** Sync succeeded: clear any backoff state so the account is due normally. */
export const recordAccountSyncSuccess = async (
  db: DbClient,
  providerId: string,
  externalRef: string,
): Promise<void> => {
  await db.query(
    `UPDATE provider_accounts SET consecutive_failures = 0, next_retry_at = NULL
     WHERE provider_id = $1 AND external_account_ref = $2`,
    [providerId, externalRef],
  );
};

/**
 * Sync failed: bump the consecutive-failure streak and push next_retry_at
 * out with exponential backoff (same formula as page-level retry, just on a
 * minutes/hours scale — see computeBackoffMs). Two round trips (read streak,
 * then write) rather than computing the jittered delay in SQL; this runs
 * once per whole-account sync, not per page, so the extra round trip is
 * immaterial. Must be called (like recordAccountSyncSuccess) before
 * finishSyncRun releases the cross-machine RUNNING lock on this account —
 * see the ordering note in src/server.ts's runAccount — otherwise a second
 * worker could race this read-then-write and undercount the streak.
 */
export const recordAccountSyncFailure = async (
  db: DbClient,
  providerId: string,
  externalRef: string,
  backoff: { baseDelayMs: number; maxDelayMs: number },
): Promise<void> => {
  const existing = await db.query(
    `SELECT consecutive_failures FROM provider_accounts WHERE provider_id = $1 AND external_account_ref = $2`,
    [providerId, externalRef],
  );
  const previousFailures = existing.rows[0] ? numberOf(existing.rows[0], 'consecutive_failures') : 0;
  const attempt = previousFailures + 1;
  const delayMs = computeBackoffMs(attempt, backoff.baseDelayMs, backoff.maxDelayMs);

  await db.query(
    `UPDATE provider_accounts
     SET consecutive_failures = $3, next_retry_at = now() + ($4 || ' milliseconds')::interval
     WHERE provider_id = $1 AND external_account_ref = $2`,
    [providerId, externalRef, attempt, delayMs],
  );
};
