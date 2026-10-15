import { t } from './i18n';
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { api, ApiError } from './api';
import { eventTenant, replaceTenants } from './live';
import { fetchSource } from './sse';
import type { ChangeEvent, DecisionView, TaskView, Tenant } from './types';
export interface Live {
  tenants: Tenant[];
  tasks: TaskView[];
  decisions: DecisionView[];
  connected: boolean;
  /** False until the first full load: an empty list does not mean "nothing" yet. */
  loaded: boolean;
  error?: string;
  /** Reloads these tenants (all when omitted). */
  reload(only?: string[]): Promise<void>;
  /** Every change the stream reports (e.g. a task detail refreshing itself); returns unsubscribe. */
  subscribe(listener: (event: ChangeEvent) => void): () => void;
}
/** The part of EventSource the provider uses (a fake one in tests). */
export interface SourceLike {
  addEventListener(type: 'change', listener: (event: { data: string }) => void): void;
  onerror: (() => void) | null;
  onopen: (() => void) | null;
  close(): void;
}
export const LiveContext = createContext<Live | null>(null);
export function useLive() {
  const live = useContext(LiveContext);
  if (!live) throw new Error('useLive outside LiveProvider');
  return live;
}
const MAX_RETRY_MS = 30000;
/**
 * Tasks and decisions of every tenant, kept current by the SSE stream: each change reloads the
 * tenant it belongs to. A dropped stream is reopened after a growing pause, then everything is
 * reloaded (changes during the gap are not replayed).
 */
export function LiveProvider({
  children,
  connect = fetchSource,
  retryMs = 1000,
  debounceMs = 300,
}: {
  children: ReactNode;
  connect?: (url: string) => SourceLike;
  retryMs?: number;
  debounceMs?: number;
}) {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [decisions, setDecisions] = useState<DecisionView[]>([]);
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const listeners = useRef(new Set<(event: ChangeEvent) => void>());
  const subscribe = useCallback((listener: (event: ChangeEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const tenantsRef = useRef<Tenant[]>([]);
  const tasksRef = useRef<TaskView[]>([]);
  tasksRef.current = tasks;
  /** Per tenant, the newest reload asked for: an older answer arriving later is dropped. */
  const generations = useRef(new Map<string, number>());
  const reload = useCallback(async (only?: string[]) => {
    try {
      if (!only || !tenantsRef.current.length) {
        const list = await api.tenants();
        tenantsRef.current = list;
        setTenants(list);
      }
      const ids = only ?? tenantsRef.current.map((t) => t.id);
      const mine = new Map(
        ids.map((id) => {
          const generation = (generations.current.get(id) ?? 0) + 1;
          generations.current.set(id, generation);
          return [id, generation];
        }),
      );
      const loaded = await Promise.all(
        ids.map(async (id) => ({
          id,
          tasks: await api.tasks(id),
          decisions: await api.decisions(id),
        })),
      );
      const fresh = loaded.filter((l) => generations.current.get(l.id) === mine.get(l.id));
      const freshIds = fresh.map((l) => l.id);
      setTasks((current) =>
        replaceTenants(
          current,
          freshIds,
          fresh.flatMap((l) => l.tasks),
        ),
      );
      setDecisions((current) =>
        replaceTenants(
          current,
          freshIds,
          fresh.flatMap((l) => l.decisions),
        ),
      );
      if (!only) setLoaded(true);
      setError(undefined);
    } catch (e) {
      // 401 is handled by the app (back to login); anything else is shown and retried later.
      if (!(e instanceof ApiError && e.status === 401)) setError(t('live.updateFailed'));
    }
  }, []);
  useEffect(() => {
    let source: SourceLike | undefined;
    let stopped = false;
    let delay = retryMs;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let flush: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();
    let unknown = false;
    const open = () => {
      source = connect('/api/events');
      source.onopen = () => {
        setConnected(true);
        // A good connection: the next outage starts the pause over.
        delay = retryMs;
      };
      source.addEventListener('change', (message) => {
        const event = JSON.parse(message.data) as ChangeEvent;
        for (const listener of listeners.current) listener(event);
        const tenant = eventTenant(event, tasksRef.current);
        if (tenant) pending.add(tenant);
        else unknown = true;
        clearTimeout(flush);
        flush = setTimeout(() => {
          const ids = unknown ? undefined : [...pending];
          pending.clear();
          unknown = false;
          void reload(ids);
        }, debounceMs);
      });
      source.onerror = () => {
        source?.close();
        setConnected(false);
        if (stopped) return;
        retry = setTimeout(() => {
          if (stopped) return;
          open();
          void reload();
        }, delay);
        delay = Math.min(delay * 2, MAX_RETRY_MS);
      };
    };
    // Stream first, then the snapshot: a change between the two is not lost.
    open();
    void reload();
    // A phone that wakes up may hold a dead connection that never errors: start fresh.
    const wake = () => {
      if (document.visibilityState !== 'visible' || stopped) return;
      source?.close();
      clearTimeout(retry);
      delay = retryMs;
      setConnected(false);
      open();
      void reload();
    };
    document.addEventListener('visibilitychange', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      stopped = true;
      source?.close();
      clearTimeout(retry);
      clearTimeout(flush);
    };
  }, [connect, reload, retryMs, debounceMs]);
  return (
    <LiveContext.Provider
      value={{ tenants, tasks, decisions, connected, loaded, error, reload, subscribe }}
    >
      {children}
    </LiveContext.Provider>
  );
}
