import { Decision } from '../database/entities';
import { t } from '../i18n';
/** Telegram's limit for a message text. */
export const TELEGRAM_MAX = 4096;
export type InlineKeyboard = { inline_keyboard: { text: string; callback_data: string }[][] };
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
function fit(text: string) {
  return text.length <= TELEGRAM_MAX ? text : `${text.slice(0, TELEGRAM_MAX - 1)}…`;
}
function heading(icon: string, tenantName: string, card: string, title: string) {
  return `${icon} ${tenantName} · ${card || t('telegram.task')}${title ? ` — ${title}` : ''}`;
}
/** Plain text (no parse_mode): nothing in cards or questions needs escaping. */
export function decisionMessage(input: {
  decision: Pick<Decision, 'id' | 'type' | 'questions' | 'reason'>;
  tenantName: string;
  card: string;
  title: string;
  link?: string;
}): { text: string; keyboard?: InlineKeyboard } {
  const { decision, tenantName, card, title, link } = input;
  if (decision.type === 'question') {
    const questions = decision.questions ?? [];
    const lines = questions.map(
      (q, i) => `${i + 1}. ${q.text}${q.options?.length ? ` (${q.options.join(' / ')})` : ''}`,
    );
    const answer = link
      ? t('telegram.question.answerLink', { link })
      : t('telegram.question.answerVsCode');
    const head = [
      heading('❓', tenantName, card, title),
      t('telegram.question.head', { count: questions.length }),
    ].join('\n');
    const body = lines.join('\n');
    // The questions are what gets cut; how to answer is always kept.
    const room = TELEGRAM_MAX - head.length - answer.length - 3;
    const shown = body.length <= room ? body : `${body.slice(0, Math.max(0, room - 1))}…`;
    return { text: `${head}\n${shown}\n\n${answer}` };
  }
  return {
    text: fit(
      [
        `${heading('❌', tenantName, card, '')} ${t('telegram.failure.failed')}`,
        t('telegram.failure.reason', { reason: decision.reason ?? t('telegram.failure.unknown') }),
        '',
        link ? t('telegram.failure.retryLink', { link }) : t('telegram.failure.buttons'),
      ].join('\n'),
    ),
    keyboard: {
      inline_keyboard: [
        [
          { text: t('telegram.button.retry'), callback_data: `d:${decision.id}:retry` },
          { text: t('telegram.button.cancel'), callback_data: `d:${decision.id}:cancel` },
        ],
      ],
    },
  };
}
export function prMessage(input: {
  tenantName: string;
  card: string;
  title: string;
  prUrl: string;
}) {
  return fit(
    `${heading('✅', input.tenantName, input.card, input.title)}\n${t('telegram.pr.opened', { url: input.prUrl })}`,
  );
}
/** "d:<decision uuid>:retry|cancel" — anything else is not ours. */
export function parseCallback(
  data: string,
): { decisionId: string; action: 'retry' | 'cancel' } | undefined {
  const match = new RegExp(`^d:(${UUID}):(retry|cancel)$`).exec(data);
  return match ? { decisionId: match[1], action: match[2] as 'retry' | 'cancel' } : undefined;
}
/** A rehearsal finished: nothing was published; where to check it in the company's workspace. */
export function rehearsalMessage(input: {
  tenantName: string;
  card: string;
  title: string;
  workspace: string;
  branch: string;
  commitSha: string;
  revision?: number;
  /** Prints of the test evidence kept with the task. */
  evidence?: number;
}) {
  const prints = !input.evidence
    ? ''
    : `\n${
        input.evidence === 1
          ? t('telegram.rehearsal.printsOne')
          : t('telegram.rehearsal.printsMany', { count: input.evidence })
      }`;
  const revision = input.revision
    ? t('telegram.rehearsal.revision', { number: input.revision })
    : '';
  return fit(
    [
      heading('🧪', input.tenantName, input.card, input.title),
      `${t('telegram.rehearsal.done')}${revision}${t('telegram.rehearsal.nothing')}`,
      `${t('telegram.rehearsal.where', {
        workspace: input.workspace,
        branch: input.branch,
        commit: input.commitSha.slice(0, 7),
      })}${prints}`,
    ].join('\n'),
  );
}
