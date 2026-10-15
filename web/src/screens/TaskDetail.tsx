import { t, type Key } from '../i18n';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../api';
import { phaseIndex, PHASES, stageLabel, statusLabel } from '../live';
import { useLive } from '../LiveProvider';
import type { RunView, TaskView } from '../types';
const ROLES: Record<string, Key> = {
  coder: 'role.coder',
  fixer: 'role.fixer',
  planner: 'role.planner',
  reviewer: 'role.reviewer',
};
const REVIEW: Record<string, Key> = {
  approved: 'review.approved',
  'changes-addressed': 'review.addressed',
  skipped: 'review.skipped',
};
function duration(run: RunView) {
  if (!run.finishedAt) return t('detail.running');
  const seconds = Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}
function ReviseForm({ tenant, id, onDone }: { tenant: string; id: string; onDone: () => void }) {
  const [instructions, setInstructions] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !instructions.trim()) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('instructions', instructions.trim());
      for (const file of files) form.append('files', file);
      const { number } = await api.revise(tenant, id, form);
      setInstructions('');
      setFiles([]);
      setNotice(t('detail.revisionAsked', { number }));
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('login.noServer'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit}>
      <h3>{t('detail.revise')}</h3>
      <label>
        {t('detail.whatToAdjust')}
        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </label>
      <label>
        {t('detail.attachments')}
        <input type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} />
      </label>
      <button type="submit" disabled={busy || !instructions.trim()}>
        {t('detail.revise')}
      </button>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
