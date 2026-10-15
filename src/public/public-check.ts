import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';

/**
 * Before the repository goes public: nothing of the operator's companies may be in it. The terms
 * are never written in the core; they come from the operator's own configuration.
 */
export interface TermSources {
  /** Pack folders (GUILDA_PACKS): their folder name and company.yaml. */
  packDirs: string[];
  /** Other company files with the same shape (tenants.yaml). */
  yamlFiles: string[];
  /** The .env values (only the keys that name people, places and workspaces; never secrets). */
  env: Record<string, string>;
  /** Extra terms, one per line (.public-deny, never versioned). */
  deny: string[];
}
export interface Finding {
  file: string;
  line: number;
  term: string;
}
/** Words, folders and hosts every installation has: never terms. */
const COMMON = new Set([
  'home',
  'work',
  'workspace',
  'workspaces',
  'root',
  'tmp',
  'users',
  'user',
  'local',
  'share',
  'src',
  'opt',
  'usr',
  'var',
  'etc',
  'bin',
  'node',
  'npm',
  'front',
  'frontend',
  'backend',
  'back',
  'api',
  'web',
  'app',
  'apps',
  'core',
  'admin',
  'mobile',
  'main',
  'master',
  'homolog',
  'develop',
  'dev',
  'beta',
  'production',
  'development',
  'test',
  'tests',
  'team',
  'bot',
  'guilda',
  'guilda-packs',
  'packs',
  'ai-dev-team',
  'service',
  'services',
  'claude',
  'codex',
  'gemini',
  'openrouter',
  'github',
  'gitlab',
  'bitbucket',
  'jira',
  'coder',
  'docker',
  'postgres',
  'guest',
  'localhost',
  'true',
  'false',
  'businessmap',
  'attachments',
  'dist',
  'data',
  'logs',
  'tenants.yaml',
  'ai_dev_team',
]);
const COMMON_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  'github.com',
  'api.github.com',
  'gitlab.com',
  'bitbucket.org',
  'api.bitbucket.org',
  'openrouter.ai',
  'api.openai.com',
  'api.anthropic.com',
  'figma.com',
  'www.figma.com',
  'api.figma.com',
  'api.telegram.org',
]);
/** .env keys that name people, places and workspaces; any key that looks like a secret is out. */
const ENV_KEY = /(NAME|EMAIL|USER|WORKSPACE|DOMAIN|URL|ROOT|HOME|PACKS|_PATH|_FILE|_ID)$/;
const SECRET_KEY = /TOKEN|SECRET|PASSWORD|PASS|KEY|HASH|CREDENTIAL/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Domains of platforms companies have accounts on: the company's own host there is the term. */
const PLATFORMS = new Set([
  'atlassian.net',
  'kanbanize.com',
  'ngrok-free.dev',
  'ngrok-free.app',
  'ngrok.io',
  'ngrok.app',
  'github.com',
  'githubusercontent.com',
  'gitlab.com',
  'bitbucket.org',
  'example.com',
  'coder.com',
  'figma.com',
  'openai.com',
  'anthropic.com',
  'openrouter.ai',
  'telegram.org',
]);
/** Text files are read even with a NUL byte in them (a test may hold one). */
const TEXT = /\.(ts|tsx|js|cjs|mjs|json|ya?ml|md|txt|sh|py|html|css|env|example|sql)$/i;

