import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { config, log, redact } from '../config';
import { Task } from '../database/entities';
import { DockerRunnerService } from '../agents/docker-runner.service';
import { GitService } from '../git/git.service';
import { ChecksConfig, DockerRunnerConfig } from '../tenants/tenants';
import { TaskWorkspaces } from '../workspaces/task-workspaces.service';
import { TaskWorkspace } from '../workspaces/task-workspace';
import { REMOTE_CHECKS, remoteChecksInput, RemoteChecksOutput } from './remote-checks';
export type CheckTool = 'gitleaks' | 'semgrep' | 'osv';
export interface Finding {
  tool: CheckTool;
  rule: string;
  file: string;
  line?: number;
  message: string;
  severity?: string;
}
export interface ChecksResult {
  /** Findings the change introduces (absent at the base commit). */
  findings: Finding[];
  /** Per tool: files analysed, findings now, findings at the base. */
  tools: Partial<Record<CheckTool, { files: number; now: number; base: number }>>;
  /** Tools that could not run; reported, never blocking. */
  errors: string[];
}
const LOCKFILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'poetry.lock',
  'Pipfile.lock',
  'requirements.txt',
  'go.sum',
  'Cargo.lock',
  'Gemfile.lock',
]);
/** Where each tool writes its JSON report, inside the container. */
const REPORT = '/out/report.json';
/** Larger files are not copied for analysis (generated bundles, fixtures). */
const MAX_FILE = 2 * 1024 * 1024;
interface Raw {
  finding: Finding;
  /** Identity independent of line numbers, so code moved by the change is not "new". */
  key: string;
}
/**
 * Runs the project's security checks on the files a change touched, in throwaway containers,
 * and keeps only what the change introduced: the same tools run on those files as they were at
 * the base commit, and findings present there are discarded. Legacy code never blocks, and the
 * analysis cost follows the size of the change, not of the repository.
 */
