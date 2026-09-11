import { createInMemoryTransactionRepository, dedupeKeyFor } from './transactionRepository';
import { RawTransaction } from '../types';

const txn = (overrides: Partial<RawTransaction> = {}): RawTransaction => ({
  providerTransactionId: 't1',
  accountId: 'acc-1',
  amountCents: 1000,
  currency: 'USD',
  description: 'Coffee',
  postedAt: '2026-01-01',
  ...overrides,
});

test('dedupeKeyFor combines provider, account, and provider transaction id', () => {
  expect(dedupeKeyFor('plaid', txn())).toBe('plaid:acc-1:t1');
});

test('upserting the same transaction twice stores it once', async () => {
  const repo = createInMemoryTransactionRepository();
  const first = await repo.upsertMany('plaid', [txn()]);
  const second = await repo.upsertMany('plaid', [txn()]);
  expect(first).toBe(1);
  expect(second).toBe(0); // no NEW records the second time
  expect(await repo.count()).toBe(1);
});

test('overlapping pages (duplicate tail record) do not double-count', async () => {
  const repo = createInMemoryTransactionRepository();
  const pageOne = [txn({ providerTransactionId: 't1' }), txn({ providerTransactionId: 't2' })];
  const pageTwo = [txn({ providerTransactionId: 't2' }), txn({ providerTransactionId: 't3' })]; // t2 repeated
  await repo.upsertMany('plaid', pageOne);
  const newInPageTwo = await repo.upsertMany('plaid', pageTwo);
  expect(newInPageTwo).toBe(1); // only t3 is new
  expect(await repo.count()).toBe(3);
});

test('listByAccount returns records sorted by postedAt regardless of insertion order', async () => {
  const repo = createInMemoryTransactionRepository();
  await repo.upsertMany('plaid', [
    txn({ providerTransactionId: 't2', postedAt: '2026-02-01' }),
    txn({ providerTransactionId: 't1', postedAt: '2026-01-01' }),
  ]);
  const listed = await repo.listByAccount('acc-1');
  expect(listed.map((t) => t.providerTransactionId)).toEqual(['t1', 't2']);
});

test('different providers with the same providerTransactionId do not collide', async () => {
  const repo = createInMemoryTransactionRepository();
  await repo.upsertMany('plaid', [txn({ providerTransactionId: 't1' })]);
  await repo.upsertMany('yodlee', [txn({ providerTransactionId: 't1' })]);
  expect(await repo.count()).toBe(2);
});
