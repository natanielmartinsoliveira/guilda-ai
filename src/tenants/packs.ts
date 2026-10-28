import { t } from '../i18n';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { parseTenantsData, Tenant, withProjectDefaults } from './tenants';
// Deliberately independent from config.ts (like tenants.ts): redact() depends on this module.
/** What each dev provides to use a company pack (requires.yaml). */
const requirement = z.object({
  name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'UPPER_CASE variable name'),
  description: z.string().min(1),
  secret: z.boolean().default(false),
  example: z.string().optional(),
  default: z.string().optional(),
});
export type PackRequirement = z.infer<typeof requirement>;
const VARIABLE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
/** GUILDA_PACKS: absolute pack folders separated by ":". */
export function packDirs(value: string | undefined) {
  return (value ?? '')
    .split(':')
    .map((d) => d.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}
function variables(value: unknown, found = new Set<string>()) {
  if (typeof value === 'string') for (const m of value.matchAll(VARIABLE)) found.add(m[1]);
  else if (Array.isArray(value)) value.forEach((v) => variables(v, found));
  else if (value && typeof value === 'object')
    Object.values(value).forEach((v) => variables(v, found));
  return found;
}
function readYaml(path: string) {
  try {
    return parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `pacote: não consegui ler ${path}: ${error instanceof Error ? error.message : error}`,
    );
  }
}
/** What a pack asks of each dev (its requires.yaml; none when the file does not exist). */
export function packRequirements(dir: string): PackRequirement[] {
  const requiresFile = join(dir, 'requires.yaml');
  const parsed = z
    .array(requirement)
    .safeParse(existsSync(requiresFile) ? (readYaml(requiresFile) ?? []) : []);
  if (!parsed.success)
    throw new Error(
      `pacote ${dir}: requires.yaml inválido\n${parsed.error.issues
        .map((i) => `- ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  return parsed.data;
}
/** Relative paths of a pack's company point inside the pack. */
function inside(dir: string, path: unknown) {
  return typeof path === 'string' && path && !isAbsolute(path) && !path.includes('${')
    ? resolve(dir, path)
    : path;
}
/**
 * The companies of the packs (company.yaml each), with the values each dev provides
 * (requires.yaml, filled from the environment / .env): validated exactly like tenants.yaml.
 */
export function loadPacks(
  dirs: string[],
  env: NodeJS.ProcessEnv = process.env,
): { tenants: Tenant[]; secrets: string[] } {
  // Each pack keeps its own values: a default of one pack never fills another's variable.
  const companies: { dir: string; company: Record<string, any>; values: Record<string, string> }[] =
    [];
  const secrets: string[] = [];
  const missing: string[] = [];
  for (const dir of dirs) {
    const requirements = packRequirements(dir);
    const company = readYaml(join(dir, 'company.yaml'));
    if (!company || typeof company !== 'object' || Array.isArray(company))
      throw new Error(`pacote ${dir}: company.yaml precisa descrever uma empresa`);
    // Before the paths below are resolved: a default template is each project's too.
    const c = withProjectDefaults(company) as Record<string, any>;
    const declared = new Map(requirements.map((r) => [r.name, r]));
    const values: Record<string, string> = {};
    const undeclared = [...variables(c)].filter((name) => !declared.has(name));
    if (undeclared.length)
      throw new Error(
        `pacote ${dir}: ${undeclared.map((n) => `\${${n}}`).join(', ')} não declarada no requires.yaml`,
      );
    for (const r of declared.values()) {
      const value = env[r.name] || r.default || undefined;
      if (!value) {
        missing.push(
          `- ${dir}: ${r.name} — ${r.description}${r.example ? ` (ex.: ${r.example})` : ''}`,
        );
        continue;
      }
      values[r.name] = value;
      if (r.secret) secrets.push(value);
    }
    if (c.harness) c.harness = { ...c.harness, path: inside(dir, c.harness.path) };
    for (const p of Array.isArray(c.projects) ? c.projects : [])
      if (p?.pullRequest?.template)
        p.pullRequest = { ...p.pullRequest, template: inside(dir, p.pullRequest.template) };
    c.packDir = resolve(dir);
    companies.push({ dir, company: c, values });
  }
  if (missing.length) throw new Error(`${t('packs.missing')}\n${missing.join('\n')}`);
  const tenants: Tenant[] = [];
  const owner = new Map<string, string>();
  for (const { dir, company, values } of companies) {
    let parsed: Tenant[];
    try {
      parsed = parseTenantsData({ tenants: [company] }, values);
    } catch (error) {
      throw new Error(`pacote ${dir}: ${error instanceof Error ? error.message : error}`);
    }
    // Compared after interpolation: an id that comes from a variable counts too.
    for (const t of parsed) {
      if (owner.has(t.id))
        throw new Error(`empresa "${t.id}" está em mais de um pacote: ${owner.get(t.id)} e ${dir}`);
      owner.set(t.id, dir);
      tenants.push(t);
    }
  }
  return { tenants, secrets };
}
