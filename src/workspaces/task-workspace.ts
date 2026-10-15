import { TaskError } from '../config';
import type { AgentResult } from '../agents/agent.types';
export interface WorkspaceRunOptions {
  /** task (default): the task folder; root: its parent (clone, ls-remote); none: no cd. */
  at?: 'task' | 'root' | 'none';
  taskId?: string;
  agent?: string;
  provider?: string;
  timeoutMs: number;
  env?: Record<string, string>;
  input?: string;
  maxOutputBytes?: number;
}
export type WorkspaceState = 'missing' | 'directory' | 'unsafe';
/**
 * Where a task's working copy lives and how commands reach it: this machine (bubblewrap for the
 * agents) or a Coder workspace of the company (coder ssh, the code never comes here).
 */
export interface TaskWorkspace {
  readonly kind: 'local' | 'coder';
  /** The task folder as seen by the commands that run in it. */
  readonly path: string;
  /** Its parent: where the task folders live. */
  readonly root: string;
  /** Where the agent finds the attachments. */
  readonly attachmentsPath: string;
  /** Where to look, for people (e.g. "dev-ws:/root/ai-dev-team/<task>"). */
  readonly label: string;
  run(argv: string[], opts: WorkspaceRunOptions): Promise<AgentResult>;
  ensureRoot(): Promise<void>;
  state(): Promise<WorkspaceState>;
  /** rm -rf of a path inside the task folder. */
  remove(rel: string): Promise<void>;
  /** rm -rf / mv of entries right under the root (the clone's temporary folder). */
  removeEntry(name: string): Promise<void>;
  renameEntry(from: string, to: string): Promise<void>;
  isSymlink(rel: string): Promise<boolean>;
  /** Up to maxBytes of a file in the task folder; undefined when unreadable. */
  readText(rel: string, maxBytes: number): Promise<string | undefined>;
  /** Up to maxBytes of a (binary) file in the task folder; undefined when unreadable. */
  readFile(rel: string, maxBytes: number): Promise<Buffer | undefined>;
  /** Copies a local folder (attachments, design) to <task folder>/<rel>. */
  upload(localDir: string, rel: string): Promise<void>;
  /** Removes the task folder. */
  destroy(): Promise<void>;
}
export function safeRel(rel: string) {
  if (!rel || rel.includes('\0') || rel.startsWith('/') || rel.split('/').includes('..'))
    throw new TaskError(`Unsafe path in the task workspace: ${JSON.stringify(rel)}`);
  return rel;
}
export function safeEntry(name: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    throw new TaskError(`Unsafe workspace entry: ${JSON.stringify(name)}`);
  return name;
}
