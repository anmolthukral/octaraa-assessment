/**
 * Minimal database client surface the Postgres stores need.
 *
 * `pg.Pool` is adapted to this interface at the wiring boundary (see
 * src/server.ts); unit tests inject an in-memory fake. Depending on the
 * narrow interface instead of `pg` directly keeps every store testable
 * without a live database.
 */
export interface DbRow {
  [column: string]: unknown;
}

export interface DbResult {
  rows: DbRow[];
  rowCount: number;
}

export interface DbClient {
  query: (text: string, params?: unknown[]) => Promise<DbResult>;
}

export const textOf = (row: DbRow, column: string): string => String(row[column] ?? '');

export const numberOf = (row: DbRow, column: string): number => Number(row[column] ?? 0);