@Injectable()
export class ChecksService {
  constructor(
    private readonly git: GitService,
    private readonly containers: DockerRunnerService,
    private readonly workspaces?: TaskWorkspaces,
  ) {}
  async run(task: Task, cfg: ChecksConfig, baseSha: string): Promise<ChecksResult> {
    const result: ChecksResult = { findings: [], tools: {}, errors: [] };
    const changed = await this.git.changedSince(task, baseSha);
    if (!changed.length) return result;
    const ws = this.workspaces?.of(task);
    if (ws?.kind === 'coder') return this.remote(task, ws, cfg, baseSha, changed);
    const dir = resolve(config().WORKSPACE_ROOT, task.tenantId, `.checks-${task.id}`);
    await rm(dir, { recursive: true, force: true });
    try {
      const files = await this.snapshot(task, baseSha, changed, dir);
      if (!files.length) return result;
      const scope = cfg.scope ? new RegExp(cfg.scope, 'i') : undefined;
      for (const tool of cfg.tools) {
        const targets =
          tool === 'semgrep'
            ? files.filter((f) => !scope || scope.test(f))
            : tool === 'osv'
              ? files.filter((f) => LOCKFILES.has(basename(f)))
              : files;
        if (!targets.length) continue;
        try {
          const [now, base] = await Promise.all(
            (['cur', 'base'] as const).map((side) =>
              this.tool(task, cfg, tool, dir, side, targets),
            ),
          );
          result.findings.push(...newFindings(now, base));
          result.tools[tool] = { files: targets.length, now: now.length, base: base.length };
        } catch (error) {
          const message = redact(error instanceof Error ? error.message : String(error));
          result.errors.push(`${tool}: ${message.slice(0, 500)}`);
          log('checks.tool_failed', { taskId: task.id, tool, error: message.slice(0, 500) });
        }
      }
      return result;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  /**
   * In a company's Coder workspace: the same tools run there and only metadata comes back
   * (see REMOTE_CHECKS); new findings are the ones whose key is absent at the base.
   */
  private async remote(
    task: Task,
    ws: TaskWorkspace,
    cfg: ChecksConfig,
    baseSha: string,
    changed: string[],
  ): Promise<ChecksResult> {
    const result: ChecksResult = { findings: [], tools: {}, errors: [] };
    const timeout = Math.max(60, Math.floor(config().TEST_TIMEOUT_MS / 1000));
    const r = await ws.run(['python3', '-c', REMOTE_CHECKS], {
      taskId: task.id,
      agent: 'checks',
      // Every tool, both sides.
      timeoutMs: config().TEST_TIMEOUT_MS * cfg.tools.length * 2 + 60000,
      maxOutputBytes: 16 * 1024 * 1024,
      input: remoteChecksInput(cfg, baseSha, changed, timeout),
    });
    // The report is the last line; anything printed before it (warnings) is ignored.
    const last = r.stdout.trim().split('\n').pop() ?? '';
    let output: RemoteChecksOutput | undefined;
    try {
      output = r.success ? (JSON.parse(last) as RemoteChecksOutput) : undefined;
    } catch {
      output = undefined;
    }
    if (!output) {
      result.errors.push(
        `checks: ${redact((r.stderr || r.stdout).slice(-500)) || `exit ${r.exitCode}`}`,
      );
      return result;
    }
    for (const [tool, t] of Object.entries(output.tools) as [
      CheckTool,
      NonNullable<RemoteChecksOutput['tools'][CheckTool]>,
    ][]) {
      result.findings.push(...newFindings(t.cur, t.base));
      result.tools[tool] = { files: t.files, now: t.cur.length, base: t.base.length };
    }
    result.errors.push(...output.errors.map((e) => redact(e).slice(0, 500)));
    return result;
  }
  /** Copies each changed file as it is now (cur/) and as it was at the base (base/). */
  private async snapshot(task: Task, baseSha: string, changed: string[], dir: string) {
    const copied: string[] = [];
    for (const file of changed) {
      if (file.split('/').includes('..') || file.startsWith('/')) continue;
      const source = resolve(task.workspace, file);
      try {
        const st = await lstat(source);
        // Deleted files cannot introduce anything; symlinks are never followed.
        if (!st.isFile() || st.size > MAX_FILE) continue;
      } catch {
        continue;
      }
      await mkdir(dirname(resolve(dir, 'cur', file)), { recursive: true });
      await copyFile(source, resolve(dir, 'cur', file));
      const before = await this.git.fileAt(task, baseSha, file);
      if (before && before.length <= MAX_FILE) {
        await mkdir(dirname(resolve(dir, 'base', file)), { recursive: true });
        await writeFile(resolve(dir, 'base', file), before);
      }
      copied.push(file);
    }
    // Both sides always exist, even when every file is new.
    await mkdir(resolve(dir, 'cur'), { recursive: true });
    await mkdir(resolve(dir, 'base'), { recursive: true });
    return copied;
  }
  private async tool(
    task: Task,
    cfg: ChecksConfig,
    tool: CheckTool,
    dir: string,
    side: 'cur' | 'base',
    targets: string[],
  ): Promise<Raw[]> {
    const mount = `/scan/${side}`;
    // Only files present on this side are analysed (new files have no base version).
    const present: string[] = [];
    for (const f of targets)
      if (
        await lstat(resolve(dir, side, f)).then(
          () => true,
          () => false,
        )
      )
        present.push(f);
    if (!present.length) return [];
    const runner: DockerRunnerConfig = {
      type: 'docker',
      image: cfg.images[tool],
      // Semgrep downloads its rules and osv-scanner queries osv.dev (package names and
      // versions only); gitleaks needs nothing. No code leaves the machine.
      network: tool === 'gitleaks' ? 'none' : 'bridge',
      workdir: '/src',
      env: { HOME: '/tmp', SEMGREP_SEND_METRICS: 'off', XDG_CACHE_HOME: '/tmp/.cache' },
      memory: '4g',
      cpus: '2',
    };
    const argv =
      tool === 'semgrep'
        ? [
            'semgrep',
            'scan',
            '--metrics=off',
            '--disable-version-check',
            '--json',
            '--output',
            REPORT,
            '--quiet',
            '--timeout',
            '30',
            ...cfg.semgrep!.configs.flatMap((c) => ['--config', c]),
            ...present.map((f) => `${mount}/${f}`),
          ]
        : tool === 'gitleaks'
          ? [
              'gitleaks',
              'dir',
              mount,
              '--no-banner',
              '--exit-code',
              '0',
              // Partial: tells different secrets apart without the audit log storing them.
              '--redact=85',
              '--report-format',
              'json',
              '--report-path',
              REPORT,
            ]
          : [
              '/osv-scanner',
              'scan',
              'source',
              '--format',
              'json',
              '--output-file',
              REPORT,
              ...present.map((f) => `${mount}/${f}`),
            ];
    // Reports go to a file: a large one (e.g. a lockfile with thousands of packages) would
    // exceed the cap on captured command output.
    const out = resolve(dir, `out-${side}`);
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    const r = await this.containers.run(runner, argv, {
      taskId: task.id,
      tenantId: task.tenantId,
      cwd: task.workspace,
      agent: `check-${tool}`,
      timeoutMs: config().TEST_TIMEOUT_MS,
      mounts: [
        { source: resolve(dir, side), target: mount },
        { source: out, target: '/out', writable: true },
      ],
    });
    // osv-scanner exits 1 when it finds vulnerabilities, and 128 when the lockfile has no
    // packages (e.g. the base version of a new lockfile); semgrep/gitleaks exit 0 here.
    if (
      tool === 'osv' &&
      r.exitCode === 128 &&
      /No package sources found/.test(r.stdout + r.stderr)
    )
      return [];
    const ok = r.success || (tool === 'osv' && r.exitCode === 1);
    if (!ok) throw new Error(`exit ${r.exitCode}: ${(r.stderr || r.stdout).slice(-400)}`);
    const json = parseJson(await readFile(resolve(out, 'report.json'), 'utf8').catch(() => ''));
    if (json === undefined) throw new Error(`no report: ${(r.stderr || r.stdout).slice(-400)}`);
    const rel = (p: string) => p.replace(new RegExp(`^${mount}/`), '');
    if (tool === 'semgrep') {
      const results = (json?.results ?? []) as {
        check_id: string;
        path: string;
        start?: { line?: number };
        end?: { line?: number };
        extra?: { message?: string; severity?: string };
      }[];
      const raws: Raw[] = [];
      for (const s of results) {
        const file = rel(s.path);
        const code = await snippet(resolve(dir, side, file), s.start?.line, s.end?.line);
        raws.push({
          key: `${s.check_id}|${file}|${code}`,
          finding: {
            tool,
            rule: s.check_id.split('.').slice(-1)[0],
            file,
            line: s.start?.line,
            message: (s.extra?.message ?? '').replace(/\s+/g, ' ').slice(0, 300),
            severity: s.extra?.severity,
          },
        });
      }
      return raws;
    }
    if (tool === 'gitleaks') {
      const results = (Array.isArray(json) ? json : []) as {
        RuleID: string;
        File: string;
        StartLine?: number;
        Description?: string;
        Fingerprint?: string;
        Match?: string;
      }[];
      return results.map((g) => {
        const file = rel(g.File);
        return {
          // The partially redacted match tells secrets apart; hashed here, never reported.
          key: `${g.RuleID}|${file}|${hash(g.Match ?? '')}`,
          finding: {
            tool,
            rule: g.RuleID,
            file,
            line: g.StartLine,
            message: g.Description ?? 'possível segredo',
          },
        };
      });
    }
    const raws: Raw[] = [];
    for (const res of (json?.results ?? []) as {
      source?: { path?: string };
      packages?: {
        package: { name: string; version?: string };
        vulnerabilities?: { id: string; summary?: string }[];
      }[];
    }[])
      for (const p of res.packages ?? [])
        for (const v of p.vulnerabilities ?? [])
          raws.push({
            key: `${v.id}|${p.package.name}`,
            finding: {
              tool,
              rule: v.id,
              file: rel(res.source?.path ?? ''),
              message: `${p.package.name}@${p.package.version ?? '?'}: ${(v.summary ?? '').slice(0, 200)}`,
            },
          });
    return raws;
  }
}
/** Findings of `now` whose key is not at the base (each base occurrence absorbs one). */
function newFindings(now: Raw[], base: Raw[]) {
  const seen = new Map<string, number>();
  for (const r of base) seen.set(r.key, (seen.get(r.key) ?? 0) + 1);
  const found: Finding[] = [];
  for (const r of now) {
    const left = seen.get(r.key) ?? 0;
    if (left > 0) seen.set(r.key, left - 1);
    else found.push(r.finding);
  }
  return found;
}
function parseJson(stdout: string): any {
  const start = stdout.search(/[[{]/);
  try {
    return start < 0 ? undefined : JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
/** The flagged lines, whitespace-normalised: the finding's identity across line shifts. */
async function snippet(path: string, start?: number, end?: number) {
  if (!start) return '';
  const lines = (await readFile(path, 'utf8').catch(() => '')).split('\n');
  return lines
    .slice(start - 1, Math.max(start, end ?? start))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}
/** Markdown summary for the PR body. */
export function checksSummary(
  result?: ChecksResult & { blocking?: boolean; reportOnly?: CheckTool[] },
) {
  if (!result) return 'Sem checagens de segurança configuradas.';
  const ran = Object.entries(result.tools)
    .map(([tool, t]) => `${tool}: ${t!.files} arquivo(s)`)
    .join(', ');
  const lines = [
    result.findings.length
      ? `Checagens de segurança: ${result.findings.length} achado(s) introduzido(s) pela mudança${result.blocking === false ? ' (não bloqueante)' : ''}.`
      : `Checagens de segurança: nenhum achado novo${ran ? ` (${ran})` : ' (nenhum arquivo analisável)'}.`,
    ...result.findings
      .slice(0, 20)
      .map(
        (f) =>
          `- \`${f.tool}\`${result.reportOnly?.includes(f.tool) ? ' (informativo)' : ''} ${f.rule} — \`${f.file}${f.line ? `:${f.line}` : ''}\` — ${f.message}`,
      ),
    ...result.errors.map((e) => `- ⚠️ não executou: ${e}`),
  ];
  return lines.join('\n');
}
