import { RawTransaction } from '../types';
import { StoredTransaction, TransactionRepository } from './transactionRepository';
import { DbClient, textOf } from '../db/dbClient';
import { dedupeKeyFor } from './transactionRepository';
import { ensureProviderAccount } from '../db/providerAccounts';
/**
 * Postgres-backed TransactionRepository.
 *
 * Dedupe stays correct under concurrency and replay: the UNIQUE
 * (provider_account_id, provider_transaction_id) constraint makes the
 * insert itself idempotent (`ON CONFLICT DO NOTHING`), and only genuinely
 * new rows are counted via `RETURNING`.
 */
export const createPostgresTransactionRepository = (
  db: DbClient,
  providerId: string,
): TransactionRepository => {
  const upsertMany = async (upsertProviderId: string, transactions: RawTransaction[]): Promise<number> => {
    if (transactions.length === 0) return 0;
    const accountIds = Array.from(new Set(transactions.map((t) => t.accountId)));
    const accountRowIds = new Map<string, number>();
    for (const accountId of accountIds) {
      accountRowIds.set(accountId, await ensureProviderAccount(db, upsertProviderId, accountId));
    }

    // One round trip per page: the UNIQUE constraint absorbs replays, and
    // RETURNING counts only genuinely new rows.
    const values: unknown[] = [];
    const placeholders = transactions.map((txn, index) => {
      const base = index * 7;
      values.push(
        accountRowIds.get(txn.accountId),
        txn.providerTransactionId,
        txn.amountCents,
        txn.currency,
        txn.description,
        txn.postedAt,
        dedupeKeyFor(upsertProviderId, txn),
      );
      const refs = Array.from({ length: 7 }, (_, offset) => `$${base + offset + 1}`);
      return `(${refs.join(', ')})`;
    });
    const result = await db.query(
      `INSERT INTO transactions
         (provider_account_id, provider_transaction_id, amount_cents, currency, description, posted_at, dedupe_key)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (provider_account_id, provider_transaction_id) DO NOTHING
       RETURNING id`,
      values,
    );
    return result.rows.length;
  };

  const listByAccount = async (accountId: string): Promise<StoredTransaction[]> => {
    const accountRowId = await ensureProviderAccount(db, providerId, accountId);
    const result = await db.query(
      `SELECT provider_transaction_id, amount_cents, currency, description,
              posted_at, dedupe_key
       FROM transactions
      WHERE provider_account_id = $1
      ORDER BY posted_at ASC`,
      [accountRowId],
    );
    return result.rows.map((row) => ({
      providerTransactionId: textOf(row, 'provider_transaction_id'),
      accountId,
      amountCents: Number(row['amount_cents'] ?? 0),
      currency: textOf(row, 'currency'),
      description: textOf(row, 'description'),
      postedAt: textOf(row, 'posted_at'),
      dedupeKey: textOf(row, 'dedupe_key'),
    }));
  };

  const count = async (): Promise<number> => {
    const result = await db.query(
      `SELECT COUNT(*) AS total FROM transactions
       WHERE provider_account_id IN (SELECT id FROM provider_accounts WHERE provider_id = $1)`,
      [providerId],
    );
    const row = result.rows[0];
    return row ? Number(row['total'] ?? 0) : 0;
  };

  return { upsertMany, listByAccount, count };
};
