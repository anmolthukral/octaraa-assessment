import express, { Express } from 'express';
import { Scheduler } from './sync/scheduler';
import { SyncRunSummary } from './sync/postgresSyncRuns';
import { SyncAttemptSummary } from './sync/postgresSyncAttempts';
import { Logger } from './logger';

/**
 * HTTP surface around the sync engine: a health check for orchestration
 * (load balancers, container platforms), a manual trigger for on-demand
 * syncs, a status endpoint for recent sync_runs, and a drill-down into the
 * retry attempts behind one run. The cron scheduler (src/sync/scheduler.ts)
 * still owns periodic syncing; this app is the operational front door onto
 * the same running process, not a separate worker — see
 * docs/technical-note.md for the queue-based split at scale.
 */
export interface AppDeps {
  scheduler: Scheduler;
  listRecentRuns: (limit: number) => Promise<SyncRunSummary[]>;
  listAttempts: (runId: number) => Promise<SyncAttemptSummary[]>;
  logger: Logger;
}

export const createApp = (deps: AppDeps): Express => {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.post('/sync/trigger', async (req, res) => {
    const accountId = typeof req.body?.accountId === 'string' ? req.body.accountId : undefined;
    try {
      const results = await deps.scheduler.triggerNow(accountId);
      res.status(200).json({ results });
    } catch (err) {
      deps.logger.error('sync_trigger_failed', { error: String(err) });
      res.status(500).json({ error: 'sync trigger failed' });
    }
  });

  app.get('/sync/status', async (req, res) => {
    const rawLimit = Number(req.query['limit']);
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
    try {
      const runs = await deps.listRecentRuns(limit);
      res.status(200).json({ runs });
    } catch (err) {
      deps.logger.error('sync_status_failed', { error: String(err) });
      res.status(500).json({ error: 'failed to fetch sync status' });
    }
  });

  app.get('/sync/runs/:runId/attempts', async (req, res) => {
    const runId = Number(req.params.runId);
    if (!Number.isInteger(runId) || runId <= 0) {
      res.status(400).json({ error: 'runId must be a positive integer' });
      return;
    }
    try {
      const attempts = await deps.listAttempts(runId);
      res.status(200).json({ attempts });
    } catch (err) {
      deps.logger.error('sync_attempts_failed', { runId, error: String(err) });
      res.status(500).json({ error: 'failed to fetch attempts' });
    }
  });

  return app;
};
