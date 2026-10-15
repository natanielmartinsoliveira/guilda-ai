import { Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { realpath, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config, TaskError, workspace } from '../config';
import { ProcessRunnerService, RunOptions } from './process-runner.service';
import { ATTACHMENTS_MOUNT } from './agent.types';
export interface SandboxOptions extends RunOptions {
  taskId: string;
  tenantId: string;
  /** Credential id (slug) naming the CLI home under AGENT_HOME/<tenant>/. */
  credentialId?: string;
  /** The tenant's own key for the provider; never another tenant's or a global one. */
  apiKey?: string;
  /** Tenant attachments directory, mounted read-only at ATTACHMENTS_MOUNT. */
  attachmentsDir?: string;
  /** Extra read-only files/folders placed inside the ephemeral CLI home (tenant harness). */
  homeMounts?: { source: string; target: string }[];
  /** Environment variable receiving apiKey instead of the provider's default one. */
  apiKeyEnv?: string;
  /** Mounts the workspace read-only (reviewer, planner). */
  readOnly?: boolean;
}
const HOME = '/home/agent';
@Injectable()
export class SandboxService {
  constructor(private readonly runner: ProcessRunnerService) {}
  async run(
    bin: string,
    args: string[],
    opts: SandboxOptions,
    network = true,
    provider?: 'codex' | 'claude',
  ) {
    if (process.platform !== 'linux' || process.getuid?.() === 0)
      throw new TaskError('Worker requires Linux and a non-root user');
    if (!opts.taskId || (await realpath(opts.cwd)) !== workspace(opts.tenantId, opts.taskId))
      throw new TaskError('Workspace path is not isolated');
    // Per-tenant, per-credential auth directory: one company's CLI login is never visible to
    // another's tasks, and several subscriptions of the same provider can coexist.
    if (provider && !opts.credentialId) throw new TaskError('Agent runs require a credential');
    const home = resolve(config().AGENT_HOME, opts.tenantId, opts.credentialId ?? 'unused');
    await mkdir(home, { recursive: true, mode: 0o700 });
    // Only runtime directories are visible. Host home, app .env and other tasks are absent.
    const mounts = ['/usr', '/bin', '/lib', '/lib64']
      .filter(existsSync)
      .flatMap((path) => ['--ro-bind', path, path]);
    const env: NodeJS.ProcessEnv = {};
    if (opts.apiKey && opts.apiKeyEnv) {
      if (!/^[A-Z][A-Z0-9_]*_API_KEY$/.test(opts.apiKeyEnv))
        throw new TaskError('Invalid API key variable');
      env[opts.apiKeyEnv] = opts.apiKey;
    } else if (provider === 'codex' && opts.apiKey) env.OPENAI_API_KEY = opts.apiKey;
    else if (provider === 'claude' && opts.apiKey) env.ANTHROPIC_API_KEY = opts.apiKey;
    const flags = [
      '--die-with-parent',
      '--new-session',
      '--unshare-user',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--cap-drop',
      'ALL',
      ...(!network ? ['--unshare-net'] : []),
      ...mounts,
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--dir',
      '/home',
      '--tmpfs',
      '/home/agent',
      '--dir',
      '/etc',
    ];
    for (const path of ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/ssl/certs'])
      if (existsSync(path)) flags.push('--ro-bind', path, path);
    const authName = provider === 'codex' ? 'auth.json' : '.credentials.json';
    const authPath = resolve(home, authName);
    let stored: string | undefined, outbox: string | undefined;
    if (provider) {
      flags.push('--dir', '/credentials');
      if (existsSync(authPath)) flags.push('--ro-bind', authPath, `/credentials/${authName}`);
      // With an API key the CLI logs in from it; that login never replaces the stored one.
      if (existsSync(authPath) && !opts.apiKey) {
        stored = await readFile(authPath, 'utf8');
        // The CLI rotates the refresh token when it renews the login; the renewed file comes back
        // through this outbox, or the next run would start from a token that no longer exists.
        outbox = await mkdtemp(resolve(home, '.outbox-'));
        flags.push('--bind', outbox, '/credentials-out');
      }
    }
    const attachments: string[] = [];
    if (opts.attachmentsDir) {
      // Only this tenant's attachments may be exposed, never another company's.
      const root = resolve(config().ATTACHMENTS_ROOT, opts.tenantId);
      const real = await realpath(opts.attachmentsDir);
      if (!real.startsWith(`${await realpath(root)}/`))
        throw new TaskError('Attachments path is not isolated');
      attachments.push('--ro-bind', real, ATTACHMENTS_MOUNT);
    }
    for (const { source, target } of opts.homeMounts ?? []) {
      // Harness content only lands in the throwaway home, read-only, never over the workspace.
      if (!target.startsWith(`${HOME}/`) || target.split('/').includes('..'))
        throw new TaskError(`Harness mount outside the agent home: ${target}`);
      if (!existsSync(source)) throw new TaskError(`Harness file missing: ${source}`);
      attachments.push('--ro-bind', source, target);
    }
    flags.push(
      opts.readOnly ? '--ro-bind' : '--bind',
      opts.cwd,
      '/workspace',
      '--ro-bind',
      resolve(opts.cwd, '.git'),
      '/workspace/.git',
      ...attachments,
      '--chdir',
      '/workspace',
      '--setenv',
      'HOME',
      '/home/agent',
      '--setenv',
      'PATH',
      '/usr/local/bin:/usr/bin:/bin',
      '--setenv',
      'GIT_CONFIG_NOSYSTEM',
      '1',
      '--setenv',
      'GIT_CONFIG_GLOBAL',
      '/dev/null',
    );
    if (provider === 'codex') flags.push('--setenv', 'CODEX_HOME', '/home/agent/.codex');
    if (provider === 'claude') flags.push('--setenv', 'CLAUDE_CONFIG_DIR', '/home/agent/.claude');
    // Credentials are copied into an ephemeral writable home for CLI session/auth refresh.
    // Only this provider's auth file is visible; no personal settings or plugins are loaded.
    const bootstrap = `const fs=require('node:fs'),cp=require('node:child_process');
      const codex=process.env.CODEX_HOME,claude=process.env.CLAUDE_CONFIG_DIR;
      const dir=codex||claude;if(dir){fs.mkdirSync(dir,{recursive:true,mode:448});
        const name=codex?'auth.json':'.credentials.json';
        if(fs.existsSync('/credentials/'+name))fs.copyFileSync('/credentials/'+name,dir+'/'+name);}
      const bin=process.argv[1],args=process.argv.slice(2);
      if(codex&&process.env.OPENAI_API_KEY){const r=cp.spawnSync(bin,['login','--with-api-key'],{input:process.env.OPENAI_API_KEY,encoding:'utf8'});if(r.status!==0){process.stderr.write('Codex API-key login failed');process.exit(1);}}
      const r=cp.spawnSync(bin,args,{stdio:'inherit'});
      if(dir&&fs.existsSync('/credentials-out')){const name=codex?'auth.json':'.credentials.json';
        try{if(fs.existsSync(dir+'/'+name))fs.copyFileSync(dir+'/'+name,'/credentials-out/'+name);}catch{}}
      process.exit(r.status===null?1:r.status);`;
    try {
      return await this.runner.run(
        config().BWRAP_BIN,
        [...flags, '--', ...(provider ? ['node', '-e', bootstrap, bin, ...args] : [bin, ...args])],
        { ...opts, env, displayCommand: JSON.stringify(['sandbox', bin, ...args]) },
      );
    } finally {
      if (outbox) await saveRenewedLogin(resolve(outbox, authName), authPath, stored!, outbox);
    }
  }
}
const MAX_LOGIN_BYTES = 64 * 1024;
/** Keeps a login the CLI renewed inside the sandbox; anything that is not a JSON object is dropped. */
async function saveRenewedLogin(
  renewedPath: string,
  authPath: string,
  stored: string,
  outbox: string,
) {
  try {
    if (!existsSync(renewedPath)) return;
    const renewed = await readFile(renewedPath, 'utf8');
    if (renewed === stored || renewed.length > MAX_LOGIN_BYTES) return;
    const parsed: unknown = JSON.parse(renewed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const next = `${authPath}.next`;
    await writeFile(next, renewed, { mode: 0o600 });
    await rename(next, authPath);
  } catch {
    // An unreadable renewal keeps the previous login; the next run reports it if it fails.
  } finally {
    await rm(outbox, { recursive: true, force: true });
  }
}
