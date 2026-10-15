import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProcessRunnerService } from '../agents/process-runner.service';
import type { AgentResult } from '../agents/agent.types';
import { config, TaskError } from '../config';
import type { CoderWorkspaceConfig } from '../tenants/tenants';
import { shellLine, shellQuote } from './shell';
import {
  safeEntry,
  safeRel,
  TaskWorkspace,
  WorkspaceRunOptions,
  WorkspaceState,
} from './task-workspace';
/**
 * The transport failed (the coder CLI behind ssh, or ssh losing it); a command's own failure never
 * carries it. `coder gitssh` (git in the workspace) is the command's own business, not the Coder's.
 */
const CODER_ERROR =
  /Encountered an error running "coder ssh"|kex_exchange_identification|Connection closed by UNKNOWN/;
const START_TIMEOUT_MS = 5 * 60 * 1000;
const UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
/** One line per repository (depth ≤ 2) under each folder: path HEAD branch status-hash. */
const SNAPSHOT = `for base in "$@"; do for d in "$base" "$base"/* "$base"/*/*; do
[ -d "$d/.git" ] || continue
printf '%s %s %s %s\\n' "$d" "$(git -C "$d" rev-parse HEAD 2>/dev/null)" "$(git -C "$d" branch --show-current 2>/dev/null)" "$(GIT_OPTIONAL_LOCKS=0 git -C "$d" status --porcelain 2>/dev/null | sha1sum | cut -c1-40)"
done; done`;
/**
 * Kills what still runs in the task folder: without a terminal, closing `coder ssh` here does
 * not guarantee the remote command dies with it.
 */
const KILL_IN_FOLDER = `for p in /proc/[0-9]*; do c=$(readlink "$p/cwd" 2>/dev/null) || continue
case "$c" in "$1"|"$1"/*) kill -9 "\${p#/proc/}" 2>/dev/null;; esac; done; true`;
/**
 * The coder CLI finds the operator's saved login under HOME; the process runner passes only PATH
 * and LANG, so HOME goes along to these calls (and only these: agents keep their own HOME).
 */
const cliEnv = () => ({ HOME: process.env.HOME });
/** Reasons the process runner cuts a command off (see ProcessRunnerService). */
const CUT_OFF = /Process timed out|Output limit exceeded/;
/** Unpacks the archive on stdin and keeps the folder out of the task's git status. */
const UPLOAD =
  'mkdir -p "$1" && base64 -d | tar -xf - -C "$1" && mkdir -p .git/info && (grep -qxF /.ai-dev-team/ .git/info/exclude 2>/dev/null || echo /.ai-dev-team/ >> .git/info/exclude)';
export type CoderFailure = 'stopped' | 'login' | 'unreachable';
export function coderError(r: AgentResult): CoderFailure | undefined {
  if (r.success || !CODER_ERROR.test(r.stderr)) return undefined;
  if (/not logged in|\b401\b|unauthorized/i.test(r.stderr)) return 'login';
  if (/not running|is stopped|stopping|must be started/i.test(r.stderr)) return 'stopped';
  return 'unreachable';
}
/** Repositories whose snapshot line changed (or appeared / disappeared). */
export function changedRepositories(before: string, after: string) {
  const index = (text: string) =>
    new Map(
      text
        .split('\n')
        .filter(Boolean)
        .map((l) => [l.split(' ')[0], l]),
    );
  const a = index(before),
    b = index(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort();
}
async function assertNoLinks(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if ((await lstat(full)).isSymbolicLink())
      throw new TaskError(`Upload refused: symbolic link ${full}`);
    if (entry.isDirectory()) await assertNoLinks(full);
  }
}
/**
 * The task folder inside a Coder workspace of the company, reached with `coder ssh`: clone,
 * agent, tests and commits run there and only results come back. The audit keeps no output.
 */
