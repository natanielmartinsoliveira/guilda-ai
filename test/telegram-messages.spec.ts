import * as settings from '../src/config';
import { redact } from '../src/config';
import { telegramEnabled } from '../src/telegram/enabled';
afterEach(() => jest.restoreAllMocks());
const withTelegram = (over: Partial<settings.Settings>) =>
  jest.spyOn(settings, 'config').mockReturnValue({ ...settings.config(), ...over });
test('Telegram is on only with both the bot token and the chat id', () => {
  expect(telegramEnabled()).toBe(false);
  withTelegram({
    TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
    TELEGRAM_CHAT_ID: undefined,
  });
  expect(telegramEnabled()).toBe(false);
  withTelegram({
    TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
    TELEGRAM_CHAT_ID: '123456789',
  });
  expect(telegramEnabled()).toBe(true);
});
test('the bot token is redacted everywhere', () => {
  process.env.TELEGRAM_BOT_TOKEN = '987654:secret-bot-token-value-xyz';
  try {
    expect(
      redact('url https://api.telegram.org/bot987654:secret-bot-token-value-xyz/getMe'),
    ).not.toContain('secret-bot-token-value-xyz');
  } finally {
    delete process.env.TELEGRAM_BOT_TOKEN;
  }
});
import { decisionMessage, parseCallback, prMessage, TELEGRAM_MAX } from '../src/telegram/messages';
const id = '0b6f3c3e-8f7a-4d2b-9c1e-5a4b3c2d1e0f';
test('question: card, title, numbered questions with options, no buttons', () => {
  const m = decisionMessage({
    decision: {
      id,
      type: 'question',
      reason: null,
      questions: [{ text: 'Motivo obrigatório?', options: ['Sim', 'Não'] }, { text: 'Qual tela?' }],
    },
    tenantName: 'Initrode (Vandelay)',
    card: 'PF-123',
    title: 'Recusa de indicação',
    link: 'https://x.ngrok-free.dev/app/decisoes/' + id,
  });
  expect(m.text).toBe(
    [
      '❓ Initrode (Vandelay) · PF-123 — Recusa de indicação',
      'A IA tem 2 dúvida(s) e a tarefa está esperando você:',
      '1. Motivo obrigatório? (Sim / Não)',
      '2. Qual tela?',
      '',
      `Responder: https://x.ngrok-free.dev/app/decisoes/${id}`,
    ].join('\n'),
  );
  expect(m.keyboard).toBeUndefined();
});
test('failure: reason and Retry / Cancel buttons; without a link it says where to answer', () => {
  const m = decisionMessage({
    decision: { id, type: 'failure', questions: null, reason: 'TESTS: Tests failed: boom' },
    tenantName: 'Umbrella',
    card: '#7',
    title: '',
    link: undefined,
  });
  expect(m.text).toBe(
    [
      '❌ Umbrella · #7 falhou',
      'Motivo: TESTS: Tests failed: boom',
      '',
      'Use os botões, ou responda pelo VS Code (answer_decision).',
    ].join('\n'),
  );
  expect(m.keyboard).toEqual({
    inline_keyboard: [
      [
        { text: '🔁 Repetir', callback_data: `d:${id}:retry` },
        { text: '✖️ Cancelar', callback_data: `d:${id}:cancel` },
      ],
    ],
  });
  for (const b of m.keyboard!.inline_keyboard[0])
    expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
});
test('a huge question list is cut to the Telegram limit', () => {
  const m = decisionMessage({
    decision: {
      id,
      type: 'question',
      reason: null,
      questions: Array.from({ length: 10 }, () => ({ text: 'x'.repeat(2000) })),
    },
    tenantName: 'A',
    card: 'B-1',
    title: 'T',
    link: 'https://x/app/decisoes/1',
  });
  expect(m.text.length).toBeLessThanOrEqual(TELEGRAM_MAX);
  // The questions are cut; how to answer is always kept.
  expect(m.text.endsWith('\n\nResponder: https://x/app/decisoes/1')).toBe(true);
  expect(m.text).toContain('…');
});
test('a task without card or title still reads well', () => {
  const m = decisionMessage({
    decision: { id, type: 'failure', questions: null, reason: null },
    tenantName: 'Umbrella',
    card: '',
    title: '',
  });
  expect(m.text.split('\n')[0]).toBe('❌ Umbrella · tarefa falhou');
  expect(m.text).toContain('Motivo: desconhecido');
  expect(m.text).not.toMatch(/undefined|null/);
});
test('PR message', () => {
  expect(
    prMessage({ tenantName: 'Umbrella', card: '#7', title: 'Add greeting', prUrl: 'https://pr/8' }),
  ).toBe('✅ Umbrella · #7 — Add greeting\nPR aberto: https://pr/8');
});
test('callback data is parsed strictly', () => {
  expect(parseCallback(`d:${id}:retry`)).toEqual({ decisionId: id, action: 'retry' });
  expect(parseCallback(`d:${id}:cancel`)).toEqual({ decisionId: id, action: 'cancel' });
  for (const bad of [`d:${id}:delete`, `x:${id}:retry`, 'd:not-a-uuid:retry', ''])
    expect(parseCallback(bad)).toBeUndefined();
});
test('a rehearsal is announced with where to look, and only when Telegram is on', async () => {
  const { rehearsalMessage } = await import('../src/telegram/messages');
  const { notifyRehearsal } = await import('../src/telegram/notify');
  const text = rehearsalMessage({
    tenantName: 'Initech',
    card: '49145',
    title: 'Fix billing',
    workspace: 'ws:/root/ai-dev-team/t1',
    branch: '49145-fix-billing',
    commitSha: 'abcdef1234567',
    revision: 2,
  });
  expect(text).toBe(
    '🧪 Initech · 49145 — Fix billing\nEnsaio concluído (ajuste #2) — nada foi publicado.\nConfira em ws:/root/ai-dev-team/t1 (branch 49145-fix-billing, commit abcdef1).',
  );
  expect(
    rehearsalMessage({
      tenantName: 'Initech',
      card: '49145',
      title: 'Fix billing',
      workspace: 'ws',
      branch: 'b',
      commitSha: 'abcdef1234567',
      evidence: 2,
    }),
  ).toContain('📸 2 prints de evidência no painel (comentário pronto para colar no card).');
  const save = jest.fn();
  const payload = {
    tenantName: 'Initech',
    card: '1',
    title: 't',
    workspace: 'w',
    branch: 'b',
    commitSha: 'c',
  };
  await notifyRehearsal({ save } as any, payload);
  expect(save).not.toHaveBeenCalled();
  withTelegram({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz', TELEGRAM_CHAT_ID: '1' });
  await notifyRehearsal({ save } as any, payload);
  expect(save.mock.calls[0][1]).toMatchObject({ kind: 'text', status: 'pending' });
  expect(save.mock.calls[0][1].payload.text).toContain('Ensaio concluído — nada foi publicado');
});
