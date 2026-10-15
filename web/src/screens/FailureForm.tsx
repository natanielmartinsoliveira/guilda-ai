import { t } from '../i18n';
import { useState } from 'react';
import { ApiError } from '../api';
import type { DecisionAnswer, DecisionView } from '../types';
export function FailureForm({
  decision,
  onAnswer,
}: {
  decision: DecisionView;
  onAnswer: (body: DecisionAnswer) => Promise<void>;
}) {
  const [mode, setMode] = useState<'idle' | 'instructions' | 'cancel'>('idle');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async (body: DecisionAnswer) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onAnswer(body);
      setMode('idle');
      setInstructions('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('login.noServer'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <p className="error">{decision.reason}</p>
      {decision.details && (
        <details>
          <summary>{t('failure.details')}</summary>
          <pre>{decision.details}</pre>
        </details>
      )}
      {mode === 'instructions' && (
        <label>
          {t('failure.instruction')}
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            autoFocus
          />
        </label>
      )}
      <div className="actions">
        {mode === 'idle' && (
          <>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => send({ action: 'retry' })}
            >
              {t('failure.retry')}
            </button>
            <button type="button" disabled={busy} onClick={() => setMode('instructions')}>
              {t('failure.retryWith')}
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => setMode('cancel')}
            >
              {t('failure.cancelTask')}
            </button>
          </>
        )}
        {mode === 'instructions' && (
          <>
            <button
              type="button"
              className="primary"
              disabled={busy || !instructions.trim()}
              onClick={() =>
                send({ action: 'retry_with_instructions', instructions: instructions.trim() })
              }
            >
              {t('failure.sendRetry')}
            </button>
            <button type="button" className="link" onClick={() => setMode('idle')}>
              {t('login.back')}
            </button>
          </>
        )}
        {mode === 'cancel' && (
          <>
            <span>{t('failure.willCancel')}</span>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => send({ action: 'cancel' })}
            >
              {t('failure.confirmCancel')}
            </button>
            <button type="button" className="link" onClick={() => setMode('idle')}>
              {t('login.back')}
            </button>
          </>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
