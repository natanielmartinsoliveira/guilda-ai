import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { language } from '../i18n';
const NAME = /^[a-z0-9][a-z0-9-]*\.md$/;
const PROJECT = /^[a-z0-9][a-z0-9-]{0,62}$/;
/**
 * Where a prompt comes from: the project's folder in the company pack, then the pack, then the
 * core's prompts/ (the first that exists). Names and project ids never leave those folders.
 */
export function promptPath(name: string, packDir?: string, projectId?: string) {
  if (!NAME.test(name)) throw new Error(`Invalid prompt name ${JSON.stringify(name)}`);
  if (projectId !== undefined && !PROJECT.test(projectId))
    throw new Error(`Invalid projeto ${JSON.stringify(projectId)} for prompts`);
  const candidates = packDir
    ? [
        ...(projectId ? [join(packDir, 'prompts', projectId, name)] : []),
        join(packDir, 'prompts', name),
      ]
    : [];
  // The core prompt in the instance language, then the pt-BR original. A company's prompts
  // stay in the language the company wrote them.
  const lang = language();
  if (lang !== 'pt-BR') candidates.push(resolve('prompts', lang, name));
  return candidates.find((p) => existsSync(p)) ?? resolve('prompts', name);
}
export type TemplateValues = Record<string, string | string[] | undefined>;
const empty = (v: string | string[]) => (Array.isArray(v) ? v.length === 0 : v === '');
/**
 * {{X}} filled (a list becomes "- item" lines); {{#X}}…{{/X}} kept only when X has something,
 * {{^X}}…{{/X}} only when it is empty. Unknown names and unclosed sections stay as written, and
 * the values put in are never read again (a card may contain "{{…}}").
 */
export function fillTemplate(text: string, values: TemplateValues) {
  const known = (key: string) => values[key] !== undefined;
  const sections = text.replace(
    /\{\{([#^])([A-Z_]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g,
    (match, kind: string, key: string, body: string) => {
      if (!known(key)) return match;
      const isEmpty = empty(values[key]!);
      return (kind === '#') !== isEmpty ? body : '';
    },
  );
  return sections.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => {
    const value = values[key];
    if (value === undefined) return match;
    return Array.isArray(value) ? value.map((item) => `- ${item}`).join('\n') : value;
  });
}
/** The prompt with its {{PLACEHOLDERS}} filled; unknown ones stay as they are. */
export async function renderPrompt(
  name: string,
  values: TemplateValues,
  packDir?: string,
  projectId?: string,
) {
  return fillTemplate(await readFile(promptPath(name, packDir, projectId), 'utf8'), values);
}
