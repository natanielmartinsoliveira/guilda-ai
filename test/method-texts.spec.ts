import { MethodRunner, MethodState, methodState } from '../src/methods/runner';
import { EXAMPLE_METHOD, METHOD_PACK } from './fixtures/method-ws';

/** How the engine renders a method's prompts (every text, byte for byte: method-check.spec). */
const SLUG = '1234-order-discount';
const MATERIAL = 'Card: show the plan name on the order.\nCriteria: X.';
function runner(route: string, ws: Record<string, unknown> = {}) {
  return new MethodRunner(
    {} as never,
    { id: 't1', branch: SLUG, instructions: MATERIAL, tenantId: 'acme' } as never,
    {
      tenant: { packDir: METHOD_PACK, git: { authorName: 'AI', authorEmail: 'ai@x' } },
      cfg: {
        id: 'svc',
        method: EXAMPLE_METHOD,
        workspace: { type: 'coder', reference: '/workspaces/svc' },
      },
      ws: { root: '/root/ai', ...ws },
    } as never,
    route,
  );
}
const state = (extra: Partial<MethodState> = {}): MethodState => ({ phase: 'x', ...extra });

test('a prompt gets the card, the slug, the route vars and the state; empty sections vanish', () => {
  const r = runner('fix');
  const bare = r.render('prompts/deliver-{{route}}.md', {}, state({ authorization: 'Go' }));
  expect(bare).toContain('«Go»');
  expect(bare).toContain(`Slug: ${SLUG}`);
  expect(bare).toContain('Route chosen by the person: fix');
  expect(bare).toContain(
    `corrective increment — a wrong behaviour in code already delivered:\n${MATERIAL}`,
  );
  expect(bare).not.toContain('Adjustments');
  const full = r.render(
    'prompts/deliver-{{route}}.md',
    {},
    state({ authorization: 'Go', notes: ['n1', 'n2'], answers: ['a1'] }),
  );
  expect(full).toContain('Adjustments the person asked for at the gate:\n- n1\n- n2');
  expect(full).toContain('(resume the plan in progress):\n- a1');
});

test('prompts/x-{{route}}.md when the route has one, else prompts/x.md', () => {
  expect(runner('adopt').render('prompts/deliver-{{route}}.md')).toMatch(
    /^Adopt the existing code/,
  );
  expect(runner('screen').render('prompts/deliver-{{route}}.md')).toMatch(/^Deliver the scope/);
  expect(runner('feature').render('prompts/authorization-{{route}}.md')).toMatch(
    /^Commit the specification/,
  );
  expect(runner('direct').render('prompts/authorization-{{route}}.md')).toBe(
    `Deliver the scope ${SLUG} end to end (plan, implementation of each step and review)`,
  );
});

test('a list value fills its section; an empty one takes the {{^X}} text', () => {
  const r = runner('feature');
  expect(r.render('prompts/gate-{{route}}.md', { FILES: ['docs/spec/a.md'] })).toContain(
    'Files the specification step changed:\n- docs/spec/a.md\n',
  );
  expect(r.render('prompts/gate-{{route}}.md', { FILES: [] })).toContain(
    'The current specification applies to this delivery.',
  );
});

test('a standard-flow route appends its rule to the core prompt; other routes append nothing', () => {
  expect(runner('direct').append()).toMatch(/^Direct route: this change is surface only/);
  expect(runner('screen').append()).toBe('');
});

describe('hooks (Review Focus 3)', () => {
  const ws = (stdout: string, success = true, stderr = '') => ({
    run: jest.fn(async () => ({ success, exitCode: success ? 0 : 1, stdout, stderr })),
    upload: jest.fn(),
    remove: jest.fn(),
  });
  test('the last stdout line, when JSON, adds variables; the hook gets the context on stdin', async () => {
    const w = ws('log line\n{"spec_root":"docs/spec"}');
    const r = runner('feature', w);
    await r.hook('hooks/prepare.py', true);
    expect(r.interp('{{vars.spec_root}}')).toBe('docs/spec');
    const [argv, opts] = w.run.mock.calls[0] as unknown as [
      string[],
      { input: string; env: Record<string, string> },
    ];
    expect(argv).toEqual(['python3', '.ai-dev-team/method/hooks/prepare.py']);
    expect(JSON.parse(opts.input)).toMatchObject({
      first: true,
      project: 'svc',
      slug: SLUG,
      route: 'feature',
      root: '/root/ai',
      options: { configFrom: '/workspaces/svc', pythonPath: '/workspaces/.ai-dev-team/pylib' },
    });
    expect(opts.env).toMatchObject({
      PYTHONPATH: '/workspaces/.ai-dev-team/pylib',
      GIT_AUTHOR_NAME: 'AI',
    });
  });
  test('a last line that is not JSON adds nothing and does not fail', async () => {
    const r = runner('feature', ws('done.'));
    await expect(r.hook('hooks/prepare.py', true)).resolves.toBeUndefined();
    expect(r.interp('{{vars.spec_root}}')).toBe('');
  });
  test('a hook that fails stops the task with its own message', async () => {
    const r = runner('feature', ws('', false, 'review-gate.json is not in /workspaces/svc'));
    await expect(r.hook('hooks/prepare.py', true)).rejects.toThrow(/is not in \/workspaces\/svc/);
  });
});

test('a route the method does not have is refused with the method message', () => {
  expect(() => runner('hotfix')).toThrow(/Review gate: the task has no route/);
});

describe('review fixes', () => {
  test('hooks run git with the same safety settings as the core (no git hooks, no global config, no prompts)', async () => {
    const w = {
      run: jest.fn(async () => ({ success: true, exitCode: 0, stdout: '{}', stderr: '' })),
      upload: jest.fn(),
      remove: jest.fn(),
    };
    await runner('feature', w).hook('hooks/prepare.py', true);
    const env = (w.run.mock.calls[0] as unknown as [string[], { env: Record<string, string> }])[1]
      .env;
    expect(env).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: 'commit.gpgsign',
      GIT_CONFIG_VALUE_2: 'false',
    });
  });
  test('a failed advance does not fail a finished rehearsal', async () => {
    const w = {
      run: jest.fn(async () => {
        throw new Error('Coder unreachable');
      }),
      upload: jest.fn(),
      remove: jest.fn(),
    };
    await expect(runner('feature', w).finishRehearsal()).resolves.toBeUndefined();
  });
  test('names of object internals are not routes', () => {
    expect(() => runner('constructor')).toThrow(/no route/);
    expect(() => runner('toString')).toThrow(/no route/);
  });
  test('the state of a task lives in result.method only', () => {
    expect(methodState({ method: { phase: 'deliver' } })).toEqual({ phase: 'deliver' });
    expect(methodState({ flow: { phase: 'gate', asked: 'Q' } })).toBeUndefined();
    expect(methodState({})).toBeUndefined();
  });
});
