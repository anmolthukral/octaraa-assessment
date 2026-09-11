import { createFlakyProvider, FlakyEvent } from './flakyProvider';
import { createReliableProvider } from './reliableProvider';
import { RawTransaction } from '../types';

const fixture: RawTransaction[] = [
  { providerTransactionId: 't1', accountId: 'acc-1', amountCents: 100, currency: 'USD', description: 'A', postedAt: '2026-01-01' },
  { providerTransactionId: 't2', accountId: 'acc-1', amountCents: 200, currency: 'USD', description: 'B', postedAt: '2026-01-02' },
];

test('replays the script in call order, then passes through', async () => {
  const underlying = createReliableProvider('mock', fixture, 10);
  const script: FlakyEvent[] = [
    { kind: 'fail', error: { kind: 'rate_limited', retryAfterMs: 100, message: 'slow down' } },
  ];
  const flaky = createFlakyProvider(underlying, script);

  const first = await flaky.fetchTransactions('acc-1', null);
  expect(first).toEqual({ ok: false, error: { kind: 'rate_limited', retryAfterMs: 100, message: 'slow down' } });

  const second = await flaky.fetchTransactions('acc-1', null);
  expect(second.ok).toBe(true);
  if (second.ok) expect(second.value.transactions).toHaveLength(2);
});

test('pass_through events delegate to the underlying provider', async () => {
  const underlying = createReliableProvider('mock', fixture, 10);
  const flaky = createFlakyProvider(underlying, [{ kind: 'pass_through' }]);
  const result = await flaky.fetchTransactions('acc-1', null);
  expect(result.ok).toBe(true);
});
