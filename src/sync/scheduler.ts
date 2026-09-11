import cron from 'node-cron';
import { SyncResult } from './syncOrchestrator';
import { Logger } from '../logger';

/**
 * Cron-driven + on-demand sync scheduling.
 *
 * The cron tick re-syncs every *due* account — `listAccounts` is expected to
 * already exclude ones mid-retry-backoff, see src/db/providerAccounts.ts's
 * listDueAccountsForProvider; `triggerNow` re-syncs on demand (HTTP call,
 * webhook). Overlapping cron ticks are skipped — a slow
 * provider must delay the next tick, never stack runs — while on-demand
 * triggers always execute because the orchestrator's per-account lock (plus
 * the sync_runs partial unique index across machines) already turns a
 * same-account collision into a `skipped` result instead of a duplicate.
 * This is the single-process scheduler; the technical note describes its
 * queue-based successor at scale.
 */
export interface CronTask {
  stop: () => void;
}

export interface CronScheduler {
  schedule: (pattern: string, fn: () => void) => CronTask;
}

export interface SchedulerDeps {
  listAccounts: () => Promise<string[]>;
  runAccount: (accountId: string) => Promise<SyncResult>;
  // Standard 5-field cron expression, e.g. every-6-hours or every-minute.
  cronPattern: string;
  logger: Logger;
  cron?: CronScheduler;
}

export interface Scheduler {
  start: () => void;
  stop: () => void;
  triggerNow: (accountId?: string) => Promise<SyncResult[]>;
}

const defaultCronScheduler: CronScheduler = {
  schedule: (pattern, fn) => {
    const task = cron.schedule(pattern, fn);
    return { stop: () => task.stop() };
  },
};

export const createScheduler = (deps: SchedulerDeps): Scheduler => {
  const cronImpl = deps.cron ?? defaultCronScheduler;
  let task: CronTask | null = null;
  let tickInFlight = false;

  const runAll = async (accountIds: string[]): Promise<SyncResult[]> => {
    const results: SyncResult[] = [];
    for (const accountId of accountIds) {
      results.push(await deps.runAccount(accountId));
    }
    return results;
  };

  const tick = async (): Promise<void> => {
    if (tickInFlight) {
      deps.logger.warn('scheduler_tick_skipped_overlap', {});
      return;
    }
    tickInFlight = true;
    try {
      const accountIds = await deps.listAccounts();
      const results = await runAll(accountIds);
      const completed = results.filter((r) => r.status === 'completed').length;
      deps.logger.info('scheduler_tick_done', { accounts: accountIds.length, completed });
    } finally {
      tickInFlight = false;
    }
  };

  return {
    start: () => {
      if (task !== null) {
        deps.logger.warn('scheduler_already_started', {});
        return;
      }
      void tick();
      task = cronImpl.schedule(deps.cronPattern, () => {
        void tick();
      });
      deps.logger.info('scheduler_started', { cronPattern: deps.cronPattern });
    },

    stop: () => {
      if (task === null) return;
      task.stop();
      task = null;
    },

    triggerNow: async (accountId?: string): Promise<SyncResult[]> => {
      const accountIds = accountId ? [accountId] : await deps.listAccounts();
      return runAll(accountIds);
    },
  };
};
