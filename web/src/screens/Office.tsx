import { t as tr } from '../i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useLive } from '../LiveProvider';
import { ago, stageLabel, sortTasks } from '../live';
import { DecisionPopup } from '../office/DecisionPopup';
import { seatsFor } from '../office/seats';
import type { CameraMode } from '../office/camera';
import { campusModel, campusGuild, COMPANY_COLORS } from '../office/campus';
import type { OfficeView, OfficeSelection } from '../office/game';
import { demoModel, officeModel, SPOTS, currentJob } from '../office/spots';
import { TaskDetail } from './TaskDetail';
type Loader = () => Promise<{
  createOffice: (parent: HTMLElement, onSelect: (selection: OfficeSelection) => void) => OfficeView;
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
  const [chosenRoom, setRoom] = useState('');
  const room =
    chosenRoom === '*' && tenants.length > 1
      ? '*'
      : tenants.some((t) => t.id === chosenRoom)
        ? chosenRoom
        : (tenants[0]?.id ?? '');
  const all = room === '*';
  const tenant = all ? (tenants[0]?.id ?? '') : room;
  const [selected, setSelected] = useState<OfficeSelection>();
  const [demo, setDemo] = useState(false);
  const [step, setStep] = useState(0);
  const [failed, setFailed] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>('follow');
  const previousSeats = useRef({ key: '', seats: new Map<string, number>() });
  const panel = useRef<HTMLElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const view = useRef<OfficeView | undefined>(undefined);
  const roomTasks = useMemo(
    () => (all ? tasks : tasks.filter((t) => t.tenantId === tenant)),
    [tasks, tenant, all],
  );
  const roomDecisions = useMemo(
    () => decisions.filter((d) => (all || d.tenantId === tenant) && d.status === 'open'),
    [decisions, tenant, all],
  );
  const rooms = useMemo(() => campusModel(tenants, tasks, decisions), [tenants, tasks, decisions]);
  const liveModel = useMemo(
    () => ({
      ...officeModel(roomTasks, roomDecisions),
      ...(all ? { guild: campusGuild(rooms) } : {}),
    }),
    [roomTasks, roomDecisions, all, rooms],
  );
  const concurrency = tenants.find((t) => t.id === tenant)?.concurrency ?? 1;
  const model = useMemo(() => {
    const key = demo ? 'demo' : room;
    if (previousSeats.current.key !== key) previousSeats.current = { key, seats: new Map() };
    const previous = previousSeats.current.seats;
    if (all && !demo) {
      const retained = rooms.map((r) => {
        const capacity = tenants.find((t) => t.id === r.tenantId)?.concurrency ?? 1;
        const seats = seatsFor(capacity, r.model.crew, previous.get(r.tenantId) ?? 1);
        previous.set(r.tenantId, seats);
        return { ...r, seats, model: { ...r.model, seats } };
      });
      return { ...liveModel, roomKey: key, loaded, rooms: retained };
    }
    const base = demo ? demoModel(step) : liveModel;
    const seats = demo ? 2 : seatsFor(concurrency, base.crew, previous.get(tenant) ?? 1);
    previous.set(tenant, seats);
    return { ...base, roomKey: key, tenantId: tenant, loaded: demo || loaded, seats };
  }, [all, demo, room, rooms, tenants, liveModel, loaded, step, concurrency, tenant]);
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
          created = createOffice(holder.current!, (selection) => {
            if (demoRef.current && !selection.id.startsWith('@')) return;
            setSelected(selection);
          });
          view.current = created;
          created.onCameraModeChange(setCameraMode);
          created.update(latest.current);
          created.setCameraMode('follow');
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
  useEffect(() => {
    setCameraMode('follow');
    view.current?.setCameraMode('follow');
  }, [model.roomKey]);
  const focusTask = (id: string, owner = tenant) => {
    view.current?.focus(id, owner);
    setCameraMode('manual');
    if (!demo) setSelected({ tenantId: owner, id });
  };
  // Selections never cross company boundaries.
  const switchRoom = (id: string) => {
    setRoom(id);
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
  const area = selected?.id.startsWith('@') ? selected.id.slice(1) : undefined;
  const panelTasks =
    selected?.tenantId === '*'
      ? roomTasks
      : tasks.filter((t) => t.tenantId === (selected?.tenantId ?? tenant));
  const panelDecisions =
    selected?.tenantId === '*'
      ? roomDecisions
      : decisions.filter(
          (d) => d.tenantId === (selected?.tenantId ?? tenant) && d.status === 'open',
        );
  const panelGuild =
    selected?.tenantId === '*' ? liveModel.guild! : officeModel(panelTasks, panelDecisions).guild!;
  const agent = panelGuild.agents.find((a) => a.role === area);
  const list =
    area === 'queue'
      ? panelTasks.filter((t) => currentJob(t).status === 'PENDING')
      : area === 'delivery'
        ? panelTasks.filter((t) => t.status === 'SUCCESS')
        : area === 'mural'
          ? sortTasks(panelTasks)
          : (agent?.tasks ?? []);
  const totalRunning = tasks.filter((t) => currentJob(t).status === 'RUNNING').length;
  const colorFor = (id: string) =>
    COMPANY_COLORS[
      Math.max(
        0,
        tenants.findIndex((t) => t.id === id),
      ) % COMPANY_COLORS.length
    ];
  const companyChip = (id: string) => {
    const name = tenants.find((t) => t.id === id)?.name ?? id;
    return (
      <span
        className="company-chip"
        style={{ color: colorFor(id), borderColor: colorFor(id) }}
        aria-label={tr('guild.companyChip', { name })}
      >
        {name}
      </span>
    );
  };
  const rosterRooms = model.rooms ?? [
    { tenantId: tenant, name: '', model, seats: model.seats ?? 1 },
  ];
  const ready = loaded && !error;
  return (
    <section className="office">
      <header className="guild-header">
        <div>
          <p className="eyebrow">
            {tr('guild.eyebrow')} ·{' '}
            {all
              ? tr('guild.allRooms')
              : (tenants.find((t) => t.id === tenant)?.name ?? 'GUILDA IA')}
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
          {tenants.map((t) => {
            const running = tasks.filter(
              (task) => task.tenantId === t.id && currentJob(task).status === 'RUNNING',
            ).length;
            return (
              <button
                key={t.id}
                aria-label={
                  running ? tr('guild.roomRunning', { name: t.name, n: running }) : t.name
                }
                type="button"
                aria-pressed={!demo && room === t.id}
                onClick={() => switchRoom(t.id)}
              >
                {t.name}
                {running ? ` ◆ ${running}` : ''}
              </button>
            );
          })}
          {tenants.length > 1 && (
            <button
              type="button"
              aria-pressed={!demo && all}
              aria-label={
                totalRunning
                  ? tr('guild.roomRunning', { name: tr('guild.allRooms'), n: totalRunning })
                  : tr('guild.allRooms')
              }
              onClick={() => switchRoom('*')}
            >
              {tr('guild.allRooms')}
              {totalRunning ? ` ◆ ${totalRunning}` : ''}
            </button>
          )}
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
            if (!demo && all) setRoom(tenant);
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
          <div className="guild-camera-controls" role="group" aria-label={tr('guild.camera')}>
            <button
              type="button"
              aria-pressed={cameraMode === 'follow'}
              onClick={() => {
                setCameraMode('follow');
                view.current?.setCameraMode('follow');
              }}
            >
              {tr('guild.follow')}
            </button>
            <button
              type="button"
              aria-pressed={cameraMode === 'overview'}
              onClick={() => {
                setCameraMode('overview');
                view.current?.setCameraMode('overview');
              }}
            >
              {tr('guild.overview')}
            </button>
            <button
              type="button"
              aria-label={tr('guild.zoomIn')}
              onClick={() => {
                setCameraMode('manual');
                view.current?.zoomBy(1.2);
              }}
            >
              +
            </button>
            <button
              type="button"
              aria-label={tr('guild.zoomOut')}
              onClick={() => {
                setCameraMode('manual');
                view.current?.zoomBy(1 / 1.2);
              }}
            >
              −
            </button>
          </div>
        </div>
        {all && (
          <div className="guild-campus-signs" role="group" aria-label={tr('guild.companySigns')}>
            {rooms.map((r) => (
              <button
                type="button"
                key={r.tenantId}
                style={{ borderColor: colorFor(r.tenantId) }}
                aria-label={tr('guild.companySign', { name: r.name, n: r.running ?? 0 })}
                onClick={() => {
                  view.current?.focusRoom(r.tenantId);
                  setCameraMode('manual');
                }}
              >
                {r.name} ◆ {r.running ?? 0}
              </button>
            ))}
          </div>
        )}
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
        </div>
      </div>
      <div className="guild-areas" aria-label={tr('guild.areas')}>
        {Object.entries(AREAS).map(([id, label]) => (
          <button
            type="button"
            key={id}
            className={id === 'waiting' && roomDecisions.length ? 'attention' : ''}
            aria-expanded={area === id}
            onClick={() => setSelected({ tenantId: room, id: '@' + id })}
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
          <div
            key={a.role}
            className={`agent-card ${a.tone}`}
            role="group"
            aria-label={SPOTS[a.role].label}
          >
            <button
              type="button"
              className="agent-summary"
              aria-expanded={area === a.role}
              onClick={() => setSelected({ tenantId: room, id: '@' + a.role })}
            >
              <strong>{SPOTS[a.role].label}</strong>
              <span className="agent-status">
                {ICONS[a.tone]} {ready || demo ? a.status : tr('guild.loading')}
              </span>
            </button>
            {rosterRooms.map((r) => {
              const members = r.model.crew.filter((m) => m.role === a.role);
              if (!members.length) return null;
              return (
                <div className="crew-company" key={r.tenantId}>
                  {all && companyChip(r.tenantId)}
                  {members.map((m) => (
                    <button
                      type="button"
                      className="crew-key"
                      key={m.id}
                      onClick={() => {
                        focusTask(m.taskId, r.tenantId);
                        if (demo) setSelected({ tenantId: tenant, id: '@' + a.role });
                      }}
                    >
                      {m.key}
                    </button>
                  ))}
                </div>
              );
            })}
            {!a.tasks.length && <small>{tr('guild.noMission')}</small>}
          </div>
        ))}
      </div>
      {selected && (
        <aside ref={panel} className="office-panel" aria-label={tr('guild.panel')}>
          <button className="link close-panel" type="button" onClick={() => setSelected(undefined)}>
            {tr('guild.close')}
          </button>
          {all && selected.tenantId !== '*' && (
            <div className="guild-panel-company">
              {companyChip(selected.tenantId)}
              <button type="button" onClick={() => switchRoom(selected.tenantId)}>
                {tr('guild.openRoom')}
              </button>
            </div>
          )}
          {!area ? (
            <TaskDetail
              key={`${selected.tenantId}/${selected.id}`}
              tenant={selected.tenantId}
              id={selected.id}
            />
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
                panelDecisions.length ? (
                  panelDecisions.map((d) => (
                    <Link className="guild-mission" key={d.id} to={`/decisoes/${d.id}`}>
                      {all && companyChip(d.tenantId)}
                      <strong>{d.card ?? tr('guild.pendingDecision')}</strong>
                      <span>{d.title ?? d.reason ?? tr('guild.openDecision')}</span>
                    </Link>
                  ))
                ) : (
                  <p className="empty">{tr('guild.noDecision')}</p>
                )
              ) : list.length ? (
                list.map((t) => (
                  <div className="guild-mission" key={`${t.tenantId}/${t.id}`}>
                    {all && companyChip(t.tenantId)}
                    <button
                      type="button"
                      className="link"
                      onClick={() => focusTask(t.id, t.tenantId)}
                    >
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
                <li key={`${t.tenantId}/${t.id}`}>
                  {all && companyChip(t.tenantId)}
                  <time dateTime={t.updatedAt}>{ago(t.updatedAt)}</time>
                  <button
                    type="button"
                    className="link"
                    onClick={() => focusTask(t.id, t.tenantId)}
                  >
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
