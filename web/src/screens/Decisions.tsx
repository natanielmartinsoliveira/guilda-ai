import { t } from '../i18n';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError } from '../api';
import { useLive } from '../LiveProvider';
import type { DecisionAnswer, DecisionView } from '../types';
import { FailureForm } from './FailureForm';
import { QuestionForm } from './QuestionForm';
export function Decisions() {
  const { id } = useParams();
  const { decisions, tenants, reload, loaded } = useLive();
  const [notice, setNotice] = useState('');
  const open = decisions
    .filter((d) => d.status === 'open')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const shown = id ? open.filter((d) => d.id === id) : open;
  const tenantName = (tenantId: string) => tenants.find((t) => t.id === tenantId)?.name ?? tenantId;
  const answer = async (decision: DecisionView, body: DecisionAnswer) => {
    try {
      await api.answer(decision.tenantId, decision.id, body);
      setNotice(t('decisions.sent'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setNotice(t('decisions.alreadyAnswered'));
      else throw e;
    } finally {
      await reload([decision.tenantId]);
    }
  };
  return (
    <section>
      <h1>{t('app.decisions')}</h1>
      {notice && <p role="status">{notice}</p>}
      {/* Before the first load, an empty list says nothing about the decision. */}
      {!loaded && <p className="empty">{t('app.loading')}</p>}
      {loaded && id && !shown.length && (
        <p className="empty">
          {t('decisions.closed')} <Link to="/decisoes">{t('decisions.seeOpen')}</Link>
        </p>
      )}
      {loaded && !id && !open.length && <p className="empty">{t('decisions.nothing')}</p>}
      {shown.map((d) => (
        <article key={d.id} className="card">
          <header>
            <span className="key">{d.card ?? t('common.task')}</span>
            <strong>{d.title}</strong>
            <small>
              {tenantName(d.tenantId)} ·{' '}
              {d.type === 'question' ? t('decisions.question') : t('status.failed')}
            </small>
            <Link to={`/tarefas/${d.tenantId}/${d.taskId}`}>{t('decisions.seeTask')}</Link>
          </header>
          {d.type === 'question' ? (
            <QuestionForm decision={d} onAnswer={(answers) => answer(d, { answers })} />
          ) : (
            <FailureForm decision={d} onAnswer={(body) => answer(d, body)} />
          )}
        </article>
      ))}
    </section>
  );
}
