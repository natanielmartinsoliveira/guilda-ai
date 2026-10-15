import { ProcessRunnerService } from '../src/agents/process-runner.service';
const service = new ProcessRunnerService({} as any);
test('captures real subprocess streams and exit code', async () => {
  const r = await service.run(
    process.execPath,
    ['-e', 'process.stdout.write("ok");process.stderr.write("bad");process.exit(3)'],
    { cwd: process.cwd(), timeoutMs: 2000 },
  );
  expect(r).toEqual({ success: false, exitCode: 3, stdout: 'ok', stderr: 'bad' });
});
test('kills timed-out subprocess', async () => {
  const r = await service.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    cwd: process.cwd(),
    timeoutMs: 50,
  });
  expect(r.success).toBe(false);
  expect(r.stderr).toContain('timed out');
});
test('bounds output', async () => {
  const r = await service.run(process.execPath, ['-e', 'process.stdout.write("a".repeat(5000))'], {
    cwd: process.cwd(),
    timeoutMs: 2000,
  });
  expect(r.stdout.length).toBeLessThanOrEqual(1024);
  expect(r.stderr).toContain('Output limit');
});
test('handles missing binary and removes secrets', async () => {
  const missing = await service.run('/does/not/exist', [], { cwd: process.cwd(), timeoutMs: 500 });
  expect(missing.success).toBe(false);
  const r = await service.run(process.execPath, ['-e', 'process.stdout.write(process.env.KEY)'], {
    cwd: process.cwd(),
    timeoutMs: 2000,
    env: { KEY: process.env.GLOBEX_GITHUB_TOKEN },
  });
  expect(r.stdout).toBe('[REDACTED]');
});
test('audit copy is storable in PostgreSQL even when output has NUL bytes', async () => {
  const update = jest.fn();
  const db = {
    getRepository: () => ({ save: jest.fn().mockResolvedValue({ id: 'run' }), update }),
  };
  const r = await new ProcessRunnerService(db as any).run(
    process.execPath,
    // The child produces the NUL bytes itself: argv cannot carry them.
    ['-e', 'process.stdout.write(["a.ts", "b.ts", ""].join(String.fromCharCode(0)))'],
    { cwd: process.cwd(), timeoutMs: 2000, taskId: 't' },
  );
  // The caller still gets the raw separators (git -z parsing depends on them)...
  expect(r.stdout).toBe('a.ts\0b.ts\0');
  // ...while the stored copy has none: a visible "\0" marker instead.
  expect(update.mock.calls[0][1].stdout).toBe('a.ts\\0b.ts\\0');
  expect(update.mock.calls[0][1].stdout).not.toContain('\u0000');
});
test('one command may allow more output; its audit copy stays bounded (ls-files of a big repo)', async () => {
  const update = jest.fn();
  const db = {
    getRepository: () => ({ save: jest.fn().mockResolvedValue({ id: 'run' }), update }),
  };
  const r = await new ProcessRunnerService(db as any).run(
    process.execPath,
    ['-e', 'process.stdout.write("a".repeat(5000))'],
    { cwd: process.cwd(), timeoutMs: 2000, taskId: 't', maxOutputBytes: 10000 },
  );
  expect(r.success).toBe(true);
  expect(r.stdout).toHaveLength(5000);
  // The database keeps at most the usual cap (1024 in tests).
  expect(update.mock.calls[0][1].stdout.length).toBeLessThanOrEqual(1024);
});
test('auditContent false keeps sizes, never the output (code kept off this machine)', async () => {
  const update = jest.fn();
  const db = {
    getRepository: () => ({ save: jest.fn().mockResolvedValue({ id: 'run' }), update }),
  };
  const r = await new ProcessRunnerService(db as any).run(
    process.execPath,
    ['-e', 'process.stdout.write("secret-code\\n");process.stderr.write("err\\n")'],
    { cwd: process.cwd(), timeoutMs: 2000, taskId: 't', auditContent: false },
  );
  expect(r.stdout).toBe('secret-code\n');
  expect(update.mock.calls[0][1].stdout).toBe('[12 bytes omitted]');
  expect(update.mock.calls[0][1].stderr).toBe('[4 bytes omitted]');
});
