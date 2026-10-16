import { Clarification, Decision, DecisionQuestion } from '../database/entities';
import { parseTag } from './pr-description';
/** Question rounds per job before ambiguity counts as a failure of the card itself. */
export const MAX_QUESTIONS = 3;
/** The agent asked instead of guessing: the job waits for the operator. */
export class NeedsInput extends Error {
  constructor(
    readonly questions: DecisionQuestion[],
    /** A step of the method that always waits for the operator (a method's gate): no limit. */
    readonly unlimited = false,
  ) {
    super(`Waiting for the operator: ${questions.length} question(s)`);
  }
}
/** Questions of the last <duvidas> block of the agent's final message. */
export function parseQuestions(message?: string): DecisionQuestion[] {
  const block = parseTag(message, 'duvidas');
  if (!block) return [];
  const questions: DecisionQuestion[] = [];
  for (const match of block.matchAll(/<pergunta>([\s\S]*?)(?:<\/pergunta>|$)/g)) {
    const raw = match[1];
    const options = [...(parseTag(raw, 'opcoes') ?? '').matchAll(/<opcao>([\s\S]*?)<\/opcao>/g)]
      .map((o) => o[1].trim())
      .filter(Boolean)
      .slice(0, 6);
    const text = raw
      .replace(/<opcoes>[\s\S]*$/, '')
      .trim()
      .slice(0, 2000);
    if (text) questions.push(options.length ? { text, options } : { text });
  }
  return questions.slice(0, 10);
}
/**
 * What the operator settled, rebuilt from the answered decisions themselves (the only copy:
 * nothing else that writes the issue can drop an answer). In answer order.
 */
export function clarificationsFrom(
  decisions: Pick<Decision, 'type' | 'status' | 'questions' | 'answer' | 'answeredAt'>[],
): Clarification[] {
  const notes: Clarification[] = [];
  const answered = decisions
    .filter((d) => d.status === 'answered' && d.answeredAt)
    .sort((a, b) => a.answeredAt!.getTime() - b.answeredAt!.getTime());
  for (const d of answered) {
    const at = d.answeredAt!.toISOString();
    const answer = (d.answer ?? {}) as {
      answers?: string[];
      action?: string;
      instructions?: string;
    };
    if (d.type === 'question')
      (d.questions ?? []).forEach((q, i) => {
        const text = answer.answers?.[i];
        // A budget release (💰) is about cost, not about the card: never prompt material.
        if (text && !q.text.startsWith('💰'))
          notes.push({ kind: 'answer', question: q.text, text, at });
      });
    else if (answer.action === 'retry_with_instructions' && answer.instructions)
      notes.push({ kind: 'instruction', text: answer.instructions, at });
  }
  return notes;
}
/** Prompt section with everything the operator already settled for this task. */
export function clarificationsText(list?: Clarification[]): string {
  if (!list?.length) return '';
  const lines = list.map((c) =>
    c.kind === 'answer'
      ? `- Pergunta: ${c.question ?? ''}\n  Resposta: ${c.text}`
      : `- Instrução: ${c.text}`,
  );
  return `\n\nEsclarecimentos do operador (valem acima do card; não pergunte de novo o que já foi respondido):\n${lines.join('\n')}`;
}
/** Short reason for the operator: the first non-empty line of the job error. */
export function failureReason(error: string): string {
  const line = error.split('\n').find((l) => l.trim()) ?? error;
  return line.trim().slice(0, 300);
}
