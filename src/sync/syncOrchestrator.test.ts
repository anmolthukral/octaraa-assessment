import { createSyncOrchestrator, createInMemorySyncStateStore } from './syncOrchestrator';
import { createInMemoryTransactionRepository } from '../ingestion/transactionRepository';
import { createReliableProvider } from '../providers/reliableProvider';
import { createFlakyProvider, FlakyEvent } from '../providers/flakyProvider';
import { createLogger } from '../logger';
import { RawTransaction } from '../types';

const silentLogger = createLogger(() => {});
const retryOptions = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5, sleep: async () => {} };

const fixture: RawTransaction[] = Array.from({ length: 4 }, (_, i) => ({
  providerTransactionId: `t${i + 1}`,
  accountId: 'acc-1',
  amountCents: 100 * (i + 1),
  currency: 'USD',
  description: `txn ${i + 1}`,
  postedAt: `2026-01-0${i + 1}`,
}));

test('paginates a full sync and reports pages/new records', async () => {
  const provider = createReliableProvider('mock', fixture, 2); // 2 pages of 2
  const repository = createInMemoryTransactionRepository();
  const orchestrator = createSyncOrchestrator(
    provider, repository, createInMemorySyncStateStore(), retryOptions, silentLogger,
  );

  const result = await orchestrator.runSync('acc-1');

  expect(result).toEqual({ status: 'completed', pagesProcessed: 2, newRecords: 4 });
  expect(await repository.count()).toBe(4);
});

test('a second sync of an already-ingested account adds zero new records (idempotent)', async () => {
  const provider = createReliableProvider('mock', fixture, 2);
  const repository = createInMemoryTransactionRepository();
  const stateStore = createInMemorySyncStateStore();
  const orchestrator = createSyncOrchestrator(provider, repository, stateStore, retryOptions, silentLogger);

  await orchestrator.runSync('acc-1');
  await stateStore.setCursor('acc-1', null); // simulate re-sync from the start (e.g. full refresh)
  const second = await orchestrator.runSync('acc-1');

  expect(second).toEqual({ status: 'completed', pagesProcessed: 2, newRecords: 0 });
  expect(await repository.count()).toBe(4);
});

test('a rejected concurrent sync on the same account is skipped, not duplicated', async () => {
  const provider = createReliableProvider('mock', fixture, 1);
  const repository = createInMemoryTransactionRepository();
  const orchestrator = createSyncOrchestrator(
    provider, repository, createInMemorySyncStateStore(), retryOptions, silentLogger,
  );

  const [first, second] = await Promise.all([
    orchestrator.runSync('acc-1'),
    orchestrator.runSync('acc-1'),
  ]);

  const statuses = [first.status, second.status].sort();
  expect(statuses).toEqual(['completed', 'skipped']);
  expect(await repository.count()).toBe(4); // only one run actually ingested
});

test('mid-sync failure persists the cursor, and a later run resumes without duplicating pages', async () => {
  const provider = createReliableProvider('mock', fixture, 1); // 4 pages of 1
  const script: FlakyEvent[] = [
    { kind: 'pass_through' }, // page 1 ok
    { kind: 'pass_through' }, // page 2 ok
    { kind: 'fail', error: { kind: 'transient', message: 'down' } }, // page 3 attempt 1
    { kind: 'fail', error: { kind: 'transient', message: 'down' } }, // page 3 attempt 2
    { kind: 'fail', error: { kind: 'transient', message: 'down' } }, // page 3 attempt 3 -> exhausted
  ];
  const flaky = createFlakyProvider(provider, script);
  const repository = createInMemoryTransactionRepository();
  const stateStore = createInMemorySyncStateStore();
  const orchestrator = createSyncOrchestrator(flaky, repository, stateStore, retryOptions, silentLogger);

  const firstRun = await orchestrator.runSync('acc-1');
  expect(firstRun.status).toBe('failed');
  if (firstRun.status === 'failed') {
    expect(firstRun.pagesProcessed).toBe(2);
  }
  expect(await repository.count()).toBe(2); // only pages 1-2 landed

  const secondRun = await orchestrator.runSync('acc-1'); // page 3's next call_index falls through to pass_through
  expect(secondRun.status).toBe('completed');
  if (secondRun.status === 'completed') {
    expect(secondRun.pagesProcessed).toBe(2);
  }
  expect(await repository.count()).toBe(4); // pages 3-4 completed the set, nothing duplicated
});

test('recordAttempt is called per page/attempt when a runId is supplied', async () => {
  const provider = createReliableProvider('mock', fixture, 2); // 2 pages of 2
  const script: FlakyEvent[] = [
    { kind: 'fail', error: { kind: 'transient', message: 'down' } }, // page 0 attempt 1
    { kind: 'pass_through' }, // page 0 attempt 2 -> succeeds
    { kind: 'pass_through' }, // page 1 attempt 1 -> succeeds
  ];
  const flaky = createFlakyProvider(provider, script);
  const repository = createInMemoryTransactionRepository();
  const seen: Array<{ runId: number; pageIndex: number; attempt: number; outcome: string }> = [];
  const orchestrator = createSyncOrchestrator(
    flaky,
    repository,
    createInMemorySyncStateStore(),
    retryOptions,
    silentLogger,
    async (runId, pageIndex, info) => {
      seen.push({ runId, pageIndex, attempt: info.attempt, outcome: info.outcome });
    },
  );

  const result = await orchestrator.runSync('acc-1', 42);

  expect(result.status).toBe('completed');
  expect(seen).toEqual([
    { runId: 42, pageIndex: 0, attempt: 1, outcome: 'retrying' },
    { runId: 42, pageIndex: 0, attempt: 2, outcome: 'success' },
    { runId: 42, pageIndex: 1, attempt: 1, outcome: 'success' },
  ]);
});

test('recordAttempt is never called when no runId is supplied (demo/test path)', async () => {
  const provider = createReliableProvider('mock', fixture, 2);
  const repository = createInMemoryTransactionRepository();
  const recordAttempt = jest.fn();
  const orchestrator = createSyncOrchestrator(
    provider, repository, createInMemorySyncStateStore(), retryOptions, silentLogger, recordAttempt,
  );

  await orchestrator.runSync('acc-1'); // no runId passed
  expect(recordAttempt).not.toHaveBeenCalled();
});
