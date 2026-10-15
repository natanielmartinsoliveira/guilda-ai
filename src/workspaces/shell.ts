const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** POSIX single quotes: inside '' only ' itself needs care. */
export function shellQuote(arg: string) {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
/** One command line for `sh -c`: variables through env(1), every word quoted. */
export function shellLine(argv: string[], env: Record<string, string> = {}) {
  const vars = Object.entries(env).map(([key, value]) => {
    if (!NAME.test(key)) throw new Error(`Invalid variable name: ${key}`);
    return shellQuote(`${key}=${value}`);
  });
  return [...(vars.length ? ['env', ...vars] : []), ...argv.map(shellQuote)].join(' ');
}
