import { DataSource } from 'typeorm';
import { loadTenants, useTenants } from '../src/tenants/tenants';
import { redact } from '../src/config';
import { AgentRouter, roleTargets } from '../src/agents/agent-router.service';
import { AgentService } from '../src/agents/agent.service';
import { CodexProvider } from '../src/agents/codex.provider';
import { ClaudeProvider } from '../src/agents/claude.provider';
import { GeminiProvider, geminiOutput } from '../src/agents/gemini.provider';
import { classifyFailure } from '../src/agents/failure';
import { parseReview, parseTag, reviewSummary } from '../src/tasks/pr-description';
import { database } from './db';
const yaml = (ai: string) => `
tenants:
  - id: acme
    name: Acme
    git: { authorName: Bot, authorEmail: bot@acme.test }
    ai:
${ai}
    hosts: [{ id: gh, type: github, token: tok }]
    projects: [{ id: api, host: gh, repository: acme/api, test: [npm, test] }]
`;
const credentials = `      providers: [claude, codex, openrouter]
      credentials:
        - { id: claude-max, provider: claude, model: opus, effort: high }
        - { id: chatgpt, provider: codex }
        - { id: router, provider: openrouter, apiKey: or-key, model: deepseek/deepseek-chat }`;
describe('roles in tenants.yaml', () => {
  test('without roles: coder and fixer use every credential; reviewer and planner are off', () => {
    const [t] = loadTenants(yaml(credentials));
    expect(roleTargets(t, 'coder').map((r) => [r.credential.id, r.model, r.effort])).toEqual([
      ['claude-max', 'opus', 'high'],
      ['chatgpt', undefined, undefined],
      ['router', 'deepseek/deepseek-chat', undefined],
    ]);
    expect(roleTargets(t, 'fixer').map((r) => r.credential.id)).toEqual([
      'claude-max',
      'chatgpt',
      'router',
    ]);
    expect(roleTargets(t, 'reviewer')).toEqual([]);
    expect(roleTargets(t, 'planner')).toEqual([]);
    expect(t.ai.review.rounds).toBe(1);
  });
  test('roles pick credentials, models and effort; fixer follows coder unless set', () => {
    const [t] = loadTenants(
      yaml(`${credentials}
      roles:
        coder: [{ credential: claude-max, model: opus, effort: max }, chatgpt]
        reviewer: [{ credential: chatgpt, effort: medium }]
        planner: [claude-max]
      review: { rounds: 2 }`),
    );
    expect(roleTargets(t, 'coder').map((r) => [r.credential.id, r.model, r.effort])).toEqual([
      ['claude-max', 'opus', 'max'],
      ['chatgpt', undefined, undefined],
    ]);
    expect(roleTargets(t, 'fixer').map((r) => r.credential.id)).toEqual(['claude-max', 'chatgpt']);
    expect(roleTargets(t, 'reviewer').map((r) => [r.credential.id, r.effort])).toEqual([
      ['chatgpt', 'medium'],
    ]);
    // Credential defaults apply when the role entry does not override them.
    expect(roleTargets(t, 'planner').map((r) => [r.model, r.effort])).toEqual([['opus', 'high']]);
    expect(t.ai.review.rounds).toBe(2);
  });
  test('rejects roles naming unknown credentials and openrouter without key or model', () => {
    expect(() =>
      loadTenants(
        yaml(`${credentials}
      roles: { reviewer: [ghost] }`),
      ),
    ).toThrow('ai.roles.reviewer references unknown credential "ghost"');
    expect(() =>
      loadTenants(
        yaml(`      providers: [openrouter]
      credentials: [{ id: router, provider: openrouter, apiKey: k }]`),
      ),
    ).toThrow('openrouter requires apiKey and model');
  });
});
describe('router by role', () => {
  let db: DataSource;
  beforeEach(async () => {
    db = await database();
  });
  afterEach(async () => {
    await db.destroy();
  });
  const input = { taskId: 't', tenantId: 'acme', workspace: '/w', prompt: 'p' };
  const ok = { success: true, stdout: 'ok', stderr: '', exitCode: 0 };
  test('runs the role targets with their model and effort, and refuses a disabled role', async () => {
    const [t] = loadTenants(
      yaml(`${credentials}
      roles: { reviewer: [{ credential: router, effort: low }] }`),
    );
    const agents = { execute: jest.fn().mockResolvedValue(ok) };
    const router = new AgentRouter(db, agents as any);
    const run = await router.run(t, 'reviewer', input, jest.fn());
    expect(run.credential.id).toBe('router');
    expect(agents.execute.mock.calls[0][0]).toBe('openrouter');
    expect(agents.execute.mock.calls[0][1]).toMatchObject({
      role: 'reviewer',
      model: 'deepseek/deepseek-chat',
      effort: 'low',
      apiKey: 'or-key',
    });
    expect(run.attempts[0]).toMatchObject({ role: 'reviewer', outcome: 'success' });
    await expect(router.run(t, 'planner', input, jest.fn())).rejects.toThrow(
      'AI role "planner" has no credentials',
    );
  });
});
describe('providers', () => {
  const input = {
    taskId: 'task',
    tenantId: 'acme',
    credentialId: 'router',
    workspace: '/tmp/task',
    prompt: 'p',
    timeoutMs: 1000,
  };
  const help = {
    success: true,
    stdout:
      '--ask-for-approval --json --sandbox --config --print --output-format --permission-mode --effort --disallowed-tools',
    stderr: '',
    exitCode: 0,
  };
  test('OpenRouter runs Codex against its endpoint, with the key in its own variable', async () => {
    const runner = { run: jest.fn().mockResolvedValue(help) };
    const sandbox = { run: jest.fn().mockResolvedValue({ ...help, stdout: '' }) };
    const codex = new CodexProvider(runner as any, sandbox as any);
    await new AgentService(codex, {} as any, {} as any).execute('openrouter', {
      ...input,
      apiKey: 'or-key',
      model: 'deepseek/deepseek-chat',
      effort: 'max',
      readOnly: true,
      role: 'reviewer',
    });
    const [, args, opts, , provider] = sandbox.run.mock.calls[0];
    expect(args).toEqual([
      '--ask-for-approval',
      'never',
      'exec',
      '--model',
      'deepseek/deepseek-chat',
      '-c',
      'model_reasoning_effort="xhigh"',
      '-c',
      'model_provider="openrouter"',
      '-c',
      'model_providers.openrouter.name="OpenRouter"',
      '-c',
      'model_providers.openrouter.base_url="https://openrouter.ai/api/v1"',
      '-c',
      'model_providers.openrouter.env_key="OPENROUTER_API_KEY"',
      '-c',
      'model_providers.openrouter.wire_api="responses"',
      '--json',
      '--sandbox',
      'read-only',
      '-',
    ]);
    expect(opts).toMatchObject({
      apiKey: 'or-key',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      readOnly: true,
      agent: 'reviewer',
      provider: 'openrouter',
    });
    expect(provider).toBe('codex');
  });
  test('Claude gets effort and, when read-only, no edit tools', async () => {
    const runner = { run: jest.fn().mockResolvedValue(help) };
    const sandbox = {
      run: jest.fn().mockResolvedValue({ ...help, stdout: '{"result":"done"}' }),
    };
    const r = await new ClaudeProvider(runner as any, sandbox as any).execute({
      ...input,
      model: 'opus',
      effort: 'high',
      readOnly: true,
      role: 'planner',
    });
    const [, args, opts] = sandbox.run.mock.calls[0];
    expect(args.slice(0, 2)).toEqual(['--disallowed-tools', 'Edit,Write,NotebookEdit']);
    expect(args.slice(-4)).toEqual(['--model', 'opus', '--effort', 'high']);
    expect(opts).toMatchObject({ readOnly: true, agent: 'planner' });
    expect(r.message).toBe('done');
  });
});
describe('reviewer and planner answers', () => {
  test('only a clear verdict counts; asking for changes needs the issues', () => {
    const block = (v: string, issues = '') =>
      `Exemplo: <revisao><veredito>aprovado</veredito></revisao>\nFinal:\n<revisao>\n<veredito>${v}</veredito>${issues}\n<resumo>ok</resumo>\n</revisao>`;
    expect(parseReview(block('aprovado'))).toEqual({
      verdict: 'aprovado',
      issues: undefined,
      summary: 'ok',
    });
    expect(parseReview(block('ajustes', '<problemas>1. a.ts:3 — bug</problemas>'))).toMatchObject({
      verdict: 'ajustes',
      issues: '1. a.ts:3 — bug',
    });
    expect(parseReview(block('ajustes'))).toBeUndefined();
    expect(parseReview(block('talvez'))).toBeUndefined();
    expect(parseReview('sem bloco')).toBeUndefined();
    expect(parseTag('a <plano>\n1. passo\n</plano>', 'plano')).toBe('1. passo');
    // Smaller models sometimes never close the block.
    expect(parseReview('<revisao><veredito>aprovado</veredito><resumo>ok</resumo>')).toMatchObject({
      verdict: 'aprovado',
      summary: 'ok',
    });
  });
  test('the PR states what the review did', () => {
    expect(reviewSummary(undefined)).toContain('revisor não configurado');
    expect(reviewSummary({ final: 'skipped', rounds: [], skipped: 'sem cota' })).toBe(
      'Revisão automática não realizada: sem cota.',
    );
    expect(
      reviewSummary({
        final: 'changes-addressed',
        rounds: [{ verdict: 'ajustes', issues: '1. bug\n2. teste', summary: 'ok' }],
      }),
    ).toBe(
      'Revisão automática: ajustes aplicados, sem nova rodada de revisão.\n- Rodada 1: ajustes pedidos e aplicados — ok\n  1. bug\n  2. teste',
    );
  });
});
describe('Gemini CLI', () => {
  const input = {
    taskId: 'task',
    tenantId: 'umbrella',
    credentialId: 'gemini-1',
    apiKey: 'g-key',
    model: 'gemini-3.5-flash',
    workspace: '/tmp/task',
    prompt: 'long prompt',
    timeoutMs: 1000,
  };
  const help = {
    success: true,
    stdout: '--prompt --output-format --approval-mode --skip-trust --include-directories',
    stderr: '',
    exitCode: 0,
  };
  test('headless, edits auto-approved, prompt through stdin, key in GEMINI_API_KEY', async () => {
    const sandbox = {
      run: jest.fn().mockResolvedValue({
        ...help,
        stdout: 'Warning: x\n{"session_id":"s","response":"feito","stats":{}}',
      }),
    };
    const gemini = new GeminiProvider(
      { run: jest.fn().mockResolvedValue(help) } as any,
      sandbox as any,
    );
    const r = await new AgentService({} as any, {} as any, gemini).execute('gemini', input);
    const [, args, opts, network, provider] = sandbox.run.mock.calls[0];
    expect(args).toEqual([
      '--approval-mode',
      'auto_edit',
      '--skip-trust',
      '--output-format',
      'json',
      '--model',
      'gemini-3.5-flash',
      '--prompt',
      'Siga as instruções recebidas na entrada acima.',
    ]);
    expect(opts).toMatchObject({
      input: 'long prompt',
      apiKey: 'g-key',
      apiKeyEnv: 'GEMINI_API_KEY',
      provider: 'gemini',
    });
    expect([network, provider]).toEqual([undefined, undefined]);
    expect(r).toMatchObject({ success: true, message: 'feito' });
  });
  test('read-only runs use plan mode; API errors become errorText for the fallback', async () => {
    const sandbox = {
      run: jest.fn().mockResolvedValue({
        success: false,
        exitCode: 1,
        stderr: '',
        stdout:
          '{"error":{"type":"ApiError","message":"Resource has been exhausted (e.g. check quota).","code":429}}',
      }),
    };
    const gemini = new GeminiProvider(
      { run: jest.fn().mockResolvedValue(help) } as any,
      sandbox as any,
    );
    const r = await gemini.execute({
      ...input,
      readOnly: true,
      attachments: { dir: '/a', files: [] },
    });
    const args: string[] = sandbox.run.mock.calls[0][1];
    expect(args.slice(0, 2)).toEqual(['--approval-mode', 'plan']);
    expect(args).toContain('--include-directories');
    expect(r.errorText).toBe('status 429: Resource has been exhausted (e.g. check quota).');
    // Per-minute limit: short cooldown. The daily limit says "quota exceeded": long cooldown.
    expect(classifyFailure(r)).toBe('rate_limit');
    expect(
      classifyFailure({
        ...r,
        errorText:
          'status 429: Quota exceeded for metric: generate_content_free_tier_requests, limit: 250 per day',
      }),
    ).toBe('quota');
    expect(geminiOutput('nada').response).toBeUndefined();
  });
  test('an old Gemini CLI (or one on Node 18) fails before running the agent', async () => {
    const sandbox = { run: jest.fn() };
    const gemini = new GeminiProvider(
      { run: jest.fn().mockResolvedValue({ ...help, success: false, stdout: '' }) } as any,
      sandbox as any,
    );
    await expect(gemini.execute(input)).rejects.toThrow('needs Node 20+');
    expect(sandbox.run).not.toHaveBeenCalled();
  });
});
describe('front-end role and Figma token (front phase)', () => {
  test('frontend is off unless listed; listed, it keeps its order', () => {
    const [off] = loadTenants(yaml(credentials));
    expect(roleTargets(off, 'frontend')).toEqual([]);
    const [on] = loadTenants(
      yaml(`${credentials}
      roles:
        frontend: [chatgpt, { credential: claude-max, effort: medium }]`),
    );
    expect(roleTargets(on, 'frontend').map((r) => [r.credential.id, r.effort])).toEqual([
      ['chatgpt', undefined],
      ['claude-max', 'medium'],
    ]);
  });
  test('the Figma token is configuration and a secret', () => {
    const text = yaml(credentials).replace(
      '    hosts:',
      '    figma: { token: figd_secret_token_value }\n    hosts:',
    );
    const list = loadTenants(text);
    expect(list[0].figma).toEqual({ token: 'figd_secret_token_value' });
    useTenants(list);
    try {
      expect(redact('x figd_secret_token_value y')).toBe('x [REDACTED] y');
    } finally {
      useTenants(undefined);
    }
  });
});
test('hidden files: per project, relative paths only', () => {
  const withHidden = (list: string) =>
    yaml(credentials).replace('test: [npm, test] }', `test: [npm, test], hiddenFiles: ${list} }`);
  expect(loadTenants(yaml(credentials))[0].projects[0].hiddenFiles).toEqual([]);
  expect(
    loadTenants(withHidden("['.saml-configurations/**/*.key']"))[0].projects[0].hiddenFiles,
  ).toEqual(['.saml-configurations/**/*.key']);
  expect(() => loadTenants(withHidden("['../x']"))).toThrow();
  expect(() => loadTenants(withHidden("['!keep']"))).toThrow();
});
test('an expired Claude subscription login is an auth failure, so the next credential takes over', () => {
  const r = { success: false, stdout: '', stderr: '', exitCode: 1 };
  expect(
    classifyFailure({
      ...r,
      errorText: 'Failed to authenticate: OAuth session expired and could not be refreshed',
    }),
  ).toBe('auth');
  expect(classifyFailure({ ...r, errorText: 'Failed to authenticate. API Error: 403' })).toBe(
    'auth',
  );
});
