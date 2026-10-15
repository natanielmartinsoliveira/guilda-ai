import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { Tenant } from './tenants';
/**
 * First place where two loaded configurations differ, as a path ("tenants[0].hosts[1].token"),
 * or undefined when identical. Never the values: they may be secrets.
 */
export function compareTenants(a: Tenant[], b: Tenant[]): string | undefined {
  // Where a pack lives is not configuration: tenants.yaml never has it.
  const bare = (list: Tenant[]) => list.map(({ packDir: _, ...t }) => t);
  return diff(bare(a), bare(b), 'tenants');
}
/**
 * A copy where each PR template path is replaced by the file's content (relative paths from
 * baseDir, as tenants.yaml resolves them): moving a template into a pack is not a change.
 */
export function templatesByContent(list: Tenant[], baseDir: string): Tenant[] {
  const copy = structuredClone(list);
  for (const t of copy)
    for (const p of t.projects)
      if (p.pullRequest.template) {
        const path = isAbsolute(p.pullRequest.template)
          ? p.pullRequest.template
          : resolve(baseDir, p.pullRequest.template);
        let content: string;
        try {
          content = readFileSync(path, 'utf8');
        } catch {
          content = `(ilegível: ${path})`;
        }
        p.pullRequest.template = `conteúdo:${content}`;
      }
  return copy;
}
function diff(a: unknown, b: unknown, path: string): string | undefined {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return path;
    if (a.length !== b.length) return `${path} (tamanho ${a.length} ≠ ${b.length})`;
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return undefined;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      const d = diff(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}.${k}`,
      );
      if (d) return d;
    }
    return undefined;
  }
  return Object.is(a, b) ? undefined : path;
}
