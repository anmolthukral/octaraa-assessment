import { Pool } from 'pg';
import { createLogger, runLeaf } from '../logger';

/**
 * Links a test Finvu account so the scheduler has something to sync.
 * Run with: npm run seed   (requires DATABASE_URL, see .env.example)
 */
const PROVIDER_ID = 'finvu';
const ACCOUNT_ID = 'finvu-acc-1';

const main = async (): Promise<void> => {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('missing required env var: DATABASE_URL (see .env.example)');
  const logger = createLogger();
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(
      `INSERT INTO provider_accounts (provider_id, external_account_ref)
       VALUES ($1, $2)
       ON CONFLICT (provider_id, external_account_ref) DO NOTHING`,
      [PROVIDER_ID, ACCOUNT_ID],
    );
    logger.info('seed_complete', { providerId: PROVIDER_ID, accountId: ACCOUNT_ID });
  } finally {
    await pool.end();
  }
};

runLeaf(main);
