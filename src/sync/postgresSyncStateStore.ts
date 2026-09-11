import { SyncCursor } from '../types';
import { SyncStateStore } from './syncOrchestrator';
import { DbClient, textOf } from '../db/dbClient';
import { ensureProviderAccount } from '../db/providerAccounts';

/**
 * Postgres-backed SyncStateStore.
 *
 * The resume cursor lives on the account row and is overwritten only after
 * a page is durably ingested (the orchestrator guarantees the ordering), so
 * crash recovery behaves exactly like the in-memory version.
 */
export const createPostgresSyncStateStore = (db: DbClient, providerId: string): SyncStateStore => ({
  getCursor: async (accountId: string): Promise<SyncCursor> => {
    const accountRowId = await ensureProviderAccount(db, providerId, accountId);
    const result = await db.query(`SELECT last_sync_cursor FROM provider_accounts WHERE id = $1`, [accountRowId]);
    const row = result.rows[0];
    if (!row) return null;
    const cursor = textOf(row, 'last_sync_cursor');
    return cursor === '' ? null : cursor;
  },

  setCursor: async (accountId: string, cursor: SyncCursor): Promise<void> => {
    const accountRowId = await ensureProviderAccount(db, providerId, accountId);
    await db.query(`UPDATE provider_accounts SET last_sync_cursor = $1 WHERE id = $2`, [cursor, accountRowId]);
  },
});
