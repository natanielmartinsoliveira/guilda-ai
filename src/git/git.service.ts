import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ProcessRunnerService } from '../agents/process-runner.service';
import { TaskError, workspace } from '../config';
import { Task } from '../database/entities';
import { isSafeBranch } from '../tasks/branch';
import { CoderWorkspace } from '../workspaces/coder-workspace';
import { TaskWorkspaces } from '../workspaces/task-workspaces.service';
export interface GitRemote {
  url: string;
  /** Full HTTP header, e.g. "Authorization: Basic ...". Passed through env, never persisted. */
  authHeader: string;
  /** GIT_SSH_COMMAND for ssh remotes (the host decides: its key, never a prompt). */
  sshCommand?: string;
}
export interface GitAuthor {
  name: string;
  email: string;
}
export interface GitOptions {
  remote?: GitRemote;
  author?: GitAuthor;
  /** task (default): the task folder; root: its parent (clone, ls-remote). */
  at?: 'task' | 'root';
  /** Default: 3 minutes. */
  timeoutMs?: number;
  /** Default: MAX_OUTPUT_BYTES. */
  maxOutputBytes?: number;
}
/** Listing every tracked file of a big repository (tens of thousands of paths). */
const LISTING_BYTES = 64 * 1024 * 1024;
/** A first clone of a big repository (tens of thousands of files) needs far more than 3 minutes. */
const CLONE_TIMEOUT_MS = 15 * 60 * 1000;
/** Real env files anywhere; templates (.env.example, .sample, .template, .dist) are fine. */
const ENV_FILE = /(^|\/)\.env(\.(?!(example|sample|template|dist|defaults)$)[^/]+)?$/i;
/** Credential stores by name: private SSH keys, keystores, credential data files. */
const SECRET_NAME =
  /(^|\/)(id_(rsa|dsa|ecdsa|ed25519)|[^/]+\.(p12|pfx|jks|keystore)|\.?credentials\.(json|ya?ml|xml|csv|ini|toml))$/i;
/** PEM-like files are judged by content: certificates are public, private keys are not. */
const PEM_FILE = /\.(pem|key|crt|cer)$/i;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
/**
 * Tracked files that look like secrets. Refusing them keeps credentials committed by mistake
 * away from the AI; judging PEM files by content avoids refusing repositories that only ship
 * public CA certificates (e.g. certifi bundles).
 */
