import { DbClient, DbRow, DbResult } from './dbClient';

/** In-memory DbClient double: records queries, answers via onQuery. */
export const createFakeDbClient = (handlers: {
  onQuery?: (text: string, params?: unknown[]) => DbRow[];
} = {}): DbClient & { queries: { text: string; params?: unknown[] }[] } => {
  const queries: { text: string; params?: unknown[] }[] = [];
  const query = async (text: string, params?: unknown[]): Promise<DbResult> => {
    queries.push({ text, params });
    const rows = handlers.onQuery ? handlers.onQuery(text, params) : [];
    return { rows, rowCount: rows.length };
  };
  return { query, queries };
};
