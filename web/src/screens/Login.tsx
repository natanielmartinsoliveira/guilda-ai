import { t } from '../i18n';
import { FormEvent, useState } from 'react';
import { api, ApiError } from '../api';
export function Login({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [loginId, setLoginId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('login.noServer'));
    } finally {
      setBusy(false);
    }
  };
  const submitPassword = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const { loginId } = await api.login(password);
      setPassword('');
      setLoginId(loginId);
      setStep('code');
    });
  };
  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await api.verify(loginId, code);
      onDone();
    });
  };
  return (
    <main className="login">
      <h1>AI Dev Team</h1>
      {step === 'password' ? (
        <form onSubmit={submitPassword}>
          <label>
            {t('login.password')}
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </label>
          <button type="submit" disabled={busy || !password}>
            {t('login.enter')}
          </button>
        </form>
      ) : (
        <form onSubmit={submitCode}>
          <p>{t('login.codeSent')}</p>
          <label>
            {t('login.code')}
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              autoFocus
            />
          </label>
          <button type="submit" disabled={busy || code.length !== 6}>
            {t('login.confirm')}
          </button>
          <button
            type="button"
            className="link"
            onClick={() => {
              setStep('password');
              setCode('');
              setError('');
            }}
          >
            {t('login.back')}
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
