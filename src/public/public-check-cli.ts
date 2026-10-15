import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, resolve } from 'node:path';
import { parse } from 'dotenv';
import { packDirs } from '../tenants/packs';
import { forbiddenTerms, formatFinding, scanTree } from './public-check';
/**
 * npm run public:check — fails listing file and line wherever a name of the operator's companies
 * (packs, tenants.yaml, .env, .public-deny) or the operator's own user name is in the files that
 * would be published.
 */
try {
  const root = resolve('.');
  const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  const env = parse(read(resolve(root, '.env')));
  const tenantsFile = resolve(root, env.TENANTS_FILE || process.env.TENANTS_FILE || 'tenants.yaml');
  const terms = forbiddenTerms({
    packDirs: packDirs(env.GUILDA_PACKS || process.env.GUILDA_PACKS),
    yamlFiles: existsSync(tenantsFile) ? [tenantsFile] : [],
    env,
    deny: [
      ...read(resolve(root, '.public-deny')).split('\n'),
      // Paths like C:\Users\<name> or /home/<name> name the operator.
      userInfo().username,
      basename(homedir()),
    ],
  });
  if (!terms.length) {
    console.error(
      'public:check: nenhum termo para procurar (GUILDA_PACKS, tenants.yaml ou .public-deny)',
    );
    process.exit(1);
  }
  const found = scanTree(root, terms);
  for (const f of found) console.log(formatFinding(f));
  console.log(`${terms.length} termo(s) procurado(s), ${found.length} ocorrência(s)`);
  process.exit(found.length ? 1 : 0);
} catch (error) {
  // Only messages written to be safe (never a raw parser or file-system message with paths).
  const message = error instanceof Error ? error.message : '';
  console.error(message.startsWith('public:check:') ? message : 'public:check: falhou');
  process.exit(1);
}
