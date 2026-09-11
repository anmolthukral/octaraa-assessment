import { FetchPage, Provider, RawTransaction, Result } from '../types';
import { Logger } from '../logger';

/**
 * Finvu Account Aggregator sandbox adapter (no auth needed).
 *
 * Finvu's free sandbox (https://finvu.github.io/sandbox) provides mock FIP data
 * without authentication. This adapter returns mock transactions for testing.
 *
 * For production, would need to implement the full AA consent + session flow.
 */

export interface FinvuAdapterDeps {
  logger: Logger;
}

/**
 * Creates a mock Finvu provider that returns test transactions.
 * In production, this would call Finvu's real AA gateway.
 */
export const createFinvuProvider = (providerId: string, deps: FinvuAdapterDeps): Provider => {
  const mockTransactions: RawTransaction[] = [
    {
      providerTransactionId: 'finvu-txn-001',
      accountId: 'finvu-acc-1',
      amountCents: 50000,
      currency: 'INR',
      description: 'Salary Deposit',
      postedAt: '2026-09-01T10:00:00Z',
    },
    {
      providerTransactionId: 'finvu-txn-002',
      accountId: 'finvu-acc-1',
      amountCents: -15000,
      currency: 'INR',
      description: 'Grocery Store Purchase',
      postedAt: '2026-09-02T14:30:00Z',
    },
    {
      providerTransactionId: 'finvu-txn-003',
      accountId: 'finvu-acc-1',
      amountCents: -5000,
      currency: 'INR',
      description: 'Coffee Shop',
      postedAt: '2026-09-03T09:15:00Z',
    },
    {
      providerTransactionId: 'finvu-txn-004',
      accountId: 'finvu-acc-1',
      amountCents: 30000,
      currency: 'INR',
      description: 'Freelance Payment Received',
      postedAt: '2026-09-04T16:00:00Z',
    },
    {
      providerTransactionId: 'finvu-txn-005',
      accountId: 'finvu-acc-1',
      amountCents: -12000,
      currency: 'INR',
      description: 'Electricity Bill',
      postedAt: '2026-09-05T11:20:00Z',
    },
    {
      providerTransactionId: 'finvu-txn-006',
      accountId: 'finvu-acc-1',
      amountCents: -8000,
      currency: 'INR',
      description: 'Internet Bill',
      postedAt: '2026-09-06T12:00:00Z',
    },
  ];

  return {
    id: providerId,
    fetchTransactions: async (accountId, cursor): Promise<Result<FetchPage>> => {
      const PAGE_SIZE = 2;
      const pageNum = cursor ? parseInt(cursor, 10) : 0;
      const startIdx = pageNum * PAGE_SIZE;
      const endIdx = startIdx + PAGE_SIZE;

      const pageTransactions = mockTransactions.slice(startIdx, endIdx);
      const hasMore = endIdx < mockTransactions.length;
      const nextCursor = hasMore ? String(pageNum + 1) : null;

      deps.logger.info('finvu_fetch_page', {
        accountId,
        pageNum,
        pageSize: pageTransactions.length,
        hasMore,
      });

      return {
        ok: true,
        value: {
          transactions: pageTransactions,
          nextCursor,
          hasMore,
        },
      };
    },
  };
};
