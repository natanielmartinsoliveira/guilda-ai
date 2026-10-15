import { hashPassword } from './password';
/** Reads the password without echoing it and prints the WEB_PASSWORD_HASH line. */
function ask(prompt: string): Promise<string> {
  return new Promise((done) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    let value = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return done(value);
        }
        if (ch === '\u0003') process.exit(130);
        value = ch === '\u007f' ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.on('data', onData);
  });
}
async function main() {
  const first = await ask('Senha do front (mínimo 12 caracteres): ');
  const second = await ask('Repita a senha: ');
  if (first !== second) throw new Error('As senhas não conferem');
  console.log(`\nColoque no .env:\nWEB_PASSWORD_HASH=${await hashPassword(first)}`);
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
