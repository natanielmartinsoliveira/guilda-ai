import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parse } from 'yaml';
import { t } from '../i18n';
import { loadPacks } from '../tenants/packs';
import { createHost } from '../tenants/tenant-registry.service';
import {
  hostFor,
  insertProject,
  packStacks,
  parseRepoUrl,
  planProject,
  tryPack,
} from './project-add';
/**
 * npm run project:add -- <pack folder> <repository URL> [--id <id>] [--stack <stack>] [--yes]
 * Writes a short project block into the pack's company.yaml (host, default branch, workspace
 * reference and stack found for it), after checking that the pack still loads with it.
 */
const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [packArg, url] = positional;
async function main() {
  if (!packArg || !url) throw new Error(t('project.usage'));
  const packDir = resolve(packArg);
  const file = join(packDir, 'company.yaml');
  const text = readFileSync(file, 'utf8');
  const [tenant] = loadPacks([packDir]).tenants;
  const where = parseRepoUrl(url);
  const host = where && hostFor(tenant.hosts, where.hostname);
  const info = host
    ? await createHost(host)
        .repositoryInfo?.(where!.repository)
        .catch((error: unknown) => {
          console.log(t('project.hostFailed', { error: String(error).slice(0, 200) }));
          return undefined;
        })
    : undefined;
  const plan = planProject({
    tenant,
    company: parse(text) as Record<string, any>,
    stacks: packStacks(packDir),
    url,
    info,
    id: flag('--id'),
    stack: flag('--stack'),
  });
  const next = insertProject(text, plan.block);
  const loaded = tryPack(packDir, next, plan.id, process.env);
  console.log(`\n${plan.block}\n`);
  console.log(t('project.loaded', { prepare: loaded.prepare.join(' ').slice(0, 160) || '-' }));
  console.log(t('project.test', { test: loaded.test.join(' ').slice(0, 160) || '-' }));
  for (const w of plan.warnings) console.log(`⚠ ${w}`);
  if (!args.includes('--yes') && !(await confirm(t('project.confirm', { file })))) {
    console.log(t('project.cancelled'));
    return;
  }
  writeFileSync(file, next);
  console.log(t('project.saved', { id: plan.id, file }));
  // The clone the tasks start from, in the company's workspace.
  if (loaded.workspace.type === 'coder' && loaded.workspace.reference) {
    const r = spawnSync(
      'coder',
      ['ssh', loaded.workspace.name, '--', 'test', '-d', `${loaded.workspace.reference}/.git`],
      { timeout: 120000, encoding: 'utf8' },
    );
    console.log(
      r.status === 0
        ? t('project.cloneOk', { path: loaded.workspace.reference })
        : t('project.cloneMissing', { path: loaded.workspace.reference }),
    );
  }
  console.log(t('project.next'));
}
function confirm(text: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((done) =>
    rl.question(`${text} [y/N] `, (answer) => {
      rl.close();
      done(/^(y|yes|s|sim)$/i.test(answer.trim()));
    }),
  );
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
