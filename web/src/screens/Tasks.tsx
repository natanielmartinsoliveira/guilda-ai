import { t } from '../i18n';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ago, Filter, FILTERS, matches, sortTasks, stageLabel, statusLabel } from '../live';
import { useLive } from '../LiveProvider';
import { TaskDetail } from './TaskDetail';
export function Tasks() {
  const { tenant: routeTenant, id } = useParams();
  const { tenants, tasks, decisions, loaded } = useLive();
  const [tenant, setTenant] = useState('');
  const [project, setProject] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const waiting = new Set(decisions.filter((d) => d.status === 'open').map((d) => d.taskId));
  const projects = tenants.find((t) => t.id === tenant)?.projects ?? [];
  const list = sortTasks(
    tasks.filter(
      (t) =>
        (!tenant || t.tenantId === tenant) &&
        (!project || t.project === project) &&
        matches(t, filter, waiting),
    ),
  );
  return (
    <div className={`split${id ? ' has-detail' : ''}`}>
      <section className="list">
        <h1>{t('app.tasks')}</h1>
        <div className="filters">
          <select
            aria-label={t('common.company')}
            value={tenant}
            onChange={(e) => {
              setTenant(e.target.value);
              setProject('');
            }}
          >
            <option value="">{t('tasks.allCompanies')}</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {projects.length > 1 && (
            <select
              aria-label={t('common.project')}
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="">{t('tasks.allProjects')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="chips" role="group" aria-label={t('tasks.status')}>
          {FILTERS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {t(label)}
            </button>
          ))}
        </div>
        {!loaded ? (
          <p className="empty">{t('app.loading')}</p>
        ) : list.length ? (
          <ul className="task-list">
            {list.map((t) => (
              <li key={t.id}>
                <Link className={t.id === id ? 'active' : ''} to={`/tarefas/${t.tenantId}/${t.id}`}>
                  <span>
                    <span className="key">{t.key}</span> {t.title}
                  </span>
                  <span className={`badge ${t.status.toLowerCase()}`}>
                    {statusLabel(t, waiting)}
                  </span>
                  <small>
                    {stageLabel(t.stage)} · {ago(t.updatedAt)}
                  </small>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">{t('tasks.none')}</p>
        )}
      </section>
      <section className="detail">
        {id && routeTenant ? (
          <TaskDetail key={id} tenant={routeTenant} id={id} />
        ) : (
          <p className="empty">{t('tasks.pick')}</p>
        )}
      </section>
    </div>
  );
}
