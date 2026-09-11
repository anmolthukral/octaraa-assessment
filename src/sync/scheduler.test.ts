import { createScheduler, CronScheduler } from './scheduler';
import { createLogger } from '../logger';
import { SyncResult } from './syncOrchestrator';

const silentLogger = createLogger(() => {});

const completed = (newRecords: number): SyncResult => ({ status: 'completed', pagesProcessed: 1, newRecords });

const manualCron = (): CronScheduler & { fire: () => void; scheduleCalls: () => number; stopCalls: () => number } => {
  let fn: (() => void) | null = null;
  let scheduleCalls = 0;
  let stopCalls = 0;
  return {
    schedule: (_pattern, f) => {
      fn = f;
      scheduleCalls += 1;
      return { stop: () => { stopCalls += 1; } };
    },
    fire: () => {
      if (fn) fn();
    },
    scheduleCalls: () => scheduleCalls,
    stopCalls: () => stopCalls,
  };
};

test('triggerNow syncs every listed account in order', async () => {
  const seen: string[] = [];
  const scheduler = createScheduler({
    listAccounts: async () => ['a1', 'a2'],
    runAccount: async (accountId) => {
      seen.push(accountId);
      return completed(1);
    },
    cronPattern: '* * * * *',
    logger: silentLogger,
  });

  const results = await scheduler.triggerNow();

  expect(seen).toEqual(['a1', 'a2']);
  expect(results).toHaveLength(2);
});

test('triggerNow with an account id syncs only that account', async () => {
  const seen: string[] = [];
  const scheduler = createScheduler({
    listAccounts: async () => ['a1', 'a2'],
    runAccount: async (accountId) => {
      seen.push(accountId);
      return completed(1);
    },
    cronPattern: '* * * * *',
    logger: silentLogger,
  });

  await scheduler.triggerNow('a2');
  expect(seen).toEqual(['a2']);
});

test('start runs an immediate tick and then one per cron fire; stop ends them', async () => {
  let runs = 0;
  const cron = manualCron();
  const scheduler = createScheduler({
    listAccounts: async () => ['a1'],
    runAccount: async () => {
      runs += 1;
      return completed(1);
    },
    cronPattern: '* * * * *',
    logger: silentLogger,
    cron,
  });

  scheduler.start();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(runs).toBe(1); // immediate tick
  expect(cron.scheduleCalls()).toBe(1); // exactly one cron task registered

  scheduler.start(); // second start is a no-op
  expect(cron.scheduleCalls()).toBe(1);

  cron.fire();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(runs).toBe(2); // cron-triggered tick

  scheduler.stop();
  expect(cron.stopCalls()).toBe(1);
});

test('an overlapping cron tick is skipped, never stacked', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let runs = 0;
  const cron = manualCron();
  const scheduler = createScheduler({
    listAccounts: async () => ['a1'],
    runAccount: async () => {
      runs += 1;
      await gate;
      return completed(1);
    },
    cronPattern: '* * * * *',
    logger: silentLogger,
    cron,
  });

  scheduler.start(); // tick 1 starts, blocks on gate
  await new Promise((resolve) => setTimeout(resolve, 0));
  cron.fire(); // tick 2 while tick 1 in flight → skipped
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(runs).toBe(1);

  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  scheduler.stop();
});
