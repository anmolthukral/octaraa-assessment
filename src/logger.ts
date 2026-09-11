export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info: (event: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, meta?: Record<string, unknown>) => void;
  error: (event: string, meta?: Record<string, unknown>) => void;
}

type WriteFn = (line: string) => void;

const defaultWrite: WriteFn = (line) => {
  process.stdout.write(`${line}\n`);
};

const writeLine = (write: WriteFn, level: LogLevel, event: string, meta?: Record<string, unknown>): void => {
  write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...meta }));
};

export const createLogger = (write: WriteFn = defaultWrite): Logger => ({
  info: (event, meta) => writeLine(write, 'info', event, meta),
  warn: (event, meta) => writeLine(write, 'warn', event, meta),
  error: (event, meta) => writeLine(write, 'error', event, meta),
});

/** Boot a leaf script with a single-line stderr message (no stack dump) on failure. */
export const runLeaf = (main: () => Promise<void>): void => {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
};
