import { Provider, SyncCursor, ProviderError } from '../types';
import { TransactionRepository } from '../ingestion/transactionRepository';
import { withRetry, RetryOptions, RetryAttemptInfo } from '../retry';
import { Logger } from '../logger';

export interface SyncStateStore {
  getCursor: (accountId: string) => Promise<SyncCursor>;
  setCursor: (accountId: string, cursor: SyncCursor) => Promise<void>;
}

export const createInMemorySyncStateStore = (): SyncStateStore => {
  const cursors = new Map<string, SyncCursor>();
  return {
    getCursor: async (accountId) => cursors.get(accountId) ?? null,
    setCursor: async (accountId, cursor) => { cursors.set(accountId, cursor); },
  };
};

export type SyncResult =
  | { status: 'completed'; pagesProcessed: number; newRecords: number }
  | { status: 'skipped'; reason: 'already_in_progress' }
  | { status: 'failed'; pagesProcessed: number; newRecords: number; error: ProviderError };

/** Records one retry attempt for auditing; runId is the live sync_runs row id. */
export type RecordAttempt = (runId: number, pageIndex: number, info: RetryAttemptInfo) => Promise<void>;

export const createSyncOrchestrator = (
  provider: Provider,
  repository: TransactionRepository,
  stateStore: SyncStateStore,
  retryOptions: RetryOptions,
  logger: Logger,
  recordAttempt?: RecordAttempt,
) => {
  const accountsInProgress = new Set<string>();

  const runSync = async (accountId: string, runId?: number): Promise<SyncResult> => {
    if (accountsInProgress.has(accountId)) {
      logger.info('sync_skipped_in_progress', { accountId, providerId: provider.id });
      return { status: 'skipped', reason: 'already_in_progress' };
    }
    accountsInProgress.add(accountId);

    try {
      return await runPages(accountId, runId);
    } finally {
      accountsInProgress.delete(accountId);
    }
  };

  const runPages = async (accountId: string, runId?: number): Promise<SyncResult> => {
    let cursor = await stateStore.getCursor(accountId);
    let pagesProcessed = 0;
    let newRecords = 0;
    let hasMore = true;

    while (hasMore) {
      const pageIndex = pagesProcessed;
      const perPageOptions: RetryOptions =
        runId === undefined || !recordAttempt
          ? retryOptions
          : { ...retryOptions, onAttempt: (info) => recordAttempt(runId, pageIndex, info) };

      const result = await withRetry(
        () => provider.fetchTransactions(accountId, cursor),
        perPageOptions,
        logger,
      );

      if (!result.ok) {
        logger.error('sync_failed', { accountId, providerId: provider.id, pagesProcessed, error: result.error });
        return { status: 'failed', pagesProcessed, newRecords, error: result.error };
      }

      const page = result.value;
      newRecords += await repository.upsertMany(provider.id, page.transactions);
      pagesProcessed += 1;

      cursor = page.nextCursor;
      await stateStore.setCursor(accountId, cursor);
      hasMore = page.hasMore;
    }

    logger.info('sync_completed', { accountId, providerId: provider.id, pagesProcessed, newRecords });
    return { status: 'completed', pagesProcessed, newRecords };
  };

  return { runSync };
};
