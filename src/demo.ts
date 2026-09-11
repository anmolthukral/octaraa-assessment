import { createLogger, runLeaf } from './logger';
import { createInMemoryTransactionRepository } from './ingestion/transactionRepository';
import { createReliableProvider } from './providers/reliableProvider';
import { createFlakyProvider, FlakyEvent } from './providers/flakyProvider';
import { createSyncOrchestrator, createInMemorySyncStateStore } from './sync/syncOrchestrator';
import { RawTransaction } from './types';

const logger = createLogger();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const fixture: RawTransaction[] = Array.from({ length: 6 }, (_, i) => ({
  providerTransactionId: `t${i + 1}`,
  accountId: 'acc-1',
  amountCents: (i + 1) * 500,
  currency: 'USD',
  description: `Demo transaction ${i + 1}`,
  postedAt: `2026-01-0${i + 1}`,
}));

const script: FlakyEvent[] = [
  { kind: 'pass_through' },
  { kind: 'fail', error: { kind: 'rate_limited', retryAfterMs: 200, message: 'rate limited' } },
  { kind: 'pass_through' },
  { kind: 'fail', error: { kind: 'transient', message: 'gateway timeout' } },
  { kind: 'pass_through' },
  { kind: 'pass_through' },
];

const main = async (): Promise<void> => {
  const reliable = createReliableProvider('demo-bank', fixture, 2);
  const flaky = createFlakyProvider(reliable, script);
  const repository = createInMemoryTransactionRepository();
  const stateStore = createInMemorySyncStateStore();
  const orchestrator = createSyncOrchestrator(
    flaky,
    repository,
    stateStore,
    { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1000, sleep },
    logger,
  );

  const result = await orchestrator.runSync('acc-1');
  logger.info('demo_result', { result, storedCount: await repository.count() });
};

runLeaf(main);
