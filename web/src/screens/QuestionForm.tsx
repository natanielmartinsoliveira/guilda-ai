import { t } from '../i18n';
import { FormEvent, useState } from 'react';
import { ApiError } from '../api';
import type { DecisionView } from '../types';
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
  const complete = questions.length > 0 && answers.every((a) => a.trim());
  const set = (index: number, value: string) => {
    const next = answers.map((a, i) => (i === index ? value : a));
    setAnswers(next);
    saveDraft(decision.id, next);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!complete || busy) return;
    setBusy(true);
    setError('');
    try {
      await onAnswer(answers.map((a) => a.trim()));
      saveDraft(decision.id, null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('login.noServer'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit}>
      {questions.map((q, i) => {
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
      })}
      <button type="submit" disabled={!complete || busy}>
        {t('question.submit')}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
