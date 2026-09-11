import { createFakeDbClient } from '../db/fakeDbClient';
import { recordSyncAttempt, listAttemptsForRun } from './postgresSyncAttempts';

test('recordSyncAttempt inserts one row with error fields null on success', async () => {
  const db = createFakeDbClient();
  await recordSyncAttempt(db, 7, 0, { attempt: 1, outcome: 'success' });

  expect(db.queries).toHaveLength(1);
  expect(db.queries[0]?.text).toMatch(/INSERT INTO sync_attempts/);
  expect(db.queries[0]?.params).toEqual([7, 0, 1, 'success', null, null, null]);
});

test('recordSyncAttempt captures error kind/message and delay on a retrying attempt', async () => {
  const db = createFakeDbClient();
  await recordSyncAttempt(db, 7, 2, {
    attempt: 1,
    outcome: 'retrying',
    error: { kind: 'transient', message: 'gateway timeout' },
    delayMs: 250,
  });

  expect(db.queries[0]?.params).toEqual([7, 2, 1, 'retrying', 'transient', 'gateway timeout', 250]);
});

test('listAttemptsForRun maps rows in page/attempt order', async () => {
  const db = createFakeDbClient({
    onQuery: () => [
      {
        id: 1,
        page_index: 0,
        attempt_number: 1,
        outcome: 'retrying',
        error_kind: 'rate_limited',
        error_message: 'slow down',
        delay_ms: 500,
        attempted_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 2,
        page_index: 0,
        attempt_number: 2,
        outcome: 'success',
        error_kind: null,
        error_message: null,
        delay_ms: null,
        attempted_at: '2026-01-01T00:00:01Z',
      },
    ],
  });

  const attempts = await listAttemptsForRun(db, 7);

  expect(db.queries[0]?.text).toMatch(/ORDER BY page_index ASC, attempt_number ASC/);
  expect(db.queries[0]?.params).toEqual([7]);
  expect(attempts).toEqual([
    {
      id: 1,
      pageIndex: 0,
      attemptNumber: 1,
      outcome: 'retrying',
      errorKind: 'rate_limited',
      errorMessage: 'slow down',
      delayMs: 500,
      attemptedAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 2,
      pageIndex: 0,
      attemptNumber: 2,
      outcome: 'success',
      errorKind: null,
      errorMessage: null,
      delayMs: null,
      attemptedAt: '2026-01-01T00:00:01Z',
    },
  ]);
});
