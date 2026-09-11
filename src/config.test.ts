import { parseConfig } from './config';

const baseEnv = (): Record<string, string | undefined> => ({
  DATABASE_URL: 'postgres://user:pass@localhost:5432/octaraa',
});

test('parses required vars and applies documented defaults', () => {
  const config = parseConfig(baseEnv());
  expect(config).toMatchObject({
    databaseUrl: 'postgres://user:pass@localhost:5432/octaraa',
    syncCronPattern: '0 */6 * * *',
    syncMaxAttempts: 4,
    accountRetryBaseMs: 60_000,
    accountRetryMaxMs: 21_600_000,
    port: 3000,
  });
});

test('honours explicit overrides', () => {
  const config = parseConfig({
    ...baseEnv(),
    SYNC_CRON_PATTERN: '*/5 * * * *',
    SYNC_MAX_ATTEMPTS: '2',
    ACCOUNT_RETRY_BASE_MS: '1000',
    ACCOUNT_RETRY_MAX_MS: '5000',
    PORT: '8080',
  });
  expect(config.syncCronPattern).toBe('*/5 * * * *');
  expect(config.syncMaxAttempts).toBe(2);
  expect(config.accountRetryBaseMs).toBe(1000);
  expect(config.accountRetryMaxMs).toBe(5000);
  expect(config.port).toBe(8080);
});

test('names every missing required var', () => {
  expect(() => parseConfig({})).toThrow(/DATABASE_URL/);
});

test('rejects non-positive-integer numerics', () => {
  expect(() => parseConfig({ ...baseEnv(), SYNC_MAX_ATTEMPTS: '0' })).toThrow(/SYNC_MAX_ATTEMPTS/);
  expect(() => parseConfig({ ...baseEnv(), SYNC_MAX_ATTEMPTS: 'many' })).toThrow(/SYNC_MAX_ATTEMPTS/);
});
