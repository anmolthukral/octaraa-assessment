import request from 'supertest';
import { createApp, AppDeps } from './app';
import { createLogger } from './logger';
import { Scheduler } from './sync/scheduler';
import { SyncResult } from './sync/syncOrchestrator';
import { SyncRunSummary } from './sync/postgresSyncRuns';
import { SyncAttemptSummary } from './sync/postgresSyncAttempts';

const silentLogger = createLogger(() => {});

const fakeScheduler = (triggerNow: Scheduler['triggerNow']): Scheduler => ({
  start: () => {},
  stop: () => {},
  triggerNow,
});

const baseDeps = (overrides: Partial<AppDeps> = {}): AppDeps => ({
  scheduler: fakeScheduler(async () => []),
  listRecentRuns: async () => [],
  listAttempts: async () => [],
  logger: silentLogger,
  ...overrides,
});

test('GET /health returns 200 ok', async () => {
  const app = createApp(baseDeps());

  const res = await request(app).get('/health');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'ok' });
});

test('POST /sync/trigger with no body syncs every account', async () => {
  const seen: (string | undefined)[] = [];
  const completed: SyncResult = { status: 'completed', pagesProcessed: 1, newRecords: 3 };
  const app = createApp(baseDeps({
    scheduler: fakeScheduler(async (accountId) => {
      seen.push(accountId);
      return [completed];
    }),
  }));

  const res = await request(app).post('/sync/trigger').send({});
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ results: [completed] });
  expect(seen).toEqual([undefined]);
});

test('POST /sync/trigger with an accountId syncs only that account', async () => {
  const seen: (string | undefined)[] = [];
  const app = createApp(baseDeps({
    scheduler: fakeScheduler(async (accountId) => {
      seen.push(accountId);
      return [];
    }),
  }));

  await request(app).post('/sync/trigger').send({ accountId: 'acc-1' });
  expect(seen).toEqual(['acc-1']);
});

test('POST /sync/trigger returns 500 when the trigger throws', async () => {
  const app = createApp(baseDeps({
    scheduler: fakeScheduler(async () => {
      throw new Error('boom');
    }),
  }));

  const res = await request(app).post('/sync/trigger').send({});
  expect(res.status).toBe(500);
});

test('GET /sync/status returns recent runs, defaulting limit to 20', async () => {
  let requestedLimit = 0;
  const run: SyncRunSummary = {
    id: 1,
    accountId: 'acc-1',
    status: 'COMPLETED',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:01Z',
    pagesProcessed: 1,
    newRecords: 2,
    error: null,
    consecutiveFailures: 0,
    nextRetryAt: null,
  };
  const app = createApp(baseDeps({
    listRecentRuns: async (limit) => {
      requestedLimit = limit;
      return [run];
    },
  }));

  const res = await request(app).get('/sync/status');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ runs: [run] });
  expect(requestedLimit).toBe(20);
});

test('GET /sync/status honours an explicit limit, capped at 100', async () => {
  let requestedLimit = 0;
  const app = createApp(baseDeps({
    listRecentRuns: async (limit) => {
      requestedLimit = limit;
      return [];
    },
  }));

  await request(app).get('/sync/status?limit=5');
  expect(requestedLimit).toBe(5);

  await request(app).get('/sync/status?limit=9999');
  expect(requestedLimit).toBe(100);
});

test('GET /sync/runs/:runId/attempts returns the attempt trail for that run', async () => {
  let requestedRunId = 0;
  const attempt: SyncAttemptSummary = {
    id: 1,
    pageIndex: 0,
    attemptNumber: 1,
    outcome: 'retrying',
    errorKind: 'transient',
    errorMessage: 'gateway timeout',
    delayMs: 200,
    attemptedAt: '2026-01-01T00:00:00Z',
  };
  const app = createApp(baseDeps({
    listAttempts: async (runId) => {
      requestedRunId = runId;
      return [attempt];
    },
  }));

  const res = await request(app).get('/sync/runs/42/attempts');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ attempts: [attempt] });
  expect(requestedRunId).toBe(42);
});

test('GET /sync/runs/:runId/attempts rejects a non-numeric runId', async () => {
  const app = createApp(baseDeps());

  const res = await request(app).get('/sync/runs/not-a-number/attempts');
  expect(res.status).toBe(400);
});

test('GET /sync/runs/:runId/attempts returns 500 when the lookup throws', async () => {
  const app = createApp(baseDeps({
    listAttempts: async () => {
      throw new Error('db down');
    },
  }));

  const res = await request(app).get('/sync/runs/1/attempts');
  expect(res.status).toBe(500);
});
