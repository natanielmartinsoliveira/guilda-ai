import { dateText, t } from '../i18n';
import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../api';
import { normalizeCardKey } from '../live';
import { useLive } from '../LiveProvider';
import type { SubtaskBases } from '../types';
const failure = (e: unknown) => (e instanceof ApiError ? e.message : t('login.noServer'));
/** A card of one of the company's sources (Jira, Businessmap…), started by its key. */
function FromSource() {
  const { tenants, reload } = useLive();
  const navigate = useNavigate();
  const choices = tenants.filter((t) => t.sources?.length);
  const [picked, setPicked] = useState('');
  const tenant = picked || choices[0]?.id || '';
  const sources = choices.find((c) => c.id === tenant)?.sources ?? [];
  const [pickedSource, setPickedSource] = useState('');
  const source = sources.find((s) => s.id === pickedSource) ?? sources[0];
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; taskId?: string }>();
  const [error, setError] = useState('');
  const normalized = source ? normalizeCardKey(source.key, key) : undefined;
  // A sub-task starts on its own from a branch the operator picks.
  const [bases, setBases] = useState<SubtaskBases>();
  const [base, setBase] = useState('');
  useEffect(() => {
    setBases(undefined);
    setBase('');
    if (!tenant || !source?.bases || !normalized) return;
    let stale = false;
    const timer = setTimeout(() => {
      api.cardBases(tenant, source.id, normalized).then(
        (found) => !stale && setBases(found),
        // Unknown: the server still decides when the card is started.
        () => undefined,
      );
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [tenant, source?.id, source?.bases, normalized]);
  const subtask = bases?.subtask ? bases : undefined;
  const blocked = !!subtask && (subtask.ownExists || !base);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !tenant || !source || !normalized || blocked) return;
    setBusy(true);
    setError('');
    setNotice(undefined);
    try {
      const result = subtask
        ? await api.startCard(tenant, source.id, normalized, base)
        : await api.startCard(tenant, source.id, normalized);
      await reload([tenant]);
      if ('skipped' in result) setNotice({ text: result.skipped, taskId: result.taskId });
      else navigate(`/tarefas/${tenant}/${result.taskId}`);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  };
  if (!choices.length) return <p className="empty">{t('new.noSource')}</p>;
  return (
    <form onSubmit={submit}>
      <label>
        {t('common.company')}
        <select
          value={tenant}
          onChange={(e) => {
            setPicked(e.target.value);
            setPickedSource('');
          }}
        >
          {choices.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {sources.length > 1 && (
        <label>
          {t('new.source')}
          <select value={source?.id ?? ''} onChange={(e) => setPickedSource(e.target.value)}>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {t('new.cardKey')}
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={source?.example}
          autoCapitalize="characters"
          autoComplete="off"
        />
      </label>
      {key.trim() && !normalized && (
        <p className="muted">{t('new.keyFormat', { example: source?.example ?? '' })}</p>
      )}
      {subtask?.ownExists && (
        <p role="alert">{t('new.branchExists', { branch: subtask.ownBranch ?? '' })}</p>
      )}
      {subtask && !subtask.ownExists && (
        <>
          <label>
            {t('new.startFrom')}
            <select value={base} onChange={(e) => setBase(e.target.value)}>
              <option value="">{t('new.pickBranch')}</option>
              {subtask.bases.map((b) => (
                <option key={b.branch} value={b.branch}>
                  {b.label} ({b.branch}, {dateText(b.date)})
                </option>
              ))}
            </select>
          </label>
          <p className="muted">
            {t('new.subtaskOf', { story: subtask.story, branch: subtask.storyBranch })}
          </p>
        </>
      )}
      <button type="submit" disabled={busy || !normalized || blocked}>
        {t('new.startCard')}
      </button>
      {notice && (
        <p role="status">
          {notice.text}
          {notice.taskId && (
            <>
              {' '}
              <Link to={`/tarefas/${tenant}/${notice.taskId}`}>{t('new.seeTask')}</Link>
            </>
          )}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
function FreeTask() {
  const { tenants, reload } = useLive();
  const navigate = useNavigate();
  const [picked, setPicked] = useState('');
  const tenant = picked || tenants[0]?.id || '';
  const projects = tenants.find((t) => t.id === tenant)?.projects ?? [];
  const [pickedProject, setPickedProject] = useState('');
  const project = projects.length === 1 ? projects[0].id : pickedProject;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [route, setRoute] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A method's route is the operator's to state, never inferred.
  const chosen = projects.find((p) => p.id === project);
  const routes = chosen?.routes ?? [];
  const ready = !!tenant && !!project && !!title.trim() && (!routes.length || !!route);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('title', title.trim());
      form.append('description', description);
      form.append('project', project);
      if (routes.length) form.append('route', route);
      for (const file of files) form.append('files', file);
      const { taskId } = await api.createTask(tenant, form);
      await reload([tenant]);
      navigate(`/tarefas/${tenant}/${taskId}`);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit}>
      <label>
        {t('common.company')}
        <select
          value={tenant}
          onChange={(e) => {
            setPicked(e.target.value);
            setPickedProject('');
          }}
        >
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {projects.length > 1 && (
        <label>
          {t('common.project')}
          <select value={pickedProject} onChange={(e) => setPickedProject(e.target.value)}>
            <option value="">{t('new.pickProject')}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} ({p.repository})
              </option>
            ))}
          </select>
        </label>
      )}
      {!!routes.length && (
        <label>
          {t('new.route', { method: chosen?.method ?? '' })}
          <select value={route} onChange={(e) => setRoute(e.target.value)}>
            <option value="">{t('new.pickRoute')}</option>
            {routes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {t('new.title')}
        <input value={title} maxLength={256} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        {t('new.description')}
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        {t('detail.attachments')}
        <input type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} />
      </label>
      <button type="submit" disabled={busy || !ready}>
        {t('new.create')}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
export function NewTask() {
  const [mode, setMode] = useState<'card' | 'free'>('card');
  return (
    <section>
      <h1>{t('new.heading')}</h1>
      <div className="segmented" role="group" aria-label={t('new.kind')}>
        <button type="button" aria-pressed={mode === 'card'} onClick={() => setMode('card')}>
          {t('new.sourceCard')}
        </button>
        <button type="button" aria-pressed={mode === 'free'} onClick={() => setMode('free')}>
          {t('new.free')}
        </button>
      </div>
      {mode === 'card' ? <FromSource /> : <FreeTask />}
    </section>
  );
}
