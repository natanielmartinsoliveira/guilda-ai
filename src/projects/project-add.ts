import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parse } from 'yaml';
import type { RepositoryInfo } from '../hosts/code-host';
import { loadPacks } from '../tenants/packs';
import type { Tenant, TenantHost, TenantProject } from '../tenants/tenants';
/** Where a repository lives, from the URL the developer copies (https, git@ or ssh://). */
export function parseRepoUrl(url: string): { hostname: string; repository: string } | undefined {
  const text = url.trim();
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(text);
  let hostname: string;
  let path: string;
  if (scp && !text.includes('://')) [, hostname, path] = scp;
  else {
    try {
      const u = new URL(text);
      if (!['https:', 'http:', 'ssh:'].includes(u.protocol)) return undefined;
      hostname = u.hostname;
      path = u.pathname;
    } catch {
      return undefined;
    }
  }
  const repository = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '')
    .replace(/\/-\/.*$/, '');
  return repository.includes('/') ? { hostname: hostname.toLowerCase(), repository } : undefined;
}
const hostnameOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};
/** The company's host the repository is on (GitLab by its URLs, GitHub/Bitbucket by domain). */
export function hostFor(hosts: TenantHost[], hostname: string) {
  return hosts.find((h) => {
    if (h.type === 'github') return hostname === 'github.com';
    if (h.type === 'bitbucket') return hostname === 'bitbucket.org';
    return hostnameOf(h.baseUrl) === hostname || hostnameOf(h.sshUrl) === hostname;
  });
}
/** A stack of the pack and the root files that suggest it (its `detect`). */
export function packStacks(packDir: string): { name: string; detect: string[] }[] {
  const dir = join(packDir, 'stacks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => {
      const body = parse(readFileSync(join(dir, f), 'utf8')) as { detect?: unknown } | null;
      const detect = Array.isArray(body?.detect) ? body.detect.map(String) : [];
      return { name: f.slice(0, -'.yaml'.length), detect };
    });
}
export interface ProjectPlan {
  id: string;
  hostId: string;
  repository: string;
  defaultBranch: string;
  reference?: string;
  /** The stack the project names (absent: the defaults' one, or none). */
  stack?: string;
  /** What the developer should look at before saving. */
  warnings: string[];
  /** The YAML lines added under projects:. */
  block: string;
}
const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
/**
 * The project block for a repository: its host, id, default branch, workspace reference and
 * stack, each taken from what the company already has (its hosts, its other projects, its
 * stacks) and from the repository itself (default branch and root files, when the host answers).
 */
export function planProject(input: {
  tenant: Tenant;
  company: Record<string, any>;
  stacks: { name: string; detect: string[] }[];
  url: string;
  info?: RepositoryInfo;
  id?: string;
  stack?: string;
}): ProjectPlan {
  const where = parseRepoUrl(input.url);
  if (!where) throw new Error(`not a repository URL: ${input.url}`);
  const host = hostFor(input.tenant.hosts, where.hostname);
  if (!host) throw new Error(`no host of ${input.tenant.id} serves ${where.hostname}`);
  const warnings: string[] = [];
  const id = input.id ?? slugify(basename(where.repository));
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new Error(`invalid project id "${id}"`);
  const projects: TenantProject[] = input.tenant.projects;
  if (projects.some((p) => p.id === id))
    throw new Error(`project "${id}" already exists: choose another with --id`);
  if (projects.some((p) => p.repository === where.repository))
    throw new Error(`${where.repository} is already a project`);
  const defaults = (input.company.projectDefaults ?? {}) as Record<string, any>;
  const defaultBranch =
    input.info?.defaultBranch ?? (defaults.defaultBranch as string | undefined) ?? 'main';
  if (!input.info) warnings.push(`host did not answer: default branch "${defaultBranch}" assumed`);
  // The workspace clone, where the other projects keep theirs (same folder, repository's name).
  let reference: string | undefined;
  const coder = projects.filter((p) => p.workspace.type === 'coder');
  if (coder.length || defaults.workspace?.type === 'coder') {
    const folders = new Set(
      coder.flatMap((p) =>
        p.workspace.type === 'coder' && p.workspace.reference
          ? [dirname(p.workspace.reference)]
          : [],
      ),
    );
    if (folders.size === 1)
      reference = `${[...folders][0]}/${basename(where.repository)}`.replace(/\/+/g, '/');
    else warnings.push('workspace.reference: no common folder among the projects, set it by hand');
  }
  // The stack: the one asked for, else the one whose files the repository has at its root.
  const defaultStack =
    typeof defaults.stack === 'string' ? defaults.stack : (defaults.stack?.name as string);
  let stack = input.stack;
  if (stack && !input.stacks.some((s) => s.name === stack))
    throw new Error(`stack "${stack}" is not in the pack (stacks/)`);
  if (!stack && input.info) {
    const files = new Set(input.info.files);
    const fits = input.stacks.filter((s) => s.detect.length && s.detect.every((f) => files.has(f)));
    const chosen = fits.find((s) => s.name === defaultStack) ?? fits[0];
    if (chosen) stack = chosen.name;
    else if (input.stacks.length)
      warnings.push(
        defaultStack
          ? `no stack of the pack fits its files, yet it gets the default stack "${defaultStack}": write prepare and test, or use --stack`
          : 'no stack of the pack fits its files: write prepare and test, or use --stack',
      );
  }
  if (stack === defaultStack) stack = undefined;
  const lines = [
    `  - id: ${id}`,
    `    repository: ${where.repository}`,
    ...(host.id !== defaults.host ? [`    host: ${host.id}`] : []),
    `    defaultBranch: ${defaultBranch}`,
    ...(reference ? [`    workspace: { reference: ${reference} }`] : []),
    ...(stack ? [`    stack: { name: ${stack} }`] : []),
  ];
  if (!defaults.host && host.id) warnings.push(`host ${host.id} written in the project`);
  return {
    id,
    hostId: host.id,
    repository: where.repository,
    defaultBranch,
    reference,
    stack,
    warnings,
    block: lines.join('\n'),
  };
}
/** company.yaml with the block at the end of projects: (comments and the rest kept as written). */
export function insertProject(text: string, block: string) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^projects:\s*$/.test(l));
  if (start < 0) throw new Error('company.yaml has no "projects:" list in block form');
  let end = lines.findIndex((l, i) => i > start && /^[A-Za-z_]/.test(l));
  if (end < 0) end = lines.length;
  // Before the blank lines and comments that open the next section.
  while (end - 1 > start && /^\s*(#.*)?$/.test(lines[end - 1])) end--;
  return [...lines.slice(0, end), ...block.split('\n'), ...lines.slice(end)].join('\n');
}
/**
 * The pack, as it would load with the new company.yaml: a copy is loaded, the pack is left as
 * it is. Returns the new project as the core sees it (defaults and stack applied).
 */
export function tryPack(packDir: string, text: string, id: string, env: NodeJS.ProcessEnv) {
  const copy = mkdtempSync(join(tmpdir(), 'project-add-'));
  try {
    cpSync(packDir, copy, { recursive: true, filter: (src) => basename(src) !== '.git' });
    writeFileSync(join(copy, 'company.yaml'), text);
    const { tenants } = loadPacks([copy], env);
    const project = tenants[0].projects.find((p) => p.id === id);
    if (!project) throw new Error(`project "${id}" did not load`);
    return project;
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}