export class CoderWorkspace implements TaskWorkspace {
  readonly kind = 'coder' as const;
  readonly path: string;
  readonly root: string;
  readonly attachmentsPath: string;
  private readonly target: string;
  constructor(
    private readonly runner: ProcessRunnerService,
    readonly cfg: CoderWorkspaceConfig,
    private readonly taskId: string,
    private readonly bin = config().CODER_BIN,
  ) {
    if (!/^[0-9a-f-]{36}$/.test(taskId)) throw new TaskError('Invalid task ID');
    this.root = cfg.root;
    this.path = `${cfg.root}/${taskId}`;
    this.attachmentsPath = `${this.path}/.ai-dev-team/attachments`;
    this.target = cfg.agent ? `${cfg.name}.${cfg.agent}` : cfg.name;
  }
  get label() {
    return `${this.cfg.name}:${this.path}`;
  }
  private once(argv: string[], opts: WorkspaceRunOptions) {
    const at = opts.at ?? 'task';
    const dir = at === 'task' ? this.path : at === 'root' ? this.root : undefined;
    const command = `${dir ? `cd ${shellQuote(dir)} && ` : ''}exec ${shellLine(argv, opts.env)}`;
    // `coder ssh <workspace> -- cmd` always gives the remote side a terminal: stdin never ends
    // (uploads, hooks and prompts hang) and output comes back with \r\n. OpenSSH through
    // `coder ssh --stdio` (as coder config-ssh does) runs the command without one (-T). The channel
    // is authenticated by Coder itself, hence no host key check, and no user ssh config (-F).
    const ssh = [
      '-T',
      '-F',
      '/dev/null',
      '-o',
      `ProxyCommand=${shellQuote(this.bin)} ssh --stdio ${this.target}`,
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'LogLevel=ERROR',
      `coder.${this.target}`,
    ];
    // ssh joins its arguments for the remote shell: one quoted line.
    return this.runner.run('ssh', [...ssh, `sh -c ${shellQuote(command)}`], {
      cwd: '/',
      env: cliEnv(),
      taskId: opts.taskId ?? this.taskId,
      agent: opts.agent ?? 'workspace',
      provider: opts.provider,
      timeoutMs: opts.timeoutMs,
      input: opts.input,
      maxOutputBytes: opts.maxOutputBytes,
      auditContent: false,
      displayCommand: JSON.stringify(['coder', this.target, ...argv]),
    });
  }
  async run(argv: string[], opts: WorkspaceRunOptions): Promise<AgentResult> {
    let r = await this.once(argv, opts);
    let failure = coderError(r);
    if (failure === 'stopped') {
      await this.runner.run(this.bin, ['start', this.cfg.name, '--yes'], {
        cwd: '/',
        env: cliEnv(),
        taskId: this.taskId,
        agent: 'workspace',
        timeoutMs: START_TIMEOUT_MS,
        auditContent: false,
      });
      r = await this.once(argv, opts);
      failure = coderError(r);
    }
    if (failure === 'stopped')
      throw new TaskError(
        `Workspace ${this.cfg.name} parado: não ficou pronto depois do coder start`,
        true,
      );
    if (failure === 'login')
      throw new TaskError(
        `Sessão do Coder expirada: rode \`coder login ${this.cfg.url}\` no WSL e repita a tarefa`,
        false,
      );
    if (failure === 'unreachable')
      throw new TaskError(`Coder inacessível (${this.cfg.url}) — a VPN está ligada?`, true);
    // Cut off here: whatever it started there must not keep changing the folder.
    if (!r.success && CUT_OFF.test(r.stderr)) await this.killInFolder();
    return r;
  }
  private async killInFolder() {
    await this.once(['sh', '-c', KILL_IN_FOLDER, 'sh', this.path], {
      timeoutMs: 60000,
      at: 'none',
      agent: 'cleanup',
    }).catch(() => undefined);
  }
  private async check(argv: string[], at: WorkspaceRunOptions['at'], what: string) {
    const r = await this.run(argv, { timeoutMs: 120000, at });
    if (!r.success) throw new TaskError(`${what} failed in ${this.label}: ${r.stderr.slice(-500)}`);
    return r.stdout;
  }
  async ensureRoot() {
    await this.check(['mkdir', '-p', '--', this.root], 'none', 'mkdir');
  }
  async state(): Promise<WorkspaceState> {
    const out = await this.check(
      [
        'sh',
        '-c',
        'if [ -L "$1" ]; then echo unsafe; elif [ -d "$1" ]; then echo directory; elif [ -e "$1" ]; then echo unsafe; else echo missing; fi',
        'sh',
        this.path,
      ],
      'none',
      'state',
    );
    const state = out.trim();
    if (state !== 'missing' && state !== 'directory' && state !== 'unsafe')
      throw new TaskError(`Unexpected workspace state: ${state}`);
    return state;
  }
  async remove(rel: string) {
    await this.check(['rm', '-rf', '--', safeRel(rel)], 'task', 'rm');
  }
  async removeEntry(name: string) {
    await this.check(['rm', '-rf', '--', safeEntry(name)], 'root', 'rm');
  }
  async renameEntry(from: string, to: string) {
    await this.check(['mv', '--', safeEntry(from), safeEntry(to)], 'root', 'mv');
  }
  async isSymlink(rel: string) {
    return (await this.run(['test', '-L', safeRel(rel)], { timeoutMs: 60000 })).success;
  }
  async readText(rel: string, maxBytes: number) {
    const r = await this.run(['head', '-c', String(maxBytes), '--', safeRel(rel)], {
      timeoutMs: 60000,
    });
    return r.success ? r.stdout : undefined;
  }
  async readFile(rel: string, maxBytes: number) {
    // ssh carries text: the bytes come back in base64 (one line, ~4/3 of the size).
    const r = await this.run(
      ['sh', '-c', 'head -c "$1" -- "$2" | base64 -w0', 'sh', String(maxBytes), safeRel(rel)],
      { timeoutMs: 300000, maxOutputBytes: Math.ceil(maxBytes * 1.4) + 1024 },
    );
    return r.success ? Buffer.from(r.stdout.trim(), 'base64') : undefined;
  }
  async upload(localDir: string, rel: string) {
    const dest = safeRel(rel);
    await assertNoLinks(localDir);
    const tar = await new Promise<Buffer>((done, fail) =>
      execFile(
        'tar',
        ['-C', localDir, '-cf', '-', '.'],
        { encoding: 'buffer', maxBuffer: UPLOAD_MAX_BYTES },
        (error, stdout) =>
          error ? fail(new TaskError(`tar failed: ${error.message}`)) : done(stdout),
      ),
    );
    const r = await this.run(['sh', '-c', UPLOAD, 'sh', dest], {
      timeoutMs: 600000,
      agent: 'upload',
      input: tar.toString('base64'),
    });
    if (!r.success) throw new TaskError(`upload failed in ${this.label}: ${r.stderr.slice(-500)}`);
  }
  /** Lines "path HEAD branch status-hash" of the repositories the agent must leave alone. */
  async protectSnapshot(taskId?: string) {
    const r = await this.run(['sh', '-c', SNAPSHOT, 'sh', ...this.cfg.protect], {
      timeoutMs: 120000,
      at: 'none',
      taskId,
      agent: 'protect',
    });
    if (!r.success)
      throw new TaskError(
        `Could not read ${this.cfg.protect.join(', ')} in ${this.cfg.name}: ${r.stderr.slice(-300)}`,
      );
    return r.stdout;
  }
  async destroy() {
    await this.check(['rm', '-rf', '--', this.path], 'none', 'rm');
  }
}
