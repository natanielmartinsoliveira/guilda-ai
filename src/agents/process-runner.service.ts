import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { spawn } from 'node:child_process';
import { config, log, redact } from '../config';
import { AgentRun } from '../database/entities';
import { AgentResult } from './agent.types';
export interface RunOptions {
  cwd: string;
  taskId?: string;
  agent?: string;
  provider?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
  displayCommand?: string;
  /** Output allowed for this command (default MAX_OUTPUT_BYTES); the audit copy stays capped. */
  maxOutputBytes?: number;
  /** false: the audit keeps only sizes (code of companies that keep it off this machine). */
  auditContent?: boolean;
}
export const auditable = (text: string) => text.replace(/\u0000/g, '\\0');
@Injectable()
export class ProcessRunnerService {
  constructor(private readonly db: DataSource) {}
  async run(bin: string, args: string[], opts: RunOptions): Promise<AgentResult> {
    const startedAt = new Date(),
      display = opts.displayCommand ?? JSON.stringify([bin, ...args]);
    let record: AgentRun | undefined;
    if (opts.taskId)
      record = await this.db.getRepository(AgentRun).save({
        taskId: opts.taskId,
        agent: opts.agent ?? 'system',
        provider: opts.provider ?? 'system',
        status: 'RUNNING',
        command: redact(display),
        startedAt,
      });
    log('command.started', {
      taskId: opts.taskId,
      agent: opts.agent,
      provider: opts.provider,
      command: display,
    });
    const result = await new Promise<AgentResult>((resolve) => {
      let stdout = Buffer.alloc(0),
        stderr = Buffer.alloc(0),
        reason = '';
      const child = spawn(bin, args, {
        cwd: opts.cwd,
        shell: false,
        detached: true,
        env: { PATH: process.env.PATH, LANG: 'C.UTF-8', ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const kill = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      };
      const timer = setTimeout(() => {
        reason = 'Process timed out';
        kill();
      }, opts.timeoutMs);
      const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
        const cap = opts.maxOutputBytes ?? config().MAX_OUTPUT_BYTES,
          current = stream === 'stdout' ? stdout : stderr;
        const next = Buffer.concat([current, chunk.subarray(0, Math.max(0, cap - current.length))]);
        if (stream === 'stdout') stdout = next;
        else stderr = next;
        if (current.length + chunk.length > cap) {
          reason = 'Output limit exceeded';
          kill();
        }
      };
      child.stdout.on('data', (c: Buffer) => collect(c, 'stdout'));
      child.stderr.on('data', (c: Buffer) => collect(c, 'stderr'));
      child.stdin.on('error', () => {});
      child.stdin.end(opts.input);
      child.on('error', (error) => {
        reason = `Spawn failed: ${error.message}`;
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        kill();
        resolve({
          success: code === 0 && !reason,
          exitCode: reason ? -1 : (code ?? -1),
          stdout: redact(stdout.toString()),
          stderr: redact([stderr.toString(), reason].filter(Boolean).join('\n')),
        });
      });
    });
    // PostgreSQL text rejects NUL bytes (e.g. `git ls-files -z`); the caller keeps the raw
    // output, only the audit copy is made storable.
    const kept = (text: string) =>
      opts.auditContent === false
        ? `[${Buffer.byteLength(text)} bytes omitted]`
        : auditable(text).slice(0, config().MAX_OUTPUT_BYTES);
    if (record)
      await this.db.getRepository(AgentRun).update(record.id, {
        stdout: kept(result.stdout),
        stderr: kept(result.stderr),
        exitCode: result.exitCode,
        status: result.success ? 'SUCCESS' : 'FAILED',
        finishedAt: new Date(),
      });
    log('command.finished', {
      taskId: opts.taskId,
      agent: opts.agent,
      provider: opts.provider,
      duration: Date.now() - startedAt.getTime(),
      status: result.success ? 'SUCCESS' : 'FAILED',
      exitCode: result.exitCode,
    });
    return result;
  }
}
