import { execFileSync } from 'node:child_process';
import { shellLine, shellQuote } from '../src/workspaces/shell';
const tricky = [
  'plain',
  'two words',
  "it's",
  '"dq"',
  '$HOME',
  '`id`',
  'a;b && c',
  'line\nbreak',
  '',
  'ação ✓',
  '-n',
];
test('every argument survives sh -c intact (no injection)', () => {
  const line = shellLine(['printf', '%s\\0', ...tricky]);
  const out = execFileSync('sh', ['-c', line]).toString();
  expect(out.split('\0').slice(0, -1)).toEqual(tricky);
});
test('a quoted line survives a second sh -c (what coder ssh does)', () => {
  const inner = `cd /tmp && exec ${shellLine(['printf', '%s|', ...tricky])}`;
  const out = execFileSync('sh', ['-c', `sh -c ${shellQuote(inner)}`]).toString();
  expect(out).toBe(tricky.map((t) => `${t}|`).join(''));
});
test('env goes through env(1), quoted', () => {
  const line = shellLine(['sh', '-c', 'printf %s "$X"'], { X: "a'b $c" });
  expect(execFileSync('sh', ['-c', line]).toString()).toBe("a'b $c");
  expect(() => shellLine(['true'], { 'BAD-NAME': 'x' })).toThrow();
});
test('quote of empty string is two single quotes', () => {
  expect(shellQuote('')).toBe("''");
});