export async function findCredentialFiles(
  /** A folder on this machine, or a reader (a remote workspace). */
  root: string | ((file: string) => Promise<string | undefined>),
  files: string[],
) {
  const read =
    typeof root === 'string'
      ? (file: string) => readFile(resolve(root, file), 'latin1').catch(() => undefined)
      : root;
  const found: string[] = [];
  for (const file of files) {
    if (ENV_FILE.test(file) || SECRET_NAME.test(file)) found.push(file);
    else if (PEM_FILE.test(file)) {
      const content = (await read(file)) ?? '';
      if (PRIVATE_KEY.test(content.slice(0, 1024 * 1024))) found.push(file);
    }
  }
  return found;
}
@Injectable()
export class GitService {
  constructor(
    private readonly runner: ProcessRunnerService,
    private readonly workspaces: TaskWorkspaces = new TaskWorkspaces(runner),
  ) {}
  private env({ remote, author }: GitOptions): Record<string, string> {
    const env: Record<string, string> = {
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
    if (author)
      Object.assign(env, {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
      });
    if (remote?.sshCommand) env.GIT_SSH_COMMAND = remote.sshCommand;
    // ssh remotes (a Coder workspace's own key) carry no HTTP header.
    if (remote?.authHeader)
      Object.assign(env, {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `http.${new URL(remote.url).origin}/.extraheader`,
        GIT_CONFIG_VALUE_0: remote.authHeader,
      });
    return env;
  }
  async git(task: Task, args: string[], opts: GitOptions = {}) {
    const r = await this.workspaces
      .of(task)
      .run(
        [
          'git',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'credential.helper=',
          '-c',
          'protocol.file.allow=never',
          ...args,
        ],
        {
          at: opts.at ?? 'task',
          taskId: task.id,
          agent: 'git',
          timeoutMs: opts.timeoutMs ?? 180000,
          maxOutputBytes: opts.maxOutputBytes,
          env: this.env(opts),
        },
      );
    // Only network operations are worth retrying, and not when the server refused the push
    // (email privacy, branch protection, moved branch): that answer will not change.
    const refused = /remote rejected|\[rejected\]|push declined|non-fast-forward|GH\d{3}:/i.test(
      r.stderr,
    );
    if (!r.success)
      throw new TaskError(`Git ${args[0]} failed: ${r.stderr}`, !!opts.remote && !refused);
    return r.stdout.trim();
  }
  /**
   * Ensures the task workspace exists on the task branch. With resetToBase, an existing
   * workspace (a retried task, or a crash before the base was recorded) is moved back to the
   * current tip of the base branch, discarding earlier attempts.
   */
  async prepare(
    task: Task,
    base: string,
    remote: GitRemote,
    opts: { resetToBase?: boolean; newBranch?: boolean; hidden?: string[] } = {},
  ) {
    if (task.workspace !== workspace(task.tenantId, task.id) || !isSafeBranch(task.branch))
      throw new TaskError('Unsafe workspace or branch');
    const ws = this.workspaces.of(task);
    await ws.ensureRoot();
    await this.git(task, ['check-ref-format', '--branch', base], { at: 'root' });
    const state = await ws.state();
    if (state === 'unsafe') throw new TaskError('Unsafe workspace');
    const exists = state === 'directory';
    // A first run (no workspace yet) must create its branch: one that already exists remotely
    // belongs to someone else (e.g. created by hand) and is never taken over. Retries reuse
    // the workspace, and the branch they pushed earlier is theirs.
    if (opts.newBranch && !exists && (await this.remoteBranchExists(task, remote, task.branch)))
      throw new TaskError(
        `Branch ${task.branch} already exists in the repository (created outside the AI Dev Team?); remove it or finish that work by hand`,
      );
    // Only this job uses its workspace (per-task session lock): a lock file is a killed git's.
    if (exists) await ws.remove('.git/index.lock');
    if (!exists) {
      // Cloned aside and moved in when complete: an interrupted clone (timeout, crash) never
      // leaves a half workspace behind for the next attempt.
      const partial = `${task.id}.partial`;
      await ws.removeEntry(partial);
      // In a Coder workspace, the operator's clone lends its objects (read only, dissociated).
      const reference = ws instanceof CoderWorkspace ? ws.cfg.reference : undefined;
      try {
        await this.git(
          task,
          [
            'clone',
            '--no-local',
            '--single-branch',
            '--branch',
            base,
            ...(reference ? ['--reference', reference, '--dissociate'] : []),
            '--',
            remote.url,
            partial,
          ],
          { remote, at: 'root', timeoutMs: CLONE_TIMEOUT_MS },
        );
      } catch (error) {
        await ws.removeEntry(partial);
        throw error;
      }
      await ws.renameEntry(partial, task.id);
      await this.git(task, ['checkout', '-b', task.branch]);
    } else if (opts.resetToBase) {
      await this.git(task, ['fetch', '--no-tags', remote.url, `refs/heads/${base}`], { remote });
      await this.git(task, ['reset', '--hard']);
      await this.git(task, ['checkout', '-B', task.branch, 'FETCH_HEAD']);
      await this.git(task, ['clean', '-fd']);
    }
    await this.assertBranch(task);
    await this.hide(task, opts.hidden ?? []);
    await this.assertNoCredentials(task);
  }
  /**
   * Keeps tracked files out of the work tree (sparse checkout): agents never read them, resets
   * do not bring them back, and commits do not delete them.
   */
  async hide(task: Task, patterns: string[]) {
    if (!patterns.length) return;
    await this.git(task, [
      'sparse-checkout',
      'set',
      '--no-cone',
      '/*',
      ...patterns.map((p) => `!/${p}`),
    ]);
  }
  /** Agents never get a work tree holding credentials (hidden files are not in it). */
  async assertNoCredentials(task: Task) {
    // -t tags each entry; S = skip-worktree (hidden by the sparse checkout).
    const listing = await this.git(task, ['ls-files', '-t', '-z'], {
      maxOutputBytes: LISTING_BYTES,
    });
    const visible = listing
      .split('\0')
      .filter((entry) => entry && !entry.startsWith('S '))
      .map((entry) => entry.slice(2));
    const ws = this.workspaces.of(task);
    const found = await findCredentialFiles((file) => ws.readText(file, 1024 * 1024), visible);
    if (found.length)
      throw new TaskError(`Repository contains a protected credential file: ${found.join(', ')}`);
  }
  async remoteBranchExists(task: Task, remote: GitRemote, branch: string) {
    if (!isSafeBranch(branch)) throw new TaskError(`Unsafe branch name: ${branch}`);
    await this.workspaces.of(task).ensureRoot();
    const out = await this.git(task, ['ls-remote', '--heads', remote.url, `refs/heads/${branch}`], {
      remote,
      at: 'root',
    });
    return out.length > 0;
  }
  /**
   * Creates a branch on the remote at `sha` if it does not exist yet (e.g. a story branch from
   * the default branch tip). Never moves an existing branch.
   */
  async ensureRemoteBranch(task: Task, remote: GitRemote, branch: string, sha: string) {
    if (!isSafeBranch(branch)) throw new TaskError(`Unsafe branch name: ${branch}`);
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new TaskError('Invalid commit SHA');
    if (await this.remoteBranchExists(task, remote, branch)) return false;
    await this.git(task, ['push', remote.url, `${sha}:refs/heads/${branch}`], { remote });
    return true;
  }
  async assertBranch(task: Task) {
    // The name is generated from the project pattern; it must still be a safe, unprotected ref.
    if (!isSafeBranch(task.branch)) throw new TaskError('Protected branch');
    if ((await this.git(task, ['branch', '--show-current'])) !== task.branch)
      throw new TaskError('Workspace branch changed');
  }
  async validateChanges(task: Task) {
    await this.assertBranch(task);
    const tracked = await this.git(task, ['diff', '--name-only', '-z', 'HEAD']);
    const untracked = await this.git(task, ['ls-files', '--others', '--exclude-standard', '-z']);
    const files = [...tracked.split('\0'), ...untracked.split('\0')].filter(Boolean);
    if (!files.length) throw new TaskError('NO_CHANGES: agent produced no changes');
    for (const file of files) {
      if (
        /(^|\/)(\.env(?:\..*)?|id_rsa|id_ed25519|credentials[^/]*|[^/]*\.pem)$/.test(file) ||
        /^(\.github\/workflows|\.gitmodules|\.codex|\.claude)(\/|$)/.test(file)
      )
        throw new TaskError(`Protected file modified: ${file}`);
      if (await this.workspaces.of(task).isSymlink(file))
        throw new TaskError(`Symlink change refused: ${file}`);
    }
    const diff = await this.git(task, ['diff', '--stat', 'HEAD']);
    return { files, diff };
  }
  /** What a reviewer reads: the diff of tracked files since `since`, plus the new files by name. */
  async diff(task: Task, since = 'HEAD') {
    await this.assertBranch(task);
    if (since !== 'HEAD' && !/^[a-f0-9]{40,64}$/.test(since))
      throw new TaskError('Invalid commit SHA');
    const text = await this.git(task, ['diff', '--no-color', '--no-ext-diff', since]);
    const { untracked } = await this.changedPaths(task);
    return { text, untracked };
  }
  /** Files that differ from `sha` in the working tree (committed or not), new files included. */
  async changedSince(task: Task, sha: string) {
    await this.assertBranch(task);
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new TaskError('Invalid commit SHA');
    const tracked = await this.git(task, ['diff', '--name-only', '-z', '--no-renames', sha]);
    const untracked = await this.git(task, ['ls-files', '--others', '--exclude-standard', '-z']);
    return [...new Set([...tracked.split('\0'), ...untracked.split('\0')].filter(Boolean))];
  }
  /** A file as it was at `sha`; undefined when it did not exist (or is not a regular file). */
  async fileAt(task: Task, sha: string, path: string): Promise<Buffer | undefined> {
    if (!/^[a-f0-9]{40,64}$/.test(sha) || path.startsWith('-') || path.includes('\0'))
      throw new TaskError('Invalid revision or path');
    // Only the security checks read files at a commit, and they are local-only.
    if (this.workspaces.of(task).kind !== 'local')
      throw new TaskError('fileAt is local only (checks do not run in coder workspaces)');
    // Not through the process runner: it masks token-shaped text in output (right for logs),
    // which here would hide a secret already present at the base and make it look new.
    // The content is only compared, never logged or stored.
    return new Promise((done) =>
      execFile(
        'git',
        ['-c', 'core.hooksPath=/dev/null', 'cat-file', 'blob', `${sha}:${path}`],
        {
          cwd: task.workspace,
          env: { ...process.env, ...this.env({}) },
          encoding: 'buffer',
          maxBuffer: 8 * 1024 * 1024,
          timeout: 60000,
        },
        (error, stdout) => done(error ? undefined : stdout),
      ),
    );
  }
  /** Changed paths relative to HEAD: tracked (modified/deleted) and new untracked files. */
  async changedPaths(task: Task) {
    const tracked = await this.git(task, ['diff', '--name-only', '-z', 'HEAD']);
    const untracked = await this.git(task, ['ls-files', '--others', '--exclude-standard', '-z']);
    return {
      tracked: tracked.split('\0').filter(Boolean),
      untracked: untracked.split('\0').filter(Boolean),
    };
  }
  /**
   * Undoes what a test run changed on top of `before` (e.g. a test deleting a fixture), so
   * test side effects never end up in the commit. The agent's own changes are untouched.
   */
  async revertSideEffects(task: Task, before: { tracked: string[]; untracked: string[] }) {
    await this.assertBranch(task);
    const after = await this.changedPaths(task);
    const tracked = after.tracked.filter((f) => !before.tracked.includes(f));
    const untracked = after.untracked.filter((f) => !before.untracked.includes(f));
    if (tracked.length) await this.git(task, ['checkout', 'HEAD', '--', ...tracked]);
    if (untracked.length) await this.git(task, ['clean', '-f', '--', ...untracked]);
    return [...tracked, ...untracked];
  }
  /** Discards an interrupted agent's partial work; ignored files (dependencies) are kept. */
  async resetTo(task: Task, sha: string) {
    await this.assertBranch(task);
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new TaskError('Invalid commit SHA');
    await this.git(task, ['reset', '--hard', sha]);
    await this.git(task, ['clean', '-fd']);
  }
  /** Current head of the task's remote branch (the PR), including commits pushed by people. */
  async fetchBranch(task: Task, remote: GitRemote) {
    await this.assertBranch(task);
    await this.git(task, ['fetch', '--no-tags', remote.url, `refs/heads/${task.branch}`], {
      remote,
    });
    return this.git(task, ['rev-parse', 'FETCH_HEAD']);
  }
  async commit(task: Task, message: string, author: GitAuthor) {
    await this.assertBranch(task);
    await this.git(task, ['add', '--all']);
    await this.git(task, ['diff', '--cached', '--check']);
    await this.git(task, ['commit', '-m', message], { author });
    return this.git(task, ['rev-parse', 'HEAD']);
  }
  /** Commits exactly these paths (pathspec), nothing else that may be pending. */
  async commitPaths(task: Task, paths: string[], message: string, author: GitAuthor) {
    await this.assertBranch(task);
    if (!paths.length || paths.some((p) => !p || p.startsWith('-') || p.includes('\0')))
      throw new TaskError('Invalid pathspec');
    await this.git(task, ['add', '--', ...paths]);
    await this.git(task, ['commit', '-m', message, '--', ...paths], { author });
    return this.git(task, ['rev-parse', 'HEAD']);
  }
  async push(task: Task, sha: string, remote: GitRemote) {
    await this.assertBranch(task);
    // Explicit immutable commit and destination; no force and no agent-controlled remote.
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new TaskError('Invalid commit SHA');
    await this.git(task, ['push', remote.url, `${sha}:refs/heads/${task.branch}`], { remote });
  }
}
