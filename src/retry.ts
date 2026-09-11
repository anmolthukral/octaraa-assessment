import { Result, ProviderError } from './types';
import { Logger } from './logger';

export type RetryAttemptOutcome = 'success' | 'retrying' | 'gave_up';

export interface RetryAttemptInfo {
  attempt: number;
  outcome: RetryAttemptOutcome;
  error?: ProviderError;
  /** Backoff before the next attempt; only set when outcome is 'retrying'. */
  delayMs?: number;
}

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  /**
   * Fired after every attempt (success, retrying, or giving up). Optional so
   * existing callers and tests are unaffected; the live wiring uses this to
   * persist an audit trail to `sync_attempts` without coupling this generic
   * retry policy to Postgres.
   */
  onAttempt?: (info: RetryAttemptInfo) => void | Promise<void>;
}

const isRetryable = (error: ProviderError): boolean =>
  error.kind === 'rate_limited' || error.kind === 'transient';

/**
 * Exponential backoff capped at maxDelayMs, with +0-20% jitter so a fleet of
 * callers doesn't retry in lockstep. Shared by page-level retry (here) and
 * account-level retry scheduling (src/db/providerAccounts.ts) so both layers
 * back off the same way.
 */
export const computeBackoffMs = (attempt: number, baseDelayMs: number, maxDelayMs: number): number => {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const jitter = Math.random() * exponential * 0.2;
  return Math.round(exponential + jitter);
};

const delayFor = (error: ProviderError, attempt: number, options: RetryOptions): number =>
  error.kind === 'rate_limited'
    ? error.retryAfterMs
    : computeBackoffMs(attempt, options.baseDelayMs, options.maxDelayMs);

export const withRetry = async <T>(
  fn: () => Promise<Result<T>>,
  options: RetryOptions,
  logger: Logger,
): Promise<Result<T>> => {
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const result = await fn();
    if (result.ok) {
      await options.onAttempt?.({ attempt, outcome: 'success' });
      return result;
    }

    const isLastAttempt = attempt === options.maxAttempts;
    if (!isRetryable(result.error) || isLastAttempt) {
      logger.warn('retry_gave_up', { attempt, error: result.error });
      await options.onAttempt?.({ attempt, outcome: 'gave_up', error: result.error });
      return result;
    }

    const delayMs = delayFor(result.error, attempt, options);
    logger.info('retrying', { attempt, delayMs, error: result.error });
    await options.onAttempt?.({ attempt, outcome: 'retrying', error: result.error, delayMs });
    await options.sleep(delayMs);
  }

  // Unreachable when maxAttempts >= 1, but keeps the function total.
  return { ok: false, error: { kind: 'fatal', message: 'retry loop exited unexpectedly' } };
};
