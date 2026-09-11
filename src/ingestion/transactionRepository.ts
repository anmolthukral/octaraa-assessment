import { RawTransaction } from '../types';

export interface StoredTransaction extends RawTransaction {
  dedupeKey: string;
}

export interface TransactionRepository {
  upsertMany: (providerId: string, transactions: RawTransaction[]) => Promise<number>;
  listByAccount: (accountId: string) => Promise<StoredTransaction[]>;
  count: () => Promise<number>;
}

export const dedupeKeyFor = (providerId: string, txn: RawTransaction): string =>
  `${providerId}:${txn.accountId}:${txn.providerTransactionId}`;

export const createInMemoryTransactionRepository = (): TransactionRepository => {
  const store = new Map<string, StoredTransaction>();

  const upsertMany = async (providerId: string, transactions: RawTransaction[]): Promise<number> =>
    transactions.reduce((newRecords, txn) => {
      const dedupeKey = dedupeKeyFor(providerId, txn);
      const isNew = !store.has(dedupeKey);
      store.set(dedupeKey, { ...txn, dedupeKey });
      return newRecords + (isNew ? 1 : 0);
    }, 0);

  const listByAccount = async (accountId: string): Promise<StoredTransaction[]> =>
    Array.from(store.values())
      .filter((t) => t.accountId === accountId)
      .sort((a, b) => a.postedAt.localeCompare(b.postedAt));

  return { upsertMany, listByAccount, count: async () => store.size };
};
