import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, normalize, resolve } from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { parse } from 'yaml';
import { z } from 'zod';
import { LANGUAGES, t } from '../i18n';
import { loadPacks, packDirs, packRequirements } from '../tenants/packs';

/** How the wizard talks to the person (the terminal, or an answers file in tests and scripts). */
export interface SetupIo {
  ask(
    key: string,
    question: string,
    opts?: { secret?: boolean; default?: string },
  ): Promise<string>;
  confirm(key: string, question: string): Promise<boolean>;
  say(line: string): void;
}
export interface SetupOptions {
  /** The instance folder (.env, .env.example). */
  root: string;
  /** Where packs given as git URLs are cloned (~/guilda-packs). */
  packsRoot: string;
  io: SetupIo;
  /** Runs a pack's baseline script (bash <script>, in the pack folder). */
  run?: (script: string, cwd: string) => void;
}
export interface SetupResult {
  ok: boolean;
  tenants: { id: string; projects: number; sources: string[] }[];
}
/** Answers given up front (npm run setup -- --answers file.json): key → answer. */
export function answersIo(answers: Record<string, string | boolean>, said: string[]): SetupIo {
  return {
    ask: async (key, _question, opts) => {
      const value = answers[key];
      return typeof value === 'string' ? value : (opts?.default ?? '');
    },
    confirm: async (key) => answers[key] === true,
    say: (line) => void said.push(line),
  };
}
const setupFile = z.object({
  scripts: z
    .array(z.object({ run: z.string().min(1), description: z.string().min(1) }))
    .default([]),
});
/**
 * A value as dotenv reads it back exactly: bare, or in quotes dotenv takes literally (single
 * quotes, backticks); double quotes only without backslashes (dotenv expands \n there).
 */
