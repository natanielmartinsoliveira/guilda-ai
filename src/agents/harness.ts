import { existsSync } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { TaskError } from '../config';
import { TenantHarness } from '../tenants/tenants';
export interface HarnessEntry {
  name: string;
  /** Real host path, always inside the harness root. */
  path: string;
}
/** A tenant harness resolved to concrete host paths for one run. */
export interface ResolvedHarness {
  skills: HarnessEntry[];
  agents: HarnessEntry[];
  instructions?: string;
}
const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/**
 * Reads the harness on every run so updates (git pull) apply immediately. Symlinks may not
 * escape the harness root; templates (names starting with "_") and READMEs are skipped.
 */
export async function resolveHarness(harness: TenantHarness): Promise<ResolvedHarness> {
  let root: string;
  try {
    root = await realpath(harness.path);
  } catch {
    throw new TaskError(`Harness not found: ${harness.path}`);
  }
  const inside = async (path: string) => {
    const real = await realpath(path);
    if (!real.startsWith(`${root}/`)) throw new TaskError(`Harness path escapes its root: ${path}`);
    return real;
  };
  const entries = async (dir: string) => {
    const full = join(root, dir);
    if (!existsSync(full)) throw new TaskError(`Harness folder not found: ${full}`);
    await inside(full);
    return (await readdir(full, { withFileTypes: true }))
      .filter((e) => safeName.test(e.name) && !e.name.startsWith('_'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({ entry: e, path: join(full, e.name) }));
  };
  const seen = new Set<string>();
  const unique = (kind: string, name: string) => {
    const key = `${kind}:${name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const skills: HarnessEntry[] = [];
  for (const dir of harness.skills)
    for (const { path } of await entries(dir)) {
      const name = basename(path);
      // A skill is a folder with SKILL.md; the first folder listed wins on name clashes.
      if (!existsSync(join(path, 'SKILL.md')) || !unique('skill', name)) continue;
      skills.push({ name, path: await inside(path) });
    }
  const agents: HarnessEntry[] = [];
  for (const dir of harness.agents)
    for (const { path } of await entries(dir)) {
      const file = path.endsWith('.md') ? path : join(path, 'AGENT.md');
      const name = basename(path).replace(/\.md$/, '');
      if (/^readme$/i.test(name) || !existsSync(file) || !unique('agent', name)) continue;
      agents.push({ name, path: await inside(file) });
    }
  const instructions = harness.instructions
    ? await inside(join(root, harness.instructions))
    : undefined;
  return { skills, agents, instructions };
}
