import { DataSource } from 'typeorm';
import { classifyFailure, retryAfterMinutes } from '../src/agents/failure';
import { codexErrors } from '../src/agents/codex.provider';
import { ClaudeProvider } from '../src/agents/claude.provider';
import { AgentRouter, CapacityError } from '../src/agents/agent-router.service';
import { CredentialState } from '../src/database/entities';
import { findTenant } from '../src/tenants/tenants';
import { database } from './db';
const failed = (errorText?: string, stderr = '') => ({
  success: false,
  stdout: '',
  stderr,
  exitCode: 1,
  errorText,
});
test('classifies capacity failures by the provider error channel', () => {
  expect(classifyFailure(failed('Credit balance is too low'))).toBe('quota');
  expect(classifyFailure(failed("You've hit your usage limit. Try again in 2 days."))).toBe(
    'quota',
  );
  expect(classifyFailure(failed('status 429: insufficient_quota'))).toBe('quota');
  // A spend limit set by the company's admin: it does not pass in minutes (first real run).
  expect(
    classifyFailure(
      failed(
        "status 429: You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit",
      ),
    ),
  ).toBe('quota');
  expect(classifyFailure(failed('status 401: invalid x-api-key'))).toBe('auth');
  expect(classifyFailure(failed(undefined, 'Error: Not logged in. Please run /login'))).toBe(
    'auth',
  );
  expect(classifyFailure(failed('stream error: 429 Too Many Requests'))).toBe('rate_limit');
  expect(classifyFailure(failed('Overloaded'))).toBe('rate_limit');
});
test('agent transcript mentioning limits is not a capacity failure', () => {
  // Codex puts the agent's own work (including test logs) on stdout, never classified.
  const r = {
    ...failed(undefined, 'tests failed'),
    stdout: '{"type":"item","text":"429 rate limit test"}',
  };
  expect(classifyFailure(r)).toBe('task');
  expect(classifyFailure(failed('usage limit', 'Process timed out'))).toBe('task');
});
test('reads the retry hint the provider gives', () => {
  expect(retryAfterMinutes(failed('Try again in 2 days.'))).toBe(2880);
  expect(retryAfterMinutes(failed('please retry after 90 seconds'))).toBe(2);
  expect(retryAfterMinutes(failed('limit reached'))).toBeUndefined();
});
test('extracts Codex error events from JSONL, ignoring agent output', () => {
  const stdout = [
    '{"type":"thread.started"}',
    '{"type":"item.completed","item":{"text":"quota tests pass"}}',
    '{"type":"error","message":"stream error: 429 Too Many Requests"}',
    '{"type":"turn.failed","error":{"message":"You exceeded your current quota"}}',
    '{"id":"0","msg":{"type":"error","message":"legacy format"}}',
    'not json',
  ].join('\n');
  expect(codexErrors(stdout)).toBe(
    'stream error: 429 Too Many Requests\nYou exceeded your current quota\nlegacy format',
  );
  expect(codexErrors('{"type":"item.completed"}')).toBeUndefined();
});
test('Claude error result is surfaced even with a non-zero exit code', async () => {
  const help = {
    success: true,
    stdout: '--print --output-format --permission-mode',
    stderr: '',
    exitCode: 0,
  };
  const provider = new ClaudeProvider(
    { run: jest.fn().mockResolvedValue(help) } as any,
    {
      run: jest.fn().mockResolvedValue({
        success: false,
        exitCode: 1,
        stderr: '',
        stdout: '{"is_error":true,"api_error_status":429,"result":"Claude AI usage limit reached"}',
      }),
    } as any,
  );
  const r = await provider.execute({
    taskId: 't',
    tenantId: 'acme',
    credentialId: 'claude-max',
    workspace: '/w',
    prompt: 'p',
    timeoutMs: 1000,
  });
  expect(r.errorText).toBe('status 429: Claude AI usage limit reached');
  expect(classifyFailure(r)).toBe('quota');
});
describe('AgentRouter', () => {
  let db: DataSource;
  beforeEach(async () => {
    db = await database();
  });
  afterEach(async () => {
    await db.destroy();
  });
  const input = { taskId: 't', tenantId: 'acme', workspace: '/w', prompt: 'p' };
  const ok = { success: true, stdout: 'ok', stderr: '', exitCode: 0 };
  test('uses the provider retry hint as cooldown and skips the parked credential later', async () => {
    const agents = {
      execute: jest
        .fn()
        .mockResolvedValueOnce(failed('Rate limited. Try again in 3 hours.'))
        .mockResolvedValue(ok),
    };
    const router = new AgentRouter(db, agents as any);
    const tenant = findTenant('acme')!;
    const first = await router.run(tenant, 'coder', input, jest.fn());
    expect(first.credential.id).toBe('claude-max');
    const state = await db
      .getRepository(CredentialState)
      .findOneByOrFail({ tenantId: 'acme', credentialId: 'openai-main' });
    expect(state.reason).toBe('rate_limit');
    expect(Math.round((state.unavailableUntil.getTime() - Date.now()) / 60000)).toBe(180);
    agents.execute.mockClear();
    await router.run(tenant, 'coder', input, jest.fn());
    expect(agents.execute).toHaveBeenCalledTimes(1);
    expect(agents.execute.mock.calls[0][0]).toBe('claude');
  });
  test('a credential is used again once its cooldown has passed', async () => {
    await db.getRepository(CredentialState).save({
      tenantId: 'acme',
      credentialId: 'openai-main',
      unavailableUntil: new Date(Date.now() - 1000),
      reason: 'quota',
    });
    const agents = { execute: jest.fn().mockResolvedValue(ok) };
    const run = await new AgentRouter(db, agents as any).run(
      findTenant('acme')!,
      'coder',
      input,
      jest.fn(),
    );
    expect(run.credential.id).toBe('openai-main');
  });
  test('credential state is per tenant', async () => {
    await db.getRepository(CredentialState).save({
      tenantId: 'globex',
      credentialId: 'openai-main',
      unavailableUntil: new Date(Date.now() + 3600000),
      reason: 'quota',
    });
    const agents = { execute: jest.fn().mockResolvedValue(ok) };
    const run = await new AgentRouter(db, agents as any).run(
      findTenant('acme')!,
      'coder',
      input,
      jest.fn(),
    );
    expect(run.credential.id).toBe('openai-main');
  });
  test('auth failures ignore retry hints and use the long auth cooldown', async () => {
    const agents = {
      execute: jest.fn().mockResolvedValue(failed('invalid_api_key, try again in 1 minute')),
    };
    await expect(
      new AgentRouter(db, agents as any).run(findTenant('globex')!, 'coder', input, jest.fn()),
    ).rejects.toBeInstanceOf(CapacityError);
    const state = await db
      .getRepository(CredentialState)
      .findOneByOrFail({ tenantId: 'globex', credentialId: 'anthropic' });
    expect(state.reason).toBe('auth');
    expect(Math.round((state.unavailableUntil.getTime() - Date.now()) / 60000)).toBe(1440);
  });
});
