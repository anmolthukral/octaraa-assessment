import { createFakeDbClient } from '../db/fakeDbClient';
import { createPostgresTransactionRepository } from './postgresTransactionRepository';
import { RawTransaction } from '../types';

const txn = (overrides: Partial<RawTransaction> = {}): RawTransaction => ({
  providerTransactionId: 't1',
  accountId: 'acc-1',
  amountCents: 1000,
  currency: 'INR',
  description: 'UPI payment',
  postedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

test('upsertMany batches one INSERT and counts only RETURNING rows as new', async () => {
  const db = createFakeDbClient({
    onQuery: (text) => {
      if (text.startsWith('INSERT INTO provider_accounts')) return [{ id: 11 }];
      if (text.startsWith('INSERT INTO transactions')) return [{ id: 1 }];
      return [];
    },
  });
  const repo = createPostgresTransactionRepository(db, 'finvu');

  const inserted = await repo.upsertMany('finvu', [txn(), txn({ providerTransactionId: 't2' })]);

  expect(inserted).toBe(1); // fake returned a single RETURNING row
  const txnInsert = db.queries.find((q) => q.text.startsWith('INSERT INTO transactions'));
  expect(txnInsert?.params).toHaveLength(14); // 2 rows x 7 columns, one round trip
  expect(txnInsert?.text).toMatch(/ON CONFLICT \(provider_account_id, provider_transaction_id\) DO NOTHING/);
});

test('upsertMany with zero transactions issues no SQL', async () => {
  const db = createFakeDbClient();
  const repo = createPostgresTransactionRepository(db, 'finvu');
  await expect(repo.upsertMany('finvu', [])).resolves.toBe(0);
  expect(db.queries).toHaveLength(0);
});

test('listByAccount maps rows back to StoredTransactions in postedAt order', async () => {
  const db = createFakeDbClient({
    onQuery: (text) => {
      if (text.startsWith('INSERT INTO provider_accounts')) return [{ id: 11 }];
      return [
        {
          provider_transaction_id: 't1',
          amount_cents: '1000',
          currency: 'INR',
          description: 'UPI payment',
          posted_at: '2026-01-01T00:00:00.000Z',
          dedupe_key: 'finvu:acc-1:t1',
        },
      ];
    },
  });
  const repo = createPostgresTransactionRepository(db, 'finvu');
  const listed = await repo.listByAccount('acc-1');
  expect(listed).toEqual([
    {
      providerTransactionId: 't1',
      accountId: 'acc-1',
      amountCents: 1000,
      currency: 'INR',
      description: 'UPI payment',
      postedAt: '2026-01-01T00:00:00.000Z',
      dedupeKey: 'finvu:acc-1:t1',
    },
  ]);
});
