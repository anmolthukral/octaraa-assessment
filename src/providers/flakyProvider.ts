import { Provider, ProviderError } from '../types';

export type FlakyEvent =
  | { kind: 'fail'; error: ProviderError }
  | { kind: 'pass_through' };

export const createFlakyProvider = (underlying: Provider, script: FlakyEvent[]): Provider => {
  let callIndex = 0;

  return {
    id: underlying.id,
    fetchTransactions: async (accountId, cursor) => {
      const event = script[callIndex];
      callIndex += 1;

      if (event && event.kind === 'fail') {
        return { ok: false, error: event.error };
      }
      return underlying.fetchTransactions(accountId, cursor);
    },
  };
};
