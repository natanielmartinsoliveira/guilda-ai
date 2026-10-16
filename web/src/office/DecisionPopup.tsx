import { useState } from 'react';
import { Link } from 'react-router';
import { t } from '../i18n';
import type { DecisionView, Tenant } from '../types';
const KEY = 'guild.dismissedDecisions';
function remembered(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}
/**
 * A game-like request over the map when a decision waits for the operator (any company): the
 * newest one, how many more wait, a link to answer it and "Later" (for this session).
 */
export function DecisionPopup({
  decisions,
  tenants,
}: {
  decisions: DecisionView[];
  tenants: Tenant[];
}) {
  const [dismissed, setDismissed] = useState<string[]>(remembered);
  const open = decisions
    .filter((d) => d.status === 'open' && !dismissed.includes(d.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const shown = open[0];
  if (!shown) return null;
  const company = tenants.find((x) => x.id === shown.tenantId)?.name ?? shown.tenantId;
  const first = (shown.questions?.[0]?.text ?? shown.reason ?? '').split('\n')[0].slice(0, 160);
  const later = () => {
    const next = [...dismissed, shown.id];
    setDismissed(next);
    try {
      sessionStorage.setItem(KEY, JSON.stringify(next.slice(-50)));
    } catch {
      // private window: only this view forgets it
    }
  };
  return (
    <div className="decision-popup" role="dialog" aria-label={t('guild.decisionTitle')}>
      <p className="decision-popup-title">
        <span className="decision-popup-alert" aria-hidden="true">
          ❗
        </span>
        {t('guild.decisionTitle')}
      </p>
      <p className="decision-popup-card">
        {company} · {shown.card ?? t('guild.decisionTask')}
        {shown.title ? `: ${shown.title}` : ''}
      </p>
      {first && <p className="decision-popup-text">{first}</p>}
      {open.length > 1 && (
        <p className="decision-popup-more">{t('guild.decisionMore', { n: open.length - 1 })}</p>
      )}
      <div className="decision-popup-actions">
        <Link to={`/decisoes/${shown.id}`}>{t('guild.decisionAnswer')}</Link>
        <button type="button" onClick={later}>
          {t('guild.decisionLater')}
        </button>
      </div>
    </div>
  );
}
