import { t as tr } from '../i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useLive } from '../LiveProvider';
import { ago, stageLabel, sortTasks } from '../live';
import { DecisionPopup } from '../office/DecisionPopup';
import type { OfficeView } from '../office/game';
import { demoModel, officeModel, SPOTS, currentJob } from '../office/spots';
import { TaskDetail } from './TaskDetail';
type Loader = () => Promise<{
  createOffice: (parent: HTMLElement, onSelect: (id: string) => void) => OfficeView;
}>;
const loadPhaser: Loader = () => import('../office/game');
const ICONS = { working: '◆', waiting: '◷', error: '!', idle: '○' };
const AREAS: Record<string, string> = {
  get mural() {
    return tr('guild.missionBoard');
  },
  get waiting() {
    return tr('status.waiting');
  },
  get queue() {
    return tr('guild.taskQueue');
  },
  get delivery() {
    return tr('guild.deliveries');
  },
};
export function Office({ loadGame = loadPhaser }: { loadGame?: Loader }) {
  const { tenants, tasks, decisions, loaded, connected, error } = useLive();
  const [picked, setPicked] = useState('');
  const tenant = tenants.some((t) => t.id === picked) ? picked : (tenants[0]?.id ?? '');
  const [selected, setSelected] = useState<string>();
  const [demo, setDemo] = useState(false);
  const [step, setStep] = useState(0);
  const [failed, setFailed] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const view = useRef<OfficeView | undefined>(undefined);
  const roomTasks = useMemo(() => tasks.filter((t) => t.tenantId === tenant), [tasks, tenant]);
  const roomDecisions = useMemo(
    () => decisions.filter((d) => d.tenantId === tenant && d.status === 'open'),
    [decisions, tenant],
  );
  const liveModel = useMemo(
    () => officeModel(roomTasks, roomDecisions),
    [roomTasks, roomDecisions],
  );
  const model = useMemo(
    () => ({
      ...(demo ? demoModel(step) : liveModel),
      roomKey: demo ? 'demo' : tenant,
      loaded: demo || loaded,
    }),
    [demo, step, liveModel, tenant, loaded],
  );
  const latest = useRef(model);
  latest.current = model;
  const demoRef = useRef(demo);
  demoRef.current = demo;
  useEffect(() => {
    if (!holder.current) return;
    let stopped = false;
    let created: OfficeView | undefined;
    setFailed(false);
    void loadGame().then(
      ({ createOffice }) => {
        if (stopped) return;
        try {
          created = createOffice(holder.current!, (id) => {
            if (demoRef.current && !id.startsWith('@')) return;
            setSelected(id);
          });
          view.current = created;
          created.update(latest.current);
        } catch {
          setFailed(true);
        }
      },
      () => !stopped && setFailed(true),
    );
    return () => {
      stopped = true;
      created?.destroy();
      view.current = undefined;
    };
  }, [loadGame]);
  useEffect(() => {
    view.current?.update(model);
  }, [model]);
  useEffect(() => {
    if (!demo) return;
    const timer = setInterval(() => setStep((s) => s + 1), 1500);
    return () => clearInterval(timer);
  }, [demo]);
  // Selections never cross company boundaries.
  const switchRoom = (id: string) => {
    setPicked(id);
    setSelected(undefined);
    setDemo(false);
  };
  useEffect(() => {
    if (selected)
      panel.current?.scrollIntoView?.({
        block: 'nearest',
        behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
      });
  }, [selected]);
  const guild = model.guild!;
  const area = selected?.startsWith('@') ? selected.slice(1) : undefined;
  const agent = liveModel.guild!.agents.find((a) => a.role === area);
  const list =
    area === 'queue'
      ? roomTasks.filter((t) => currentJob(t).status === 'PENDING')
      : area === 'delivery'
        ? roomTasks.filter((t) => t.status === 'SUCCESS')
        : area === 'mural'
          ? sortTasks(roomTasks)
          : (agent?.tasks ?? []);
  const ready = loaded && !error;
  return (
    <section className="office">
      <header className="guild-header">
        <div>
          <p className="eyebrow">
            {tr('guild.eyebrow')} · {tenants.find((t) => t.id === tenant)?.name ?? 'GUILDA IA'}
          </p>
          <h1>{tr('guild.headline')}</h1>
          <p className="muted">{tr('guild.subtitle')}</p>
        </div>
        <Link className="guild-new" to="/nova">
          {tr('app.newMission')}
        </Link>
      </header>
      <div className="guild-toolbar">
        <div className="segmented" role="group" aria-label={tr('guild.room')}>
          {tenants.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={!demo && tenant === t.id}
              onClick={() => switchRoom(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
        <div className="guild-live">
          <span className={connected ? 'live-dot' : 'live-dot disconnected'} />
          {connected ? tr('guild.live') : tr('guild.reconnecting')} ·{' '}
          {ready
            ? tr('guild.activeRuns', { n: liveModel.guild!.active })
            : tr('guild.loadingAgents')}
        </div>
        <button
          type="button"
          className="demo-toggle"
          aria-pressed={demo}
          onClick={() => {
            setDemo((d) => !d);
            setSelected(undefined);
          }}
        >
          {tr('guild.demo')}
        </button>
      </div>
      {demo && <p className="guild-notice">{tr('guild.demoNotice')}</p>}
      {failed && <p role="alert">{tr('guild.loadFailed')}</p>}
      {!loaded && <p role="status">{tr('guild.loadingMissions')}</p>}
      {loaded && !tenants.length && <p className="empty">{tr('guild.noCompany')}</p>}
      <div className="guild-map-frame">
        {!demo && <DecisionPopup decisions={decisions} tenants={tenants} />}
        <div className="guild-map-heading">
          <strong>⌂ {tr('guild.office')}</strong>
          <span>{tr('guild.clickHint')}</span>
        </div>
        <div
          className="guild-map-scroll"
          tabIndex={0}
          role="region"
          aria-label={tr('guild.mapLabel')}
        >
          <div
            className="office-canvas"
            data-testid="office-canvas"
            ref={holder}
            aria-hidden="true"
          />
        </div>
        <div className="guild-map-footer">
          <span>◆ {tr('guild.working')}</span>
          <span>◷ {tr('guild.waiting')}</span>
          <span>○ {tr('guild.free')}</span>
          <span>! {tr('guild.error')}</span>
          <span className="map-hint">↔ {tr('guild.scrollHint')}</span>
        </div>
      </div>
      <div className="guild-areas" aria-label={tr('guild.areas')}>
        {Object.entries(AREAS).map(([id, label]) => (
          <button
            type="button"
            key={id}
            className={id === 'waiting' && roomDecisions.length ? 'attention' : ''}
            aria-expanded={area === id}
            onClick={() => setSelected('@' + id)}
          >
            <span>
              {id === 'mural' ? '▤' : id === 'waiting' ? '◷' : id === 'queue' ? '≡' : '▣'}
            </span>
            {label}
            <b>
              {!loaded
                ? '…'
                : id === 'waiting'
                  ? roomDecisions.length
                  : id === 'delivery'
                    ? roomTasks.filter((t) => t.status === 'SUCCESS').length
                    : id === 'queue'
                      ? liveModel.guild!.queued
                      : roomTasks.length}
            </b>
          </button>
        ))}
      </div>
      <div className="guild-roster" aria-label={tr('guild.stations')}>
        {guild.agents.map((a) => (
          <button
            type="button"
            key={a.role}
            className={`agent-card ${a.tone}`}
            aria-expanded={area === a.role}
            onClick={() => setSelected('@' + a.role)}
          >
            <strong>{SPOTS[a.role].label}</strong>
            <span className="agent-status">
              {ICONS[a.tone]} {ready || demo ? a.status : tr('guild.loading')}
            </span>
            <small>
              {a.task
                ? `${a.task.key ?? a.task.id.slice(0, 8)} · ${a.name}`
                : tr('guild.noMission')}
            </small>
          </button>
        ))}
      </div>
      {selected && (
        <aside ref={panel} className="office-panel" aria-label={tr('guild.panel')}>
          <button className="link close-panel" type="button" onClick={() => setSelected(undefined)}>
            {tr('guild.close')}
          </button>
          {!area ? (
            <TaskDetail key={`${tenant}/${selected}`} tenant={tenant} id={selected} />
          ) : (
            <>
              <h2>{agent ? SPOTS[agent.role].label : AREAS[area]}</h2>
              {agent && (
                <>
                  <p>
                    <strong>{agent.name}</strong> · {agent.status}
                  </p>
                  <p className="muted">
                    {tr('guild.stationRole', { role: SPOTS[agent.role].label.toLowerCase() })}{' '}
                    {tr('guild.stationTasks', { n: agent.tasks.length })}
                  </p>
                  <p>
                    {tr('guild.lastActivity')}{' '}
                    {agent.task
                      ? `${stageLabel(currentJob(agent.task).stage)} · ${ago(agent.task.updatedAt)}`
                      : tr('guild.noActivity')}
                  </p>
                  <p className="muted">{tr('guild.noProgress')}</p>
                </>
              )}
              {!loaded ? (
                <p>{tr('app.loading')}</p>
              ) : area === 'waiting' ? (
                roomDecisions.length ? (
                  roomDecisions.map((d) => (
                    <Link className="guild-mission" key={d.id} to={`/decisoes/${d.id}`}>
                      <strong>{d.card ?? tr('guild.pendingDecision')}</strong>
                      <span>{d.title ?? d.reason ?? tr('guild.openDecision')}</span>
                    </Link>
                  ))
                ) : (
                  <p className="empty">{tr('guild.noDecision')}</p>
                )
              ) : list.length ? (
                list.map((t) => (
                  <div className="guild-mission" key={t.id}>
                    <button type="button" className="link" onClick={() => setSelected(t.id)}>
                      <strong>{t.key ?? t.id.slice(0, 8)}</strong> ·{' '}
                      {t.title ?? tr('guild.untitled')}
                    </button>
                    <span>{stageLabel(currentJob(t).stage)}</span>
                    {t.prUrl && (
                      <a href={t.prUrl} target="_blank" rel="noreferrer">
                        {tr('guild.seePr')} ↗
                      </a>
                    )}
                  </div>
                ))
              ) : (
                <p className="empty">
                  {agent
                    ? tr('guild.noStationMission')
                    : area === 'delivery'
                      ? tr('guild.noDelivery')
                      : area === 'queue'
                        ? tr('guild.noPending')
                        : tr('guild.noMissions')}
                </p>
              )}
            </>
          )}
        </aside>
      )}
      <section className="guild-history" aria-label={tr('guild.recent')}>
        <h2>
          {tr('guild.lastActivities')} <small>{tr('guild.missionUpdates')}</small>
        </h2>
        {!loaded ? (
          <p>{tr('app.loading')}</p>
        ) : !roomTasks.length ? (
          <p className="muted">{tr('guild.noRoomActivity')}</p>
        ) : (
          <ul>
            {sortTasks(roomTasks)
              .slice(0, 5)
              .map((t) => (
                <li key={t.id}>
                  <time dateTime={t.updatedAt}>{ago(t.updatedAt)}</time>
                  <button type="button" className="link" onClick={() => setSelected(t.id)}>
                    {t.key ?? t.id.slice(0, 8)}
                  </button>
                  <span>{stageLabel(currentJob(t).stage)}</span>
                </li>
              ))}
          </ul>
        )}
      </section>
      <p className="guild-data-note">{tr('guild.dataNote')}</p>
    </section>
  );
}
