import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { decisionMessage, prMessage, rehearsalMessage } from '../src/telegram/messages';
import { evidenceQuestion, readManifest } from '../src/evidence/evidence';
import { loadPacks } from '../src/tenants/packs';

beforeEach(() => {
  process.env.GUILDA_LANG = 'en';
});
afterEach(() => {
  process.env.GUILDA_LANG = 'pt-BR';
});

const rehearsal = (evidence?: number) =>
  rehearsalMessage({
    tenantName: 'Acme',
    card: 'A-1',
    title: 'Fix login',
    workspace: 'ws:/root/t1',
    branch: 'a-1-fix',
    commitSha: 'abcdef1234567',
    revision: 2,
    evidence,
  });

test('rehearsal message in English, with singular and plural prints', () => {
  expect(rehearsal()).toBe(
    '🧪 Acme · A-1 — Fix login\nRehearsal finished (adjustment #2) — nothing was published.\nCheck it at ws:/root/t1 (branch a-1-fix, commit abcdef1).',
  );
  expect(rehearsal(1)).toContain('📸 1 test evidence print in the panel');
  expect(rehearsal(3)).toContain('📸 3 test evidence prints in the panel');
});

test('question and failure messages in English', () => {
  const q = decisionMessage({
    decision: {
      id: 'd1',
      type: 'question',
      questions: [{ text: 'Which field?' }],
      reason: null,
    } as never,
    tenantName: 'Acme',
    card: '',
    title: '',
    link: 'https://panel/d1',
  });
  expect(q.text).toBe(
    '❓ Acme · task\nThe AI has 1 question(s) and the task is waiting for you:\n1. Which field?\n\nTo answer here: tap an option or use "Reply" on this message with your text.\nAnswer: https://panel/d1',
  );
  const f = decisionMessage({
    decision: { id: 'd1', type: 'failure', questions: null, reason: null } as never,
    tenantName: 'Acme',
    card: 'A-1',
    title: '',
  });
  expect(f.text).toContain('❌ Acme · A-1 failed\nReason: unknown');
  expect(f.text).toContain('Use the buttons, or answer from VS Code');
  expect(f.keyboard!.inline_keyboard[0].map((b) => b.text)).toEqual(['🔁 Retry', '✖️ Cancel']);
  expect(
    prMessage({ tenantName: 'Acme', card: 'A-1', title: 'x', prUrl: 'https://pr/1' }),
  ).toContain('PR opened: https://pr/1');
});

test('engine questions and manifest problems in English', () => {
  const q = evidenceQuestion('Need a sale');
  expect(q.text).toBe(
    'Test evidence: the prints do not show the requested result.\nNeed a sale\nReply with guidance (test data, screen, route) for the AI to try again.',
  );
  expect(q.options).toEqual(['Try again', 'Go on without evidence']);
  expect(readManifest('nope')).toEqual({ problem: expect.stringMatching(/missing or unreadable/) });
  expect(readManifest('{"shots":[]}')).toEqual({ problem: 'no print recorded in manifest.json' });
});

test('missing pack values are listed in English', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pack-en-'));
  await writeFile(join(dir, 'company.yaml'), stringify({ id: 'x', name: '${X_NAME}' }));
  await writeFile(
    join(dir, 'requires.yaml'),
    stringify([{ name: 'X_NAME', description: 'Company name' }]),
  );
  expect(() => loadPacks([dir], {})).toThrow(/Values the packs ask for are missing/);
});

test('login errors and Telegram login texts in English', async () => {
  const { authText } = await import('../src/web/auth-text');
  expect(authText('invalid')).toBe('Invalid password or code');
  expect(authText('tooMany')).toBe('Too many attempts; wait 15 minutes');
  expect(authText('code', { code: '123456' })).toContain('Access code for AI Dev Team: 123456');
  expect(authText('newAccess', { ip: '1.2.3.4', agent: 'Firefox' })).toContain('New panel access');
  process.env.GUILDA_LANG = 'pt-BR';
  expect(authText('invalid')).toBe('Senha ou código inválido');
});

test('a check section answered in English still gets its mark', async () => {
  const { renderPrTemplate } = await import('../src/tasks/pr-description');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'pr-en-'));
  await writeFile(join(dir, 'pr.md'), 'TR: {{TRANSLATIONS}}');
  const sections = [
    { tag: 'traducoes', placeholder: 'TRANSLATIONS', ask: 'x', kind: 'check' as const },
  ];
  const render = (answer: string) =>
    renderPrTemplate(
      { id: 'svc', pullRequest: { template: join(dir, 'pr.md') } } as never,
      '/x/tenants.yaml',
      {
        key: 'A-1',
        title: 'x',
        url: 'u',
        branch: 'b',
        body: 'c',
        changedFiles: [],
        testsPassed: true,
        testCommand: [],
        sections: { traducoes: answer },
      },
      sections,
    );
  expect(await render('Yes, PT EN ES')).toBe('TR: ✅');
  expect(await render('Not applicable')).toBe('TR: ➖');
  expect(await render('Sim')).toBe('TR: ✅');
});

test('English prompts keep company-facing text in the company language', () => {
  const { readFileSync } = require('node:fs');
  expect(readFileSync('prompts/en/pr-sections.md', 'utf8')).toMatch(
    /same language as the section descriptions/,
  );
  expect(readFileSync('prompts/en/reviser.md', 'utf8')).toMatch(
    /same language as the review comments/,
  );
});
