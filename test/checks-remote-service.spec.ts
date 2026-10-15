import { ChecksService } from '../src/checks/checks.service';
const finding = (tool: string, rule: string) => ({
  tool,
  rule,
  file: 'a.php',
  line: 2,
  message: 'm',
});
test('in a coder workspace the checks run there; only findings absent at the base count', async () => {
  const output = {
    tools: {
      semgrep: {
        files: 1,
        cur: [{ key: 'k1', finding: finding('semgrep', 'eval-use') }],
        base: [],
      },
      gitleaks: {
        files: 1,
        cur: [{ key: 'k2', finding: finding('gitleaks', 'generic-api-key') }],
        base: [{ key: 'k2', finding: finding('gitleaks', 'generic-api-key') }],
      },
    },
    errors: ['osv: exit 2: pull access denied'],
  };
  const ws = {
    kind: 'coder',
    run: jest.fn().mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: `noise\n${JSON.stringify(output)}\n`,
      stderr: '',
    }),
  };
  const git = { changedSince: jest.fn().mockResolvedValue(['a.php']) };
  const containers = { run: jest.fn() };
  const service = new ChecksService(git as any, containers as any, { of: () => ws } as any);
  const cfg = {
    tools: ['gitleaks', 'semgrep', 'osv'],
    semgrep: { configs: ['p/php'] },
    blocking: true,
    reportOnly: [],
    images: { gitleaks: 'g', semgrep: 's', osv: 'o' },
  } as any;
  const result = await service.run({ id: 't', tenantId: 'initech' } as any, cfg, 'b'.repeat(40));
  expect(result.findings).toEqual([finding('semgrep', 'eval-use')]);
  expect(result.tools).toEqual({
    semgrep: { files: 1, now: 1, base: 0 },
    gitleaks: { files: 1, now: 1, base: 1 },
  });
  expect(result.errors).toEqual(['osv: exit 2: pull access denied']);
  expect(containers.run).not.toHaveBeenCalled();
  const [argv, opts] = ws.run.mock.calls[0];
  expect(argv.slice(0, 2)).toEqual(['python3', '-c']);
  expect(JSON.parse(opts.input)).toMatchObject({
    base: 'b'.repeat(40),
    files: ['a.php'],
    semgrep: ['p/php'],
  });
});
test('a broken answer from the workspace is reported, never blocks', async () => {
  const ws = {
    kind: 'coder',
    run: jest
      .fn()
      .mockResolvedValue({ success: false, exitCode: 1, stdout: '', stderr: 'python3: not found' }),
  };
  const service = new ChecksService(
    { changedSince: jest.fn().mockResolvedValue(['a.php']) } as any,
    { run: jest.fn() } as any,
    { of: () => ws } as any,
  );
  const result = await service.run(
    { id: 't', tenantId: 'initech' } as any,
    { tools: ['gitleaks'], images: {}, blocking: true, reportOnly: [] } as any,
    'b'.repeat(40),
  );
  expect(result.findings).toEqual([]);
  expect(result.errors[0]).toMatch(/python3: not found/);
});
