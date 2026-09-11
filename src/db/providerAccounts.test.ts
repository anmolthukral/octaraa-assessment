import { createFakeDbClient as createDbClientFake } from './fakeDbClient';
import {
  ensureProviderAccount,
  listDueAccountsForProvider,
  recordAccountSyncSuccess,
  recordAccountSyncFailure,
} from './providerAccounts';

test('ensureProviderAccount returns the row id in a single round trip', async () => {
  const db = createDbClientFake({ onQuery: () => [{ id: 7 }] });
  const id = await ensureProviderAccount(db, 'finvu', 'acc-1');
  expect(id).toBe(7);
  expect(db.queries).toHaveLength(1);
  expect(db.queries[0]?.text).toMatch(/ON CONFLICT .* DO UPDATE/s);
  expect(db.queries[0]?.text).toMatch(/RETURNING id/);
});

test('listDueAccountsForProvider filters on next_retry_at in SQL', async () => {
  const db = createDbClientFake({ onQuery: () => [{ external_account_ref: 'a1' }] });
  await expect(listDueAccountsForProvider(db, 'finvu')).resolves.toEqual(['a1']);
  expect(db.queries[0]?.text).toMatch(/next_retry_at IS NULL OR next_retry_at <= now\(\)/);
  expect(db.queries[0]?.params).toEqual(['finvu']);
});

test('recordAccountSyncSuccess clears the failure streak and next_retry_at', async () => {
  const db = createDbClientFake();
  await recordAccountSyncSuccess(db, 'finvu', 'acc-1');
  expect(db.queries).toHaveLength(1);
  expect(db.queries[0]?.text).toMatch(/consecutive_failures = 0, next_retry_at = NULL/);
  expect(db.queries[0]?.params).toEqual(['finvu', 'acc-1']);
});

test('recordAccountSyncFailure starts the streak at 1 for a first-ever failure', async () => {
  const db = createDbClientFake({ onQuery: () => [] }); // no existing row -> previousFailures defaults to 0
  await recordAccountSyncFailure(db, 'finvu', 'acc-1', { baseDelayMs: 1000, maxDelayMs: 60_000 });

  expect(db.queries).toHaveLength(2);
  const [, update] = db.queries;
  expect(update?.text).toMatch(/SET consecutive_failures = \$3/);
  expect(update?.params?.[0]).toBe('finvu');
  expect(update?.params?.[1]).toBe('acc-1');
  expect(update?.params?.[2]).toBe(1); // attempt number
  expect(update?.params?.[3]).toBeGreaterThanOrEqual(1000); // base delay, before jitter cap
});

test('recordAccountSyncFailure escalates the attempt number on repeated failures', async () => {
  const db = createDbClientFake({ onQuery: () => [{ consecutive_failures: 2 }] });
  await recordAccountSyncFailure(db, 'finvu', 'acc-1', { baseDelayMs: 1000, maxDelayMs: 60_000 });

  const [, update] = db.queries;
  expect(update?.params?.[2]).toBe(3); // previous 2 failures + this one
});

test('recordAccountSyncFailure caps the delay at maxDelayMs', async () => {
  const db = createDbClientFake({ onQuery: () => [{ consecutive_failures: 50 }] }); // huge exponent
  await recordAccountSyncFailure(db, 'finvu', 'acc-1', { baseDelayMs: 1000, maxDelayMs: 5000 });

  const [, update] = db.queries;
  const delayMs = update?.params?.[3] as number;
  expect(delayMs).toBeGreaterThanOrEqual(5000);
  expect(delayMs).toBeLessThanOrEqual(6000); // maxDelayMs + up to 20% jitter
});
