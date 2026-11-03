import { TaskError } from '../config';
import type { CoderWorkspace } from '../workspaces/coder-workspace';
export interface WorkspacePlugin {
  /** plugin@marketplace, as `claude plugin list` names it. */
  id: string;
  /** Where the marketplace comes from (owner/repo or a git URL), to add it when missing. */
  marketplace: string;
  /** The oldest version accepted; an older one is updated. */
  minVersion?: string;
}
interface Installed {
  id: string;
  version?: string;
  enabled?: boolean;
}
/** 5.20.0 < 5.9.1 is false: numbers compared one by one (a missing one is 0). */
export function olderThan(version: string | undefined, minimum: string) {
  const parts = (v: string) => v.split(/[.+-]/).map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(version ?? '0');
  const b = parts(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}
type PluginProblem = { plugin: WorkspacePlugin } & (
  { problem: 'missing' | 'disabled' } | { problem: 'old'; version?: string }
);
/** What is still wrong with the workspace's plugins (empty: all as the company declared). */
export function pluginProblems(installed: Installed[], wanted: WorkspacePlugin[]) {
  return wanted.flatMap((p): PluginProblem[] => {
    const found = installed.find((i) => i.id === p.id);
    if (!found) return [{ plugin: p, problem: 'missing' }];
    if (p.minVersion && olderThan(found.version, p.minVersion))
      return [{ plugin: p, problem: 'old', version: found.version }];
    if (found.enabled === false) return [{ plugin: p, problem: 'disabled' }];
    return [];
  });
}
const CHECKED_MS = 30 * 60 * 1000;
const checked = new Map<string, number>();
/**
 * The Claude plugins the company declares for its workspaces, installed, recent enough and
 * enabled before an agent runs there (checked again after half an hour). A plugin the
 * workspace cannot get stops the task as configuration, saying what to run there.
 */
export async function ensurePlugins(
  ws: CoderWorkspace,
  wanted: WorkspacePlugin[],
  taskId?: string,
  now = Date.now(),
) {
  if (!wanted.length) return;
  const key = `${ws.cfg.url} ${ws.cfg.name} ${JSON.stringify(wanted)}`;
  const last = checked.get(key);
  if (last !== undefined && last > now - CHECKED_MS) return;
  const run = (argv: string[], timeoutMs = 120000) =>
    ws.run(argv, { taskId, agent: 'plugins', provider: 'claude', timeoutMs, at: 'none' });
  const list = async (): Promise<Installed[]> => {
    const r = await run(['claude', 'plugin', 'list', '--json'], 30000);
    try {
      const parsed = JSON.parse(r.stdout) as unknown;
      return Array.isArray(parsed) ? (parsed as Installed[]) : [];
    } catch {
      throw new TaskError(
        `Claude do workspace ${ws.cfg.name} não lista os plugins (claude plugin list --json): atualize o Claude no workspace`,
        false,
      );
    }
  };
  for (const { plugin, problem } of pluginProblems(await list(), wanted)) {
    const market = plugin.id.split('@')[1];
    if (problem === 'missing') {
      // Adding a marketplace it already has fails harmlessly; the install says what matters.
      await run(['claude', 'plugin', 'marketplace', 'add', plugin.marketplace]);
      await run(['claude', 'plugin', 'install', plugin.id]);
    } else if (problem === 'old') {
      if (market) await run(['claude', 'plugin', 'marketplace', 'update', market]);
      await run(['claude', 'plugin', 'update', plugin.id]);
    } else await run(['claude', 'plugin', 'enable', plugin.id]);
  }
  const left = pluginProblems(await list(), wanted);
  if (left.length)
    throw new TaskError(
      `Plugins do Claude no workspace ${ws.cfg.name} fora do que a empresa pede: ${left
        .map((l) =>
          l.problem === 'old'
            ? `${l.plugin.id} ${l.version ?? '?'} (mínimo ${l.plugin.minVersion})`
            : `${l.plugin.id} (${l.problem === 'missing' ? 'não instalado' : 'desligado'})`,
        )
        .join(
          ', ',
        )}. No terminal do workspace: claude plugin marketplace add ${left[0].plugin.marketplace} e claude plugin install ${left[0].plugin.id}`,
      false,
    );
  checked.set(key, now);
}
