import { t, type Key } from '../i18n';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../api';
import { phaseIndex, PHASES, stageLabel, statusLabel } from '../live';
import { useLive } from '../LiveProvider';
import type { RunUsage, RunView, TaskView } from '../types';
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
function elapsed(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
function duration(run: RunView) {
  if (!run.finishedAt) return t('detail.running');
  return elapsed(Date.parse(run.finishedAt) - Date.parse(run.startedAt));
}
const tokens = (n: number) => n.toLocaleString();
function Tokens({ usage }: { usage: RunUsage }) {
  return (
    <>
      {t('detail.tokens', {
        input: tokens(usage.input),
        output: tokens(usage.output),
        cacheRead: tokens(usage.cacheRead),
        cacheCreation: tokens(usage.cacheCreation),
      })}
      {usage.turns ? ` · ${t('detail.turns', { n: usage.turns })}` : ''}
    </>
  );
}
function Metrics({ task }: { task: TaskView }) {
  const m = task.metrics;
  if (!m) return null;
  return (
    <section>
      <h3>{t('detail.metrics')}</h3>
      <ul>
        <li>
          {t('detail.time', {
            total: elapsed(m.totalMs),
            agent: elapsed(m.agentMs),
            waiting: elapsed(m.waitingMs),
            other: elapsed(m.otherMs),
          })}
        </li>
        {m.waits.questions + m.waits.failures > 0 && <li>{t('detail.waits', m.waits)}</li>}
        {task.usage && (
          <li>
            <Tokens usage={task.usage} />
          </li>
        )}
        {Object.entries(task.usage?.byModel ?? {}).map(([model, u]) => (
          <li key={model}>
            {model}: <Tokens usage={u} />
            {u.costUsd !== undefined ? ` · ${t('detail.cost', { usd: u.costUsd.toFixed(2) })}` : ''}
          </li>
        ))}
        {Object.entries(m.phases)
          .filter(([phase]) => phase)
          .map(([phase, p]) => (
            <li key={phase}>
              {t('detail.phase', { phase, runs: p.runs, agent: elapsed(p.agentMs) })}
              {p.usage ? (
                <>
                  {' · '}
                  <Tokens usage={p.usage} />
                </>
              ) : (
                ''
              )}
            </li>
          ))}
      </ul>
      {task.methodTelemetry && !!Object.keys(task.methodTelemetry.agents).length && (
        <>
          <h4>{t('detail.methodAgents')}</h4>
          <ul>
            {Object.entries(task.methodTelemetry.agents)
              .sort(([, a], [, b]) => b.input + b.output - (a.input + a.output))
              .map(([agent, a]) => (
                <li key={agent}>
                  {t('detail.methodAgent', { agent, runs: a.runs, time: elapsed(a.durationMs) })}
                  {a.measured < a.runs
                    ? ` ${t('detail.methodFloor', { measured: a.measured })}`
                    : ''}
                  {' · '}
                  <Tokens usage={a} />
                </li>
              ))}
          </ul>
        </>
      )}
    </section>
  );
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
  const act = (call: Promise<unknown>, failed: string) => {
    setBusy(true);
    setError('');
    call.then(
      () => {
        setBusy(false);
        onDone();
      },
      (e) => {
        setBusy(false);
        setError(e instanceof ApiError ? e.message : failed);
      },
    );
  };
  const discard = () => act(api.discard(tenant, id), t('detail.discardFailed'));
  const promote = () => act(api.promote(tenant, id), t('detail.promoteFailed'));
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
        <div className="actions">
          <button type="button" disabled={busy} onClick={promote}>
            {t('detail.promote')}
          </button>
          <button type="button" disabled={busy} onClick={discard}>
            {t('detail.discard')}
          </button>
        </div>
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
/** A new task for a card whose task ended and published nothing, on the route the operator picks. */
function Restart({ tenant, task }: { tenant: string; task: TaskView }) {
  const { tenants } = useLive();
  const navigate = useNavigate();
  const routes = tenants
    .find((c) => c.id === tenant)
    ?.projects.find((p) => p.id === task.project)?.routes;
  const [route, setRoute] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!task.source || !task.key) return null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || (routes?.length && !route)) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.startCard(
        tenant,
        task.source!,
        task.key!,
        undefined,
        route || undefined,
        true,
      );
      if ('skipped' in result) setError(result.skipped);
      else navigate(`/tarefas/${tenant}/${result.taskId}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('login.noServer'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)}>
      <h3>{t('detail.restart')}</h3>
      <p>{t('detail.restartHint')}</p>
      {!!routes?.length && (
        <label>
          {t('detail.restartRoute')}
          <select value={route} onChange={(e) => setRoute(e.target.value)}>
            <option value="" />
            {routes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="submit" disabled={busy || (!!routes?.length && !route)}>
        {t('detail.restartGo')}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
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
      {task.supersededBy && (
        <p>
          {t('detail.superseded')}{' '}
          <Link to={`/tarefas/${tenant}/${task.supersededBy}`}>{t('detail.supersededLink')}</Link>
        </p>
      )}
      {task.rehearsal && !task.rehearsal.promoted && (
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
          <h3>
            {t('detail.aiUsed')}
            {task.costUsd ? ` · ${t('detail.cost', { usd: task.costUsd.toFixed(2) })}` : ''}
          </h3>
          <ul>
            {task.agentAttempts.map((a, i) => (
              <li key={i}>
                {ROLES[a.role ?? ''] ? t(ROLES[a.role ?? '']) : (a.role ?? t('detail.ai'))}:{' '}
                {a.credential}
                {a.model ? ` (${a.model})` : ''} — {a.outcome === 'success' ? 'ok' : a.outcome}
                {a.usedModels?.length
                  ? ` · ${t('detail.usedModels', { models: a.usedModels.join(', ') })}`
                  : ''}
                {a.costUsd !== undefined
                  ? ` · ${t('detail.cost', { usd: a.costUsd.toFixed(2) })}`
                  : ''}
              </li>
            ))}
          </ul>
        </section>
      )}
      {task.restartable && <Restart tenant={tenant} task={task} />}
      <Metrics task={task} />
      {!!task.runs?.length && (
        <section>
          <h3>{t('detail.runs')}</h3>
          <ul>
            {task.runs.map((run, i) => (
              <li key={i}>
                {run.agent}
                {run.phase ? ` (${run.phase})` : ''} · {run.provider} · {run.status} ·{' '}
                {duration(run)}
                {run.usage
                  ? ` · ${tokens(run.usage.input + run.usage.cacheRead + run.usage.cacheCreation)} → ${tokens(run.usage.output)}`
                  : ''}
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