function quote(key: string, value: string) {
  if (/^[^\s#'"\\`$]*$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('`')) return `\`${value}\``;
  if (!/["\\]/.test(value)) return `"${value}"`;
  throw new Error(`${key}: this value cannot be written to .env as is (it mixes ' " \` and \\)`);
}
/**
 * The .env with these keys set: a key that is there gets its line replaced, a new one is
 * appended; every other line (values, comments) stays exactly as it was.
 */
export function setEnvValues(text: string, values: Record<string, string>) {
  const lines = text.length ? text.replace(/\n$/, '').split('\n') : [];
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) throw new Error(`${key}: a value cannot span lines`);
    const line = `${key}=${quote(key, value)}`;
    const at = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(l));
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
/** A URL as it can be shown: without user and password. */
function shown(url: string) {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url.replace(/\/\/[^@/]*@/, '//');
  }
}
/** A pack given as a folder is used where it is; a git URL is cloned into packsRoot. */
function pack(item: string, o: SetupOptions) {
  const local = resolve(item.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
  if (existsSync(local) && statSync(local).isDirectory()) return local;
  const name = basename(item.replace(/\/+$/, '')).replace(/\.git$/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    throw new Error(t('setup.badPackName', { url: item }));
  const dir = join(o.packsRoot, name);
  if (existsSync(dir)) o.io.say(t('setup.packExists', { dir }));
  else {
    const url = shown(item);
    o.io.say(t('setup.cloning', { url, dir }));
    try {
      execFileSync('git', ['clone', '--quiet', '--', item, dir], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (error) {
      // git's own message repeats the URL: only the shown form, never the credentials.
      let detail = String((error as { stderr?: Buffer }).stderr ?? '')
        .trim()
        .slice(-500)
        .split(item)
        .join(url);
      try {
        const { username, password } = new URL(item);
        for (const s of [password, username].filter(Boolean)) detail = detail.split(s).join('***');
      } catch {
        // not a URL: nothing embedded
      }
      throw new Error(t('setup.cloneFailed', { url, error: detail }));
    }
  }
  return dir;
}
/**
 * npm run setup: language, company packs, the values each pack requires (into .env, never
 * overwriting what is there), the packs' baseline scripts (only when confirmed), and a load test.
 * Idempotent: running it again asks only what is still missing.
 */
export async function runSetup(o: SetupOptions): Promise<SetupResult> {
  const envFile = join(o.root, '.env');
  if (!existsSync(envFile) && existsSync(join(o.root, '.env.example')))
    copyFileSync(join(o.root, '.env.example'), envFile);
  let text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  // The services read .env: a value counts only when it is there (not in this shell).
  const current = (): Record<string, string | undefined> => parseEnv(text);
  const save = (values: Record<string, string>) => {
    if (!Object.keys(values).length) return;
    text = setEnvValues(text, values);
    writeFileSync(envFile, text, { mode: 0o600 });
    chmodSync(envFile, 0o600); // also when the file already existed (or came from .env.example)
  };
  // 1. Language (asked in both, before there is one).
  const language = (
    await o.io.ask('language', 'Idioma / Language (pt-BR, en)', {
      default: parseEnv(text).GUILDA_LANG || 'pt-BR',
    })
  ).trim();
  if (!LANGUAGES.includes(language as never))
    throw new Error(t('setup.badLanguage', { value: language }));
  process.env.GUILDA_LANG = language;
  const changed: string[] = [];
  if (parseEnv(text).GUILDA_LANG !== language) {
    save({ GUILDA_LANG: language });
    changed.push('GUILDA_LANG');
  }
  // 2. Packs.
  const before = packDirs(parseEnv(text).GUILDA_PACKS);
  const given = (
    await o.io.ask('packs', t('setup.packs', { current: before.join(':') || t('setup.none') }))
  )
    .split(/\s+/)
    .filter(Boolean);
  const dirs = [...before];
  for (const item of given) {
    const dir = pack(item, o);
    if (!existsSync(join(dir, 'company.yaml'))) throw new Error(t('setup.notPack', { dir }));
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  if (dirs.join(':') !== before.join(':')) {
    save({ GUILDA_PACKS: dirs.join(':') });
    changed.push('GUILDA_PACKS');
  }
  // 3. The values each pack requires, asked only when missing.
  let kept = 0;
  for (const dir of dirs) {
    for (const r of packRequirements(dir)) {
      if (current()[r.name]) {
        kept++;
        continue;
      }
      const answer = (
        await o.io.ask(
          r.name,
          t('setup.value', {
            pack: basename(dir),
            name: r.name,
            description: r.description,
            example: r.example && !r.secret ? t('setup.example', { example: r.example }) : '',
          }),
          { secret: r.secret, default: r.default },
        )
      ).trim();
      if (!answer) {
        if (!r.default) o.io.say(t('setup.noValue', { name: r.name }));
        continue;
      }
      save({ [r.name]: answer });
      changed.push(r.name);
    }
  }
  if (kept) o.io.say(t('setup.kept', { count: kept }));
  if (changed.length) o.io.say(t('setup.saved', { names: changed.join(', ') }));
  // 4. Baseline scripts of the packs, each only after the person confirms it.
  for (const dir of dirs) {
    const file = join(dir, 'setup.yaml');
    if (!existsSync(file)) continue;
    const name = basename(dir);
    for (const s of setupFile.parse(parse(readFileSync(file, 'utf8')) ?? {}).scripts) {
      const rel = normalize(s.run);
      if (isAbsolute(rel) || rel.startsWith('..')) {
        o.io.say(t('setup.scriptOutside', { pack: name, run: s.run }));
        continue;
      }
      if (
        await o.io.confirm(
          `run:${name}/${rel}`,
          t('setup.script', { pack: name, description: s.description, run: rel }),
        )
      )
        (o.run ?? ((script, cwd) => execFileSync('bash', [script], { cwd, stdio: 'inherit' })))(
          join(dir, rel),
          dir,
        );
    }
  }
  // 5. Load test: what the instance will see.
  try {
    const { tenants } = loadPacks(dirs, current() as NodeJS.ProcessEnv);
    const summary = tenants.map((tn) => ({
      id: tn.id,
      projects: tn.projects.length,
      sources: tn.sources.map((s) => s.id),
    }));
    for (const s of summary)
      o.io.say(
        t('setup.loaded', { id: s.id, projects: s.projects, sources: s.sources.join(', ') || '-' }),
      );
    o.io.say(t('setup.next'));
    return { ok: true, tenants: summary };
  } catch (error) {
    o.io.say(
      t('setup.loadFailed', { error: error instanceof Error ? error.message : String(error) }),
    );
    return { ok: false, tenants: [] };
  }
}
