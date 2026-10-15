import { lstat, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ProcessRunnerService } from '../agents/process-runner.service';
import { ATTACHMENTS_MOUNT } from '../agents/agent.types';
import { TaskError } from '../config';
import {
  safeEntry,
  safeRel,
  TaskWorkspace,
  WorkspaceRunOptions,
  WorkspaceState,
} from './task-workspace';
/** The task folder on this machine (workspaces/<tenant>/<task>); agents run in bubblewrap. */
export class LocalWorkspace implements TaskWorkspace {
  readonly kind = 'local' as const;
  readonly root: string;
  readonly attachmentsPath = ATTACHMENTS_MOUNT;
  constructor(
    private readonly runner: ProcessRunnerService,
    readonly path: string,
  ) {
    this.root = dirname(path);
  }
  get label() {
    return this.path;
  }
  run(argv: string[], opts: WorkspaceRunOptions) {
    const at = opts.at ?? 'task';
    return this.runner.run(argv[0], argv.slice(1), {
      cwd: at === 'task' ? this.path : at === 'root' ? this.root : '/',
      taskId: opts.taskId,
      agent: opts.agent,
      provider: opts.provider,
      timeoutMs: opts.timeoutMs,
      env: opts.env,
      input: opts.input,
      maxOutputBytes: opts.maxOutputBytes,
    });
  }
  async ensureRoot() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }
  async state(): Promise<WorkspaceState> {
    try {
      const st = await lstat(this.path);
      if (st.isSymbolicLink() || !st.isDirectory() || (await realpath(this.path)) !== this.path)
        return 'unsafe';
      return 'directory';
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw e;
    }
  }
  async remove(rel: string) {
    await rm(resolve(this.path, safeRel(rel)), { recursive: true, force: true });
  }
  async removeEntry(name: string) {
    await rm(resolve(this.root, safeEntry(name)), { recursive: true, force: true });
  }
  async renameEntry(from: string, to: string) {
    await rename(resolve(this.root, safeEntry(from)), resolve(this.root, safeEntry(to)));
  }
  async isSymlink(rel: string) {
    try {
      return (await lstat(resolve(this.path, safeRel(rel)))).isSymbolicLink();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
  }
  async readText(rel: string, maxBytes: number) {
    const text = await readFile(resolve(this.path, safeRel(rel)), 'latin1').catch(() => undefined);
    return text?.slice(0, maxBytes);
  }
  async readFile(rel: string, maxBytes: number) {
    const bytes = await readFile(resolve(this.path, safeRel(rel))).catch(() => undefined);
    return bytes?.subarray(0, maxBytes);
  }
  upload(): Promise<void> {
    // Local runs mount the attachments folder read-only instead.
    return Promise.reject(new TaskError('Local workspaces mount attachments; nothing to upload'));
  }
  async destroy() {
    await rm(this.path, { recursive: true, force: true });
  }
}
