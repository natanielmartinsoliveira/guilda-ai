import { resolve } from 'node:path';
import { checkMethod } from './check';
/** npm run method:check -- <pack folder> <method name> */
const [pack, name] = process.argv.slice(2);
if (!pack || !name) {
  console.error('usage: npm run method:check -- <pack folder> <method name>');
  process.exit(2);
}
checkMethod(resolve(pack), name).then(
  ({ cases, suites, failures }) => {
    for (const s of suites) console.log(s);
    for (const f of failures)
      console.error(
        `✗ ${f.file} · ${f.name}${f.line ? ` (linha ${f.line})` : ''}\n  esperado: ${JSON.stringify(f.expected)}\n  obtido:   ${JSON.stringify(f.actual)}`,
      );
    console.log(`${cases} caso(s) de prompt, ${failures.length} falha(s)`);
    process.exit(failures.length ? 1 : 0);
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
