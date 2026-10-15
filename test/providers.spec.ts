import { CodexProvider } from '../src/agents/codex.provider';
import { ClaudeProvider } from '../src/agents/claude.provider';
import { AgentService } from '../src/agents/agent.service';
const input = {
  taskId: 'task',
  tenantId: 'acme',
  credentialId: 'openai-main',
  workspace: '/tmp/task',
  prompt: 'untrusted; $(touch /tmp/never)',
  timeoutMs: 1000,
};
const success = {
  success: true,
  stdout: '--ask-for-approval --json --sandbox --print --output-format --permission-mode',
  stderr: '',
  exitCode: 0,
};
test('Codex checks installed capabilities and sends prompt through stdin', async () => {
  const runner = { run: jest.fn().mockResolvedValue(success) },
    sandbox = { run: jest.fn().mockResolvedValue(success) };
  await new CodexProvider(runner as any, sandbox as any).execute(input);
  expect(runner.run).toHaveBeenCalledTimes(2);
  expect(sandbox.run.mock.calls[0][1]).toEqual([
    '--ask-for-approval',
    'never',
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '-',
  ]);
  expect(sandbox.run.mock.calls[0][2].input).toBe(input.prompt);
});
test('unsupported Codex fails before invoking agent', async () => {
  const sandbox = { run: jest.fn() };
  await expect(
    new CodexProvider(
      { run: jest.fn().mockResolvedValue({ ...success, stdout: '' }) } as any,
      sandbox as any,
    ).execute(input),
  ).rejects.toThrow('Installed Codex');
  expect(sandbox.run).not.toHaveBeenCalled();
});
test('Claude respects error result even with zero exit code', async () => {
  const provider = new ClaudeProvider(
    { run: jest.fn().mockResolvedValue(success) } as any,
    { run: jest.fn().mockResolvedValue({ ...success, stdout: '{"is_error":true}' }) } as any,
  );
  expect((await provider.execute(input)).success).toBe(false);
});
test('provider abstraction dispatches and rejects unsupported names', async () => {
  const codex = { execute: jest.fn().mockResolvedValue(success) },
    claude = { execute: jest.fn() };
  const service = new AgentService(codex as any, claude as any, {} as any);
  await service.execute('codex', input);
  expect(codex.execute).toHaveBeenCalledWith(input);
  expect(claude.execute).not.toHaveBeenCalled();
  expect(() => service.execute('unknown', input)).toThrow('Unsupported');
});
const attachments = {
  dir: '/srv/attachments/acme/api/x',
  files: [
    { name: 'screen.png', contentType: 'image/png', size: 1 },
    { name: 'spec.pdf', contentType: 'application/pdf', size: 1 },
  ],
};
test('Codex sends images natively, before a flag that closes the list', async () => {
  const help = { ...success, stdout: `${success.stdout} --image` },
    sandbox = { run: jest.fn().mockResolvedValue(success) };
  await new CodexProvider(
    { run: jest.fn().mockResolvedValue(help) } as any,
    sandbox as any,
  ).execute({ ...input, attachments });
  const args: string[] = sandbox.run.mock.calls[0][1];
  expect(args.slice(2, 5)).toEqual(['exec', '--image', '/attachments/screen.png']);
  expect(args[5]).toBe('--json');
  expect(args).not.toContain('/attachments/spec.pdf');
  expect(args.at(-1)).toBe('-');
  expect(sandbox.run.mock.calls[0][2].attachmentsDir).toBe(attachments.dir);
});
test('Claude gets the read-only attachments directory added to its working directories', async () => {
  const help = { ...success, stdout: `${success.stdout} --add-dir` },
    sandbox = { run: jest.fn().mockResolvedValue({ ...success, stdout: '{}' }) };
  await new ClaudeProvider(
    { run: jest.fn().mockResolvedValue(help) } as any,
    sandbox as any,
  ).execute({ ...input, attachments });
  const args: string[] = sandbox.run.mock.calls[0][1];
  expect(args.slice(0, 3)).toEqual(['--add-dir', '/attachments', '--print']);
  expect(sandbox.run.mock.calls[0][2].attachmentsDir).toBe(attachments.dir);
});
test('no attachments means no extra flags', async () => {
  const help = { ...success, stdout: `${success.stdout} --add-dir` },
    sandbox = { run: jest.fn().mockResolvedValue({ ...success, stdout: '{}' }) };
  await new ClaudeProvider(
    { run: jest.fn().mockResolvedValue(help) } as any,
    sandbox as any,
  ).execute(input);
  expect(sandbox.run.mock.calls[0][1]).not.toContain('--add-dir');
});
