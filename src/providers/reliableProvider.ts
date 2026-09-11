import { Provider, RawTransaction } from '../types';

export const createReliableProvider = (
  id: string,
  allTransactions: RawTransaction[],
  pageSize: number,
): Provider => ({
  id,
  fetchTransactions: async (accountId, cursor) => {
    const startIndex = cursor ? Number(cursor) : 0;
    const accountTxns = allTransactions.filter((t) => t.accountId === accountId);
    const page = accountTxns.slice(startIndex, startIndex + pageSize);
    const nextIndex = startIndex + page.length;
    const hasMore = nextIndex < accountTxns.length;

    return {
      ok: true,
      value: {
        transactions: page,
        nextCursor: hasMore ? String(nextIndex) : null,
        hasMore,
      },
    };
  },
});
