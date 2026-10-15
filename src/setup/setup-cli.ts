import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { answersIo, runSetup, SetupIo } from './setup';
/**
 * npm run setup [-- --answers answers.json] [--packs-root <folder>]
 * Interactive by default; with --answers, every question takes its answer from the file
 * ({ "language": "en", "packs": "<url or folder> …", "<VARIABLE>": "…", "run:<pack>/<script>": true }).
 */
const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
/** The terminal: secrets are typed without echo. */
function terminalIo(): SetupIo {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  // No history: an earlier secret must never come back with the arrow keys.
  const rl = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const question = (text: string) => new Promise<string>((done) => rl.question(text, done));
  return {
    async ask(_key, text, opts) {
      const suffix = opts?.default ? ` [${opts.secret ? '•••' : opts.default}]` : '';
      process.stdout.write(`${text}${suffix}: `);
      muted = !!opts?.secret;
      const answer = await question('');
      if (muted) process.stdout.write('\n');
      muted = false;
      return answer.trim() || opts?.default || '';
    },
    async confirm(_key, text) {
      process.stdout.write(`${text} [y/N] `);
      return /^(y|yes|s|sim)$/i.test((await question('')).trim());
    },
    say: (line) => console.log(line),
  };
}
const answersFile = flag('--answers');
const said: string[] = [];
const io = answersFile
  ? answersIo(JSON.parse(readFileSync(resolve(answersFile), 'utf8')), said)
  : terminalIo();
runSetup({
  root: resolve('.'),
  packsRoot: resolve(flag('--packs-root') ?? join(homedir(), 'guilda-packs')),
  io: answersFile ? { ...io, say: (line) => console.log(line) } : io,
}).then(
  (result) => process.exit(result.ok ? 0 : 1),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
