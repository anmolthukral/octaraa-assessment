import { createLogger, runLeaf } from './logger';

test('writes a single JSON line per call with level, event, ts, and meta', () => {
  const writes: string[] = [];
  const write = (line: string): void => { writes.push(line); };
  const logger = createLogger(write);

  logger.info('sync_completed', { accountId: 'acc-1', pagesProcessed: 3 });

  expect(writes).toHaveLength(1);
  const parsed = JSON.parse(writes[0]!);
  expect(parsed).toMatchObject({
    level: 'info',
    event: 'sync_completed',
    accountId: 'acc-1',
    pagesProcessed: 3,
  });
  expect(typeof parsed.ts).toBe('string');
});

test('runLeaf resolves quietly on success and reports failures without throwing', async () => {
  await new Promise<void>((resolve) => {
    runLeaf(async () => {});
    setTimeout(resolve, 0);
  });

  const errors: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  const originalExitCode = process.exitCode;
  process.stderr.write = ((chunk: string): boolean => {
    errors.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  runLeaf(async () => {
    throw new Error('boot failed');
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.stderr.write = originalWrite;
  process.exitCode = originalExitCode;

  expect(errors).toEqual(['boot failed\n']);
});
