import { t } from '../i18n';
import { FormEvent, useState } from 'react';
import { ApiError } from '../api';
import type { DecisionView } from '../types';
import { BriefChoices, adjustments } from './BriefChoices';
import { PlainText } from './PlainText';
const draftKey = (id: string) => `adt-draft:${id}`;
function loadDraft(id: string, size: number): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(draftKey(id)) ?? 'null');
    if (Array.isArray(saved) && saved.length === size) return saved.map(String);
  } catch {
    // No storage (private window) or a broken draft: start empty.
  }
  return Array(size).fill('');
}
function saveDraft(id: string, answers: string[] | null) {
  try {
    if (answers) localStorage.setItem(draftKey(id), JSON.stringify(answers));
    else localStorage.removeItem(draftKey(id));
  } catch {
    // The draft is a convenience; without storage it is simply not kept.
  }
}
export function QuestionForm({
  decision,
  onAnswer,
}: {
  decision: DecisionView;
  onAnswer: (answers: string[]) => Promise<void>;
}) {
  const questions = decision.questions ?? [];
  const [answers, setAnswers] = useState(() => loadDraft(decision.id, questions.length));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // One briefed question: the brief first, its choices answered with one button.
  const brief = questions.length === 1 ? questions[0].brief : undefined;
  const [picked, setPicked] = useState<number[]>(
    () => brief?.choices.map((c) => c.recommended) ?? [],
  );
  const complete = questions.length > 0 && answers.every((a) => a.trim());
  const set = (index: number, value: string) => {
    const next = answers.map((a, i) => (i === index ? value : a));
    setAnswers(next);
    saveDraft(decision.id, next);
  };
  const send = async (given: string[]) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onAnswer(given);
      saveDraft(decision.id, null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('login.noServer'));
    } finally {
      setBusy(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (complete) await send(answers.map((a) => a.trim()));
  };
  // The recommendations as they are: the question's own option (its approval); else what changed.
  const briefAnswer = brief
    ? adjustments(brief, picked) || questions[0].options?.[0] || t('brief.approve')
    : '';
  const fields = questions.map((q, i) => {
    const chosen = q.options?.includes(answers[i]);
    return (
      <fieldset key={i}>
        <legend>{t('question.n', { n: i + 1 })}</legend>
        <PlainText text={q.text} />
        {q.options?.map((option) => (
          <label key={option} className="option">
            <input
              type="radio"
              name={`${decision.id}-${i}`}
              checked={answers[i] === option}
              onChange={() => set(i, option)}
            />
            {option}
          </label>
        ))}
        <textarea
          aria-label={t('question.answerN', { n: i + 1 })}
          placeholder={q.options?.length ? t('question.other') : t('question.yours')}
          value={chosen ? '' : answers[i]}
          onChange={(e) => set(i, e.target.value)}
        />
      </fieldset>
    );
  });
  const answerButton = (
    <button type="submit" disabled={!complete || busy}>
      {t('question.submit')}
    </button>
  );
  if (!brief)
    return (
      <form onSubmit={submit}>
        {fields}
        {answerButton}
        {error && <p role="alert">{error}</p>}
      </form>
    );
  return (
    <form onSubmit={submit}>
      <BriefChoices
        id={decision.id}
        brief={brief}
        picked={picked}
        onPick={(choice, option) =>
          setPicked((all) => all.map((p, i) => (i === choice ? option : p)))
        }
      />
      <button type="button" disabled={busy} onClick={() => void send([briefAnswer])}>
        {adjustments(brief, picked) ? t('brief.sendAdjustments') : t('brief.approve')}
      </button>
      <details>
        <summary>{t('brief.full')}</summary>
        {fields}
        {answerButton}
      </details>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
