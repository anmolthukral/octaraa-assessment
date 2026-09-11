export type SyncCursor = string | null;

export interface RawTransaction {
  providerTransactionId: string;
  accountId: string;
  amountCents: number;
  currency: string;
  description: string;
  postedAt: string;
}

export interface FetchPage {
  transactions: RawTransaction[];
  nextCursor: SyncCursor;
  hasMore: boolean;
}

export type ProviderError =
  | { kind: 'rate_limited'; retryAfterMs: number; message: string }
  | { kind: 'transient'; message: string }
  | { kind: 'fatal'; message: string };

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProviderError };

export interface Provider {
  id: string;
  fetchTransactions: (accountId: string, cursor: SyncCursor) => Promise<Result<FetchPage>>;
}
