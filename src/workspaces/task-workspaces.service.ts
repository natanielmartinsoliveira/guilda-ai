import { Injectable } from '@nestjs/common';
import { ProcessRunnerService } from '../agents/process-runner.service';
import { TaskError } from '../config';
import { Task } from '../database/entities';
import { findTenant, TenantProject } from '../tenants/tenants';
import { CoderWorkspace } from './coder-workspace';
import { LocalWorkspace } from './local-workspace';
import { TaskWorkspace } from './task-workspace';
/** Which workspace each task works in; the worker binds it before any git work. */
@Injectable()
export class TaskWorkspaces {
  private readonly bound = new Map<string, TaskWorkspace>();
  constructor(private readonly runner: ProcessRunnerService) {}
  create(task: Pick<Task, 'id' | 'workspace'>, cfg: TenantProject['workspace']): TaskWorkspace {
    return cfg.type === 'coder'
      ? new CoderWorkspace(this.runner, cfg, task.id)
      : new LocalWorkspace(this.runner, task.workspace);
  }
  bind(task: Pick<Task, 'id' | 'workspace'>, cfg: TenantProject['workspace']) {
    const ws = this.create(task, cfg);
    this.bound.set(task.id, ws);
    return ws;
  }
  of(task: Pick<Task, 'id' | 'tenantId' | 'workspace'>): TaskWorkspace {
    const ws = this.bound.get(task.id);
    if (ws) return ws;
    // A company whose code stays in its workspace never falls back to a clone on this machine.
    let coder = false;
    try {
      coder = !!findTenant(task.tenantId)?.projects.some((p) => p.workspace.type === 'coder');
    } catch {
      coder = false;
    }
    if (coder) throw new TaskError(`Task ${task.id}: workspace not bound (coder company)`);
    return new LocalWorkspace(this.runner, task.workspace);
  }
}