/** A rehearsal published nothing: the commit stays in the company's workspace to be checked. */
function Rehearsal({
  tenant,
  id,
  rehearsal,
  onDone,
}: {
  tenant: string;
  id: string;
  rehearsal: NonNullable<TaskView['rehearsal']>;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const discard = () => {
    setBusy(true);
    setError('');
    api.discard(tenant, id).then(
      () => {
        setBusy(false);
        onDone();
      },
      (e) => {
        setBusy(false);
        setError(e instanceof ApiError ? e.message : t('detail.discardFailed'));
      },
    );
  };
  return (
    <section className="rehearsal">
      <h3>{t('detail.rehearsalDone')}</h3>
      <p>
        {t('detail.checkAt')} <code>{rehearsal.workspace}</code> (branch{' '}
        <code>{rehearsal.branch}</code>, commit <code>{rehearsal.commitSha.slice(0, 7)}</code>).
      </p>
      <ul>
        {rehearsal.files.map((f) => (
          <li key={f}>
            <code>{f}</code>
          </li>
        ))}
      </ul>
      {rehearsal.discarded ? (
        <p>{t('detail.discarded')}</p>
      ) : (
        <button type="button" disabled={busy} onClick={discard}>
          {t('detail.discard')}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
/** One print, fetched with the session (an <img> alone would not carry the API headers). */
function Print({
  tenant,
  id,
  file,
  title,
}: {
  tenant: string;
  id: string;
  file: string;
  title: string;
}) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let url = '';
    let live = true;
    api.evidenceFile(tenant, id, file).then(
      (blob) => {
        if (!live) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      },
      () => undefined,
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [tenant, id, file]);
  return src ? (
    <img src={src} alt={title} style={{ maxWidth: '100%', border: '1px solid #ccc' }} />
  ) : (
    <p>{t('detail.loadingPrint')}</p>
  );
}
/** Prints for the company's audit and the "Teste desenvolvedor:" comment to paste on the card. */
function Evidence({
  tenant,
  id,
  evidence,
}: {
  tenant: string;
  id: string;
  evidence: NonNullable<TaskView['evidence']>;
}) {
  const [notice, setNotice] = useState('');
  const copy = () =>
    navigator.clipboard.writeText(evidence.comment).then(
      () => setNotice(t('detail.copied')),
      () => setNotice(t('detail.copyFailed')),
    );
  const trace = () =>
    api.evidenceFile(tenant, id, 'trace.zip').then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `trace-${id}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    });
  return (
    <section className="evidence">
      <h3>{t('detail.evidence')}</h3>
      <ol>
        {evidence.shots.map((s) => (
          <li key={s.file}>
            <p>
              <strong>{s.title}</strong> — <code>{s.url}</code> — {s.at}
            </p>
            <Print tenant={tenant} id={id} file={s.file} title={s.title} />
          </li>
        ))}
      </ol>
      <pre>{evidence.comment}</pre>
      <button type="button" onClick={() => void copy()}>
        {t('detail.copyComment')}
      </button>
      {evidence.trace && (
        <button type="button" onClick={() => void trace()}>
          {t('detail.downloadTrace')}
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
export function TaskDetail({ tenant, id }: { tenant: string; id: string }) {
  const { subscribe } = useLive();
  const [task, setTask] = useState<TaskView>();
  const [error, setError] = useState('');
  const load = useCallback(
    () =>
      api.task(tenant, id).then(
        (loaded) => {
          setTask(loaded);
          setError('');
        },
        (e) =>
          setError(
            e instanceof ApiError && e.status === 404
              ? t('detail.notFound')
              : t('detail.loadFailed'),
          ),
      ),
    [tenant, id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // Any change of this task, its revisions or its decisions (the task row itself does not move
  // while a revision runs, and the task may be beyond the list's first page).
  useEffect(
    () =>
      subscribe((event) => {
        if (event.taskId === id) void load();
      }),
    [subscribe, id, load],
  );
  if (error) return <p role="alert">{error}</p>;
  if (!task) return <p className="empty">{t('app.loading')}</p>;
  const openDecisions = task.decisions.filter((d) => d.status === 'open');
  const current = phaseIndex(task.stage);
  const phaseClass = (index: number) =>
    index < current
      ? 'done'
      : index === current
        ? task.status === 'FAILED'
          ? 'failed'
          : 'current'
        : '';
  return (
    <article className="card">
      <Link className="back" to="/tarefas">
        ← {t('app.tasks')}
      </Link>
      <header>
        <span className="key">{task.key}</span>
        <strong>{task.title}</strong>
        <span className={`badge ${task.status.toLowerCase()}`}>
          {statusLabel(task, new Set(openDecisions.length ? [task.id] : []))}
        </span>
        <small>{stageLabel(task.stage)}</small>
      </header>
      <p className="actions">
        {task.url && (
          <a href={task.url} target="_blank" rel="noreferrer">
            Card
          </a>
        )}
        {task.prUrl && (
          <a href={task.prUrl} target="_blank" rel="noreferrer">
            Pull request
          </a>
        )}
        {task.branch && <code>{task.branch}</code>}
      </p>
      {current === -1 && <p className="offline">{stageLabel(task.stage)}</p>}
      <ol className="timeline">
        {PHASES.map((phase, index) => (
          <li key={phase.id} className={phaseClass(index)}>
            {phase.label}
          </li>
        ))}
      </ol>
      {task.error && <pre className="error">{task.error}</pre>}
      {task.rehearsal && (
        <Rehearsal tenant={tenant} id={id} rehearsal={task.rehearsal} onDone={() => void load()} />
      )}
      {task.evidence && <Evidence tenant={tenant} id={id} evidence={task.evidence} />}
      {!!openDecisions.length && (
        <p>
          <Link to={`/decisoes/${openDecisions[0].id}`}>{t('detail.answerOpen')}</Link>
        </p>
      )}
      {!!task.agentAttempts?.length && (
        <section>
          <h3>{t('detail.aiUsed')}</h3>
          <ul>
            {task.agentAttempts.map((a, i) => (
              <li key={i}>
                {ROLES[a.role ?? ''] ? t(ROLES[a.role ?? '']) : (a.role ?? t('detail.ai'))}:{' '}
                {a.credential}
                {a.model ? ` (${a.model})` : ''} — {a.outcome === 'success' ? 'ok' : a.outcome}
              </li>
            ))}
          </ul>
        </section>
      )}
      {!!task.runs?.length && (
        <section>
          <h3>{t('detail.runs')}</h3>
          <ul>
            {task.runs.map((run, i) => (
              <li key={i}>
                {run.agent} · {run.provider} · {run.status} · {duration(run)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {task.review && (
        <section>
          <h3>{t('stage.REVIEW')}</h3>
          <p>
            {REVIEW[task.review.final] ? t(REVIEW[task.review.final]) : task.review.final} ·{' '}
            {t('detail.rounds', { n: task.review.rounds.length })}
          </p>
        </section>
      )}
      {task.checks && (
        <section>
          <h3>{t('stage.CHECKS')}</h3>
          <p>
            {t('detail.findings', { n: task.checks.findings.length })}
            {task.checks.errors.length
              ? ` · ${t('detail.toolsFailed', { n: task.checks.errors.length })}`
              : ''}
          </p>
        </section>
      )}
      {!!task.revisions.length && (
        <section>
          <h3>{t('detail.revisions')}</h3>
          <ul>
            {task.revisions.map((r) => (
              <li key={r.id}>
                #{r.number} · {r.origin} · {r.status}
                {r.commitSha ? ` · ${r.commitSha.slice(0, 7)}` : ''}
                <br />
                <small>{r.instructions}</small>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!!task.decisions.length && (
        <section>
          <h3>{t('app.decisions')}</h3>
          <ul>
            {task.decisions.map((d) => (
              <li key={d.id}>
                {d.type === 'question' ? t('detail.question') : t('detail.failure')} ·{' '}
                {d.status === 'open' ? (
                  <Link to={`/decisoes/${d.id}`}>{t('detail.answer')}</Link>
                ) : (
                  t('detail.answered')
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {/* A rehearsal is adjusted in its workspace folder until it is discarded. */}
      {(task.prUrl || (task.rehearsal && !task.rehearsal.discarded)) && (
        <ReviseForm tenant={tenant} id={id} onDone={() => void load()} />
      )}
    </article>
  );
}
