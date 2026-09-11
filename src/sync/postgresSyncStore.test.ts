import { createFakeDbClient } from '../db/fakeDbClient';
import { createPostgresSyncStateStore } from './postgresSyncStateStore';
import { finishSyncRun, startSyncRun } from './postgresSyncRuns';

const accountInsert = { id: 5 };

test('pg state store round-trips the cursor through the account row', async () => {
  const db = createFakeDbClient({
    onQuery: (text) => {
      if (text.startsWith('INSERT INTO provider_accounts')) return [accountInsert];
      if (text.startsWith('SELECT last_sync_cursor')) return [{ last_sync_cursor: 'session-1:2' }];
      return [];
    },
  });
  const store = createPostgresSyncStateStore(db, 'finvu');

  await expect(store.getCursor('acc-1')).resolves.toBe('session-1:2');
  await store.setCursor('acc-1', null);
  const update = db.queries.find((q) => q.text.startsWith('UPDATE provider_accounts'));
  expect(update?.params).toEqual([null, 5]);
});

test('pg state store maps a NULL cursor to null', async () => {
  const db = createFakeDbClient({
    onQuery: (text) => {
      if (text.startsWith('INSERT INTO provider_accounts')) return [accountInsert];
      return [{ last_sync_cursor: null }];
    },
  });
  const store = createPostgresSyncStateStore(db, 'finvu');
  await expect(store.getCursor('acc-1')).resolves.toBeNull();
});

test('startSyncRun returns null when another worker holds the RUNNING row', async () => {
  const db = createFakeDbClient({
    onQuery: (text) => (text.startsWith('INSERT INTO provider_accounts') ? [accountInsert] : []),
  });
  await expect(startSyncRun(db, 'finvu', 'acc-1')).resolves.toBeNull();
  const insert = db.queries.find((q) => q.text.startsWith('INSERT INTO sync_runs'));
  expect(insert?.text).toMatch(/ON CONFLICT.*DO NOTHING/);
});

test('finishSyncRun closes a completed run and deletes a skipped one', async () => {
  const db = createFakeDbClient();
  await finishSyncRun(db, 42, { status: 'completed', pagesProcessed: 3, newRecords: 6 });
  const update = db.queries.find((q) => q.text.startsWith('UPDATE sync_runs'));
  expect(update?.params).toEqual(['COMPLETED', 3, 6, null, 42]);

  await finishSyncRun(db, 43, { status: 'skipped', reason: 'already_in_progress' });
  const deletion = db.queries.find((q) => q.text.startsWith('DELETE FROM sync_runs'));
  expect(deletion?.params).toEqual([43]);
});

test('finishSyncRun persists the failure payload as JSON', async () => {
  const db = createFakeDbClient();
  await finishSyncRun(db, 44, {
    status: 'failed',
    pagesProcessed: 1,
    newRecords: 2,
    error: { kind: 'transient', message: 'boom' },
  });
  const update = db.queries.find((q) => q.text.startsWith('UPDATE sync_runs'));
  expect(update?.params?.[0]).toBe('FAILED');
  expect(update?.params?.[3]).toBe(JSON.stringify({ kind: 'transient', message: 'boom' }));
});