export function forbiddenTerms(sources: TermSources): string[] {
  const terms = new Set<string>();
  const add = (value: string) => {
    const t = value.trim().toLowerCase();
    if (
      t.length >= 3 &&
      !COMMON.has(t) &&
      !COMMON_HOSTS.has(t) &&
      !t.endsWith('example.com') &&
      /^[a-z0-9]/.test(t) &&
      // versions and small numbers are everywhere; an id of 6+ digits is not
      !/^v\d+(\.\d+)*$|^\d+(\.\d+)+$|^\d{1,5}$/.test(t) &&
      !t.includes('${')
    )
      terms.add(t);
  };
  const host = (value: string) => {
    let name: string;
    try {
      // Template parts of a URL ("https://{key}.dev.x.com") are not part of the host.
      name = new URL(value.trim().replace(/\{[^}]*\}\.?/g, '')).hostname.toLowerCase();
    } catch {
      return; // not a URL
    }
    add(name);
    // The company's bare domain too (two labels; three for "com.br"-style suffixes).
    const labels = name.split('.');
    const n =
      labels.length >= 3 &&
      /^(com|net|org|gov|edu|co)$/.test(labels[labels.length - 2]) &&
      labels[labels.length - 1].length === 2
        ? 3
        : 2;
    const domain = labels.slice(-n).join('.');
    if (labels.length > n && !PLATFORMS.has(domain)) add(domain);
  };
  const person = (value: string) => {
    const name = value.replace(/\([^)]*\)/g, ' ').trim();
    add(name);
    for (const word of name.split(/\s+/)) add(word);
  };
  const segments = (value: string) => {
    for (const part of value.split(/[/:,\\]+/)) add(part);
  };
  const walk = (node: unknown, key: string, top: boolean) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key, key === 'tenants' || key === 'projects');
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === 'id' && typeof v === 'string') {
          if (top) add(v);
        } else walk(v, k, false);
      }
      return;
    }
    if (typeof node !== 'string') return;
    if (EMAIL.test(node.trim())) return add(node);
    if (/^[a-z+]+:\/\//i.test(node.trim())) return host(node);
    if (key === 'name') add(node);
    else if (key === 'authorName') person(node);
    else if (key === 'reviewers' || key === 'allowedUsers') add(node);
    else if (key === 'repository') {
      add(node);
      segments(node);
    } else if (key === 'reference') add(node.split('/').filter(Boolean).pop() ?? '');
  };
  // An error never carries the file's text or path (both may hold the terms themselves).
  const company = (file: string, label: string) => {
    if (!existsSync(file)) return;
    let doc: unknown;
    try {
      doc = parse(readFileSync(file, 'utf8'));
    } catch (error) {
      const line = (error as { linePos?: { line: number }[] }).linePos?.[0]?.line;
      throw new Error(`public:check: could not read ${label}${line ? ` (line ${line})` : ''}`);
    }
    walk(doc, '', true);
  };
  sources.packDirs.forEach((dir, i) => {
    add(basename(dir));
    company(join(dir, 'company.yaml'), `company.yaml of pack #${i + 1} in GUILDA_PACKS`);
  });
  for (const file of sources.yamlFiles) company(file, basename(file));
  for (const [key, value] of Object.entries(sources.env)) {
    if (!ENV_KEY.test(key) || SECRET_KEY.test(key) || !value.trim()) continue;
    if (EMAIL.test(value.trim())) add(value);
    else if (/^[a-z+]+:\/\//i.test(value.trim())) host(value);
    else if (/[/:,\\]/.test(value)) segments(value);
    else if (/NAME$/.test(key)) person(value);
    else add(value);
  }
  for (const line of sources.deny) if (!line.trim().startsWith('#')) add(line);
  return [...terms].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The files that would be published: versioned plus new ones git does not ignore. */
export function scanTree(root: string, terms: string[]): Finding[] {
  const ordered = [...terms].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const matchers = ordered.map((term) => {
    // A short term counts only as a whole word ("acme" is not in "acmeville").
    const word = new RegExp(`(^|[^a-z0-9])${escape(term)}([^a-z0-9]|$)`);
    return term.length < 5 ? (l: string) => word.test(l) : (l: string) => l.includes(term);
  });
  const files = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .sort();
  const found: Finding[] = [];
  for (const file of [...new Set(files)]) {
    // The file's own name and folders count too.
    const name = file.toLowerCase();
    ordered.forEach((term, j) => {
      if (matchers[j](name)) found.push({ file, line: 0, term });
    });
    const path = join(root, file);
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size > 5_000_000) continue;
    const bytes = readFileSync(path);
    if (bytes.subarray(0, 8000).includes(0) && !TEXT.test(file)) continue;
    bytes
      .toString('utf8')
      .split('\n')
      .forEach((text, i) => {
        const line = text.toLowerCase();
        ordered.forEach((term, j) => {
          if (matchers[j](line)) found.push({ file, line: i + 1, term });
        });
      });
  }
  return found;
}
/** A finding as printed: file, line and the first letters only (the term itself never). */
export function formatFinding(f: Finding) {
  return `${f.file}:${f.line}  ${f.term.slice(0, 2)}… (${f.term.length} letras)`;
}
