import { withRetry, RetryOptions } from './retry';
import { createLogger } from './logger';

const silentLogger = createLogger(() => {});

const options = (overrides: Partial<RetryOptions> = {}): RetryOptions => ({
  maxAttempts: 3,
  baseDelayMs: 10,
  maxDelayMs: 1000,
  sleep: async () => {},
  ...overrides,
});

test('returns the value immediately on first success', async () => {
  const fn = async () => ({ ok: true as const, value: 'data' });
  const result = await withRetry(fn, options(), silentLogger);
  expect(result).toEqual({ ok: true, value: 'data' });
});

test('retries a transient error and succeeds on a later attempt', async () => {
  let attempt = 0;
  const fn = async () => {
    attempt += 1;
    if (attempt < 3) return { ok: false as const, error: { kind: 'transient' as const, message: 'boom' } };
    return { ok: true as const, value: 'recovered' };
  };
  const result = await withRetry(fn, options(), silentLogger);
  expect(result).toEqual({ ok: true, value: 'recovered' });
  expect(attempt).toBe(3);
});

test('waits exactly retryAfterMs when rate limited, then succeeds', async () => {
  const delays: number[] = [];
  let attempt = 0;
  const fn = async () => {
    attempt += 1;
    if (attempt === 1) {
      return { ok: false as const, error: { kind: 'rate_limited' as const, retryAfterMs: 750, message: 'slow down' } };
    }
    return { ok: true as const, value: 'ok' };
  };
  const result = await withRetry(fn, options({ sleep: async (ms: number) => { delays.push(ms); } }), silentLogger);
  expect(result).toEqual({ ok: true, value: 'ok' });
  expect(delays).toEqual([750]);
});

test('gives up after maxAttempts and returns the last error', async () => {
  const fn = async () => ({ ok: false as const, error: { kind: 'transient' as const, message: 'still down' } });
  const result = await withRetry(fn, options({ maxAttempts: 4 }), silentLogger);
  expect(result).toEqual({ ok: false, error: { kind: 'transient', message: 'still down' } });
});

test('does not retry a fatal error', async () => {
  let attempt = 0;
  const fn = async () => {
    attempt += 1;
    return { ok: false as const, error: { kind: 'fatal' as const, message: 'bad credentials' } };
  };
  const result = await withRetry(fn, options({ maxAttempts: 5 }), silentLogger);
  expect(attempt).toBe(1);
  expect(result.ok).toBe(false);
});

test('onAttempt reports each attempt: retrying then success', async () => {
  const seen: unknown[] = [];
  let attempt = 0;
  const fn = async () => {
    attempt += 1;
    if (attempt < 2) return { ok: false as const, error: { kind: 'transient' as const, message: 'boom' } };
    return { ok: true as const, value: 'ok' };
  };
  await withRetry(fn, options({ onAttempt: (info) => { seen.push(info); } }), silentLogger);
  expect(seen).toEqual([
    { attempt: 1, outcome: 'retrying', error: { kind: 'transient', message: 'boom' }, delayMs: expect.any(Number) },
    { attempt: 2, outcome: 'success' },
  ]);
});

test('onAttempt reports gave_up on the final failed attempt', async () => {
  const seen: unknown[] = [];
  const fn = async () => ({ ok: false as const, error: { kind: 'fatal' as const, message: 'bad creds' } });
  await withRetry(fn, options({ onAttempt: (info) => { seen.push(info); } }), silentLogger);
  expect(seen).toEqual([{ attempt: 1, outcome: 'gave_up', error: { kind: 'fatal', message: 'bad creds' } }]);
});

test('onAttempt is awaited before sleeping, and is optional', async () => {
  const order: string[] = [];
  let attempt = 0;
  const fn = async () => {
    attempt += 1;
    if (attempt === 1) return { ok: false as const, error: { kind: 'transient' as const, message: 'x' } };
    return { ok: true as const, value: 'ok' };
  };
  await withRetry(
    fn,
    options({
      maxAttempts: 2,
      onAttempt: async () => { order.push('onAttempt'); },
      sleep: async () => { order.push('sleep'); },
    }),
    silentLogger,
  );
  // attempt 1 fails (retryable) -> onAttempt then sleep; attempt 2 succeeds -> onAttempt only.
  expect(order).toEqual(['onAttempt', 'sleep', 'onAttempt']);

  // No onAttempt configured — must not throw.
  const alwaysFails = async () => ({ ok: false as const, error: { kind: 'transient' as const, message: 'x' } });
  await expect(withRetry(alwaysFails, options({ maxAttempts: 1 }), silentLogger)).resolves.toBeDefined();
});
