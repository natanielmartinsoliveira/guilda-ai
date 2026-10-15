import { Injectable } from '@nestjs/common';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config, TaskError, workspace } from '../config';
import { DockerRunnerConfig } from '../tenants/tenants';
import { ProcessRunnerService } from './process-runner.service';
import { AgentResult } from './agent.types';
export interface ContainerRunOptions {
  taskId: string;
  tenantId: string;
  /** Host workspace of the task; mounted at runner.workdir. */
  cwd: string;
  agent: string;
  timeoutMs: number;
  /** Extra mounts (read-only unless writable); sources must be inside the tenant's workspace root. */
  mounts?: { source: string; target: string; writable?: boolean }[];
}
/**
 * Runs an operator-configured command in a throwaway container. The docker invocation is built
 * here from tenants.yaml only — never from compose files or Dockerfiles in the repository — so
 * code in the task branch cannot change how or where it runs.
 */
/** Variables the docker CLI process needs for itself. */
const CLI_VARS = ['HOME', 'PATH', 'DOCKER_HOST'];
@Injectable()
export class DockerRunnerService {
  constructor(private readonly runner: ProcessRunnerService) {}
  async run(
    runner: DockerRunnerConfig,
    argv: string[],
    opts: ContainerRunOptions,
  ): Promise<AgentResult> {
    if (!opts.taskId || (await realpath(opts.cwd)) !== workspace(opts.tenantId, opts.taskId))
      throw new TaskError('Workspace path is not isolated');
    const root = `${await realpath(resolve(config().WORKSPACE_ROOT, opts.tenantId))}/`;
    const mounts: string[] = [];
    for (const m of opts.mounts ?? []) {
      if (!(await realpath(m.source)).startsWith(root) || !/^\/[A-Za-z0-9._/-]+$/.test(m.target))
        throw new TaskError(`Mount outside the tenant workspaces: ${m.source}`);
      mounts.push(
        '--mount',
        `type=bind,source=${m.source},target=${m.target}${m.writable ? '' : ',readonly'}`,
      );
    }
    const name = `ai-dev-${opts.taskId.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
    const user = runner.user ?? `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    const vars = { ...runner.env, AI_TASK_ID: opts.taskId };
    const args = [
      'run',
      '--rm',
      '--name',
      name,
      '--label',
      `ai-dev-team.task=${opts.taskId}`,
      '--network',
      runner.network,
      '--user',
      user,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '1024',
      ...(runner.nofile ? ['--ulimit', `nofile=${runner.nofile}:${runner.nofile}`] : []),
      '--memory',
      runner.memory,
      '--cpus',
      runner.cpus,
      '--workdir',
      runner.workdir,
      '--mount',
      `type=bind,source=${opts.cwd},target=${runner.workdir}`,
      // Same rule as the sandbox: history is readable, never writable.
      '--mount',
      `type=bind,source=${resolve(opts.cwd, '.git')},target=${runner.workdir}/.git,readonly`,
      ...mounts,
      // Values travel in the CLI's environment, so they never appear in the audited argv. The
      // names the docker CLI itself needs (HOME, PATH, DOCKER_HOST) would be overwritten there,
      // so those go inline: they are paths, never secrets.
      ...Object.entries(vars).flatMap(([key, value]) =>
        CLI_VARS.includes(key) ? ['--env', `${key}=${value}`] : ['--env', key],
      ),
      '--entrypoint',
      argv[0],
      runner.image,
      ...argv.slice(1),
    ];
    try {
      return await this.runner.run(config().DOCKER_BIN, args, {
        cwd: opts.cwd,
        taskId: opts.taskId,
        agent: opts.agent,
        timeoutMs: opts.timeoutMs,
        env: {
          ...Object.fromEntries(Object.entries(vars).filter(([key]) => !CLI_VARS.includes(key))),
          // The CLI must reach the same daemon the operator uses.
          ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
          ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        },
        displayCommand: JSON.stringify(['docker', runner.image, ...argv]),
      });
    } finally {
      // Killing the CLI on timeout leaves the container running; remove it explicitly.
      await this.runner
        .run(config().DOCKER_BIN, ['rm', '--force', name], {
          cwd: opts.cwd,
          timeoutMs: 30000,
          env: process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {},
        })
        .catch(() => undefined);
    }
  }
}
