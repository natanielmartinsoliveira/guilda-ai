import { basename, resolve } from 'node:path';
import { language, t } from '../i18n';
import { checkPack, packFiles, writePack } from './pack-init';
/**
 * npm run pack:init -- <folder> <first repository URL> [--id <id>] [--name <name>] [--coder <url>]
 * A new company pack, ready to load: company.yaml, requires.yaml, a stack, lessons and a README.
 */
const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
try {
  const [folder, repoUrl] = positional;
  if (!folder || !repoUrl) throw new Error(t('pack.usage'));
  const dir = resolve(folder);
  const id = flag('--id') ?? basename(dir).toLowerCase();
  const name = flag('--name') ?? id.charAt(0).toUpperCase() + id.slice(1);
  const files = packFiles({
    id,
    name,
    repoUrl,
    coder: flag('--coder'),
    language: language() === 'en' ? 'en' : 'pt-BR',
  });
  checkPack(files);
  writePack(dir, files);
  for (const path of Object.keys(files)) console.log(`  ${path}`);
  console.log(t('pack.created', { dir }));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
