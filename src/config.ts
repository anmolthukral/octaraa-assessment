/**
 * Environment-based configuration and secrets.
 *
 * Every secret (DATABASE_URL, which embeds the DB password) arrives via
 * environment variables — never hardcoded, never logged (this module emits
 * no logs at all). In production these vars are populated from a secrets
 * manager (AWS Secrets Manager / Vault / Doppler): the process only ever
 * sees env, so rotating a secret means updating the manager, not
 * redeploying code.
 */
export interface AppConfig {
  databaseUrl: string;
  /** Standard 5-field cron expression the scheduler re-syncs every account on. */
  syncCronPattern: string;
  syncMaxAttempts: number;
  /** withRetry backoff bounds for live provider calls (per page fetch). */
  syncRetryBaseMs: number;
  syncRetryMaxMs: number;
  /**
   * Backoff bounds for retrying a whole FAILED account sync sooner than the
   * next cron tick. Same exponential+jitter formula as page-level retry
   * (src/retry.ts computeBackoffMs), just on a minutes/hours scale instead
   * of milliseconds — see src/db/providerAccounts.ts.
   */
  accountRetryBaseMs: number;
  accountRetryMaxMs: number;
  /** HTTP port for the Express app (health check, manual trigger, status). */
  port: number;
}

const required = (env: Record<string, string | undefined>, names: string[]): void => {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`missing required env vars: ${missing.join(', ')} (see .env.example)`);
  }
};

const need = (env: Record<string, string | undefined>, name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`missing required env var: ${name} (see .env.example)`);
  return value;
};

const positiveInt = (env: Record<string, string | undefined>, name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid env var ${name}=${raw}: expected a positive integer`);
  }
  return parsed;
};

export const parseConfig = (env: Record<string, string | undefined>): AppConfig => {
  required(env, ['DATABASE_URL']);

  return {
    databaseUrl: need(env, 'DATABASE_URL'),
    syncCronPattern: env['SYNC_CRON_PATTERN'] || '0 */6 * * *',
    syncMaxAttempts: positiveInt(env, 'SYNC_MAX_ATTEMPTS', 4),
    syncRetryBaseMs: positiveInt(env, 'SYNC_RETRY_BASE_MS', 500),
    syncRetryMaxMs: positiveInt(env, 'SYNC_RETRY_MAX_MS', 8000),
    accountRetryBaseMs: positiveInt(env, 'ACCOUNT_RETRY_BASE_MS', 60_000), // 1 minute
    accountRetryMaxMs: positiveInt(env, 'ACCOUNT_RETRY_MAX_MS', 21_600_000), // 6 hours
    port: positiveInt(env, 'PORT', 3000),
  };
};

/** Read live configuration from the process environment. */
export const loadConfig = (): AppConfig => parseConfig(process.env);
