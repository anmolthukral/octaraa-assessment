import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { createLogger, runLeaf } from '../logger';

/**
 * Migration runner with up/down support.
 * Run with:
 *   npm run migrate:up     — Apply all pending migrations
 *   npm run migrate:down   — Rollback last migration
 */

const main = async (): Promise<void> => {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('missing required env var: DATABASE_URL (see .env.example)');
  const logger = createLogger();
  const direction = process.argv[2] === 'down' ? 'down' : 'up';

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    // Ensure migrations table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        version INT PRIMARY KEY,
        name TEXT NOT NULL,
        executed_at TIMESTAMPTZ DEFAULT now()
      )
    `);

    const migrationsDir = path.join(__dirname, '../../db/migrations');
    const files = fs.readdirSync(migrationsDir).sort();

    if (direction === 'up') {
      // Apply pending migrations
      const applied = await pool.query('SELECT version FROM migrations ORDER BY version DESC LIMIT 1');
      const lastVersion = applied.rows[0]?.version ?? 0;

      for (const file of files) {
        if (!file.endsWith('.up.sql')) continue;

        const match = file.match(/^(\d+)_/);
        if (!match || !match[1]) continue;

        const version = parseInt(match[1], 10);
        if (version <= lastVersion) continue;

        try {
          const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
          await pool.query(sql);
          await pool.query('INSERT INTO migrations (version, name) VALUES ($1, $2)', [version, file]);
          logger.info('migration_applied', { file, version });
        } catch (err) {
          logger.error('migration_failed', { file, version, error: String(err) });
          throw err;
        }
      }
      logger.info('migrations_complete', { direction: 'up' });
    } else {
      // Rollback last migration
      const applied = await pool.query('SELECT version, name FROM migrations ORDER BY version DESC LIMIT 1');
      if (applied.rows.length === 0) {
        logger.info('no_migrations_to_rollback', {});
        return;
      }

      const { version, name } = applied.rows[0];
      const downFile = name.replace('.up.sql', '.down.sql');
      const downPath = path.join(migrationsDir, downFile);

      if (!fs.existsSync(downPath)) {
        throw new Error(`Down migration not found: ${downFile}`);
      }

      try {
        const sql = fs.readFileSync(downPath, 'utf8');
        await pool.query(sql);
        await pool.query('DELETE FROM migrations WHERE version = $1', [version]);
        logger.info('migration_rolled_back', { file: downFile, version });
      } catch (err) {
        logger.error('rollback_failed', { file: downFile, version, error: String(err) });
        throw err;
      }
    }
  } finally {
    await pool.end();
  }
};

runLeaf(main);
