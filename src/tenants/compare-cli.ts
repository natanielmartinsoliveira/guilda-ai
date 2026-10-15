import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { compareTenants, templatesByContent } from './compare';
import { loadPacks, packDirs } from './packs';
import { loadTenants } from './tenants';
/**
 * npm run packs:compare — proves a migration to packs changed nothing: loads TENANTS_FILE and
 * the packs of GUILDA_PACKS (or of the first argument) with the same environment and compares.
 */
const dirs = packDirs(process.argv[2] ?? process.env.GUILDA_PACKS);
if (!dirs.length) {
  console.error(
    'Informe os pacotes: npm run packs:compare -- /pacote/a:/pacote/b (ou GUILDA_PACKS)',
  );
  process.exit(2);
}
const file = resolve(process.env.TENANTS_FILE || 'tenants.yaml');
const before = loadTenants(readFileSync(file, 'utf8'));
const after = loadPacks(dirs).tenants;
// A PR template moved into a pack is the same template when its content is the same.
const where = compareTenants(
  templatesByContent(before, dirname(file)),
  templatesByContent(after, dirname(file)),
);
if (where) {
  console.error(`Diferentes em ${where} (${file} × pacotes)`);
  process.exit(1);
}
console.log(`Idênticos: ${before.length} empresa(s) de ${file} = ${dirs.length} pacote(s).`);
