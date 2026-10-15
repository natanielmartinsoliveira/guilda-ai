import { setLanguage, t } from './i18n';
import { useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router';
import { api, setUnauthorizedHandler } from './api';
import { LiveProvider, useLive } from './LiveProvider';
import { Decisions } from './screens/Decisions';
import { Login } from './screens/Login';
import { NewTask } from './screens/NewTask';
import { Office } from './screens/Office';
import { Tasks } from './screens/Tasks';
function Shell({ onLogout }: { onLogout: () => void }) {
  const { decisions, connected, error } = useLive();
  const open = decisions.filter((d) => d.status === 'open').length;
  return (
    <div className="shell">
      <nav className="tabs" aria-label={t('app.nav')}>
        <div className="guild-brand">
          <span>✦</span>
          <strong>GUILDA IA</strong>
          <small>{t('app.brandSub')}</small>
        </div>
        <NavLink to="/escritorio" className="desktop-only">
          {t('app.office')}
        </NavLink>
        <NavLink to="/decisoes">
          {t('app.decisions')}
          {open > 0 && <span className="count">{open}</span>}
        </NavLink>
        <NavLink to="/tarefas">{t('app.tasks')}</NavLink>
        <NavLink to="/nova">{t('app.newMission')}</NavLink>

        <button type="button" className="logout" onClick={onLogout}>
          {t('app.logout')}
        </button>
      </nav>
      <main className="content">
        {(!connected || error) && (
          <p className="offline" role="status">
            {error ?? t('app.reconnecting')}
          </p>
        )}
        <Routes>
          <Route path="/" element={<Navigate to="/decisoes" replace />} />
          <Route path="/decisoes" element={<Decisions />} />
          <Route path="/decisoes/:id" element={<Decisions />} />
          <Route path="/tarefas" element={<Tasks />} />
          <Route path="/tarefas/:tenant/:id" element={<Tasks />} />
          <Route path="/nova" element={<NewTask />} />
          <Route path="/escritorio" element={<Office />} />
          <Route path="*" element={<Navigate to="/decisoes" replace />} />
        </Routes>
      </main>
    </div>
  );
}
export function App() {
  const [session, setSession] = useState<'checking' | 'in' | 'out'>('checking');
  useEffect(() => {
    setUnauthorizedHandler(() => setSession('out'));
    api.me().then(
      (me) => {
        setLanguage(me.language);
        setSession(me.authenticated ? 'in' : 'out');
      },
      () => setSession('out'),
    );
  }, []);
  if (session === 'checking') return <p className="center">{t('app.loading')}</p>;
  if (session === 'out') return <Login onDone={() => setSession('in')} />;
  return (
    <LiveProvider>
      <Shell
        onLogout={() => {
          void api.logout().finally(() => setSession('out'));
        }}
      />
    </LiveProvider>
  );
}
