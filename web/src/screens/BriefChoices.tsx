import { t } from '../i18n';
import type { DecisionBrief } from '../types';
/**
 * The answer that keeps the subject as it is except the choices the person changed: empty when
 * every choice is the recommended one (then the plain approval goes).
 */
export function adjustments(brief: DecisionBrief, picked: number[]) {
  const changed = brief.choices
    .map((c, i) => ({ c, pick: picked[i] ?? c.recommended }))
    .filter(({ c, pick }) => pick !== c.recommended);
  if (!changed.length) return '';
  return [
    t('brief.adjustments'),
    ...changed.map(
      ({ c, pick }) =>
        `- ${c.question}: ${c.options[pick]} (${t('brief.not')}: ${c.options[c.recommended]})`,
    ),
  ].join('\n');
}
/** The brief of a question: what is decided, the recommendation, its choices and risks. */
export function BriefChoices({
  id,
  brief,
  picked,
  onPick,
}: {
  id: string;
  brief: DecisionBrief;
  picked: number[];
  onPick: (choice: number, option: number) => void;
}) {
  return (
    <section className="brief" aria-label={t('brief.deciding')}>
      <h3>{t('brief.deciding')}</h3>
      <p>{brief.summary}</p>
      <p>
        <strong>
          {brief.recommendation.approve ? t('brief.recommendApprove') : t('brief.recommendAdjust')}
        </strong>
        {': '}
        {brief.recommendation.why}
      </p>
      {brief.highlights.length > 0 && (
        <ul>
          {brief.highlights.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
      {brief.choices.length > 0 && (
        <>
          <h4>{t('brief.choices')}</h4>
          {brief.choices.map((c, i) => (
            <fieldset key={c.question}>
              <legend>
                {String.fromCharCode(65 + i)}. {c.question}
              </legend>
              {c.options.map((option, j) => (
                <label key={option} className="option">
                  <input
                    type="radio"
                    name={`${id}-brief-${i}`}
                    checked={(picked[i] ?? c.recommended) === j}
                    onChange={() => onPick(i, j)}
                  />
                  {option}
                  {j === c.recommended && ` (${t('brief.recommended')})`}
                </label>
              ))}
              {c.why && <small>{c.why}</small>}
            </fieldset>
          ))}
        </>
      )}
      {brief.risks.length > 0 && (
        <>
          <h4>{t('brief.risks')}</h4>
          <ul>
            {brief.risks.map((r) => (
              <li key={r.text}>
                <strong>{t(`brief.risk.${r.level}`)}</strong>: {r.text}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
