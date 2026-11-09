/**
 * The failing tests a test run names, by the formats of the usual runners (PHPUnit, Jest,
 * Vitest, pytest, Go). An empty set means the run named none this module can read: nothing can
 * be compared then, and a failing run stays a failure.
 */
const FORMATS = [
  // PHPUnit: "1) Tests\Unit\FooTest::test_bar" (and "… with data set #0")
  /^\s*\d+\) ([\w\\]+::\w+)/gm,
  // Jest: "● Suite › test" (its console blocks are not tests)
  /^\s*● (?!Console\b)(.+?)\s*$/gm,
  // Vitest: " FAIL  src/a.test.ts > suite > test"
  /^\s*FAIL\s+(\S.*?)\s*$/gm,
  // pytest: "FAILED tests/test_a.py::test_b - AssertionError"
  /^FAILED (\S+)/gm,
  // Go: "--- FAIL: TestBar (0.00s)"
  /^\s*--- FAIL: (\S+)/gm,
];
export function failingTests(output: string) {
  const found = new Set<string>();
  for (const re of FORMATS) for (const m of output.matchAll(re)) found.add(m[1].trim());
  return found;
}
/**
 * The run fails only where the base already failed: every failing test it names failed there
 * too. Returns those tests, or undefined when anything else (or nothing readable) failed.
 */
export function onlyPreexisting(output: string, baseline: string[] | undefined) {
  if (!baseline?.length) return undefined;
  const now = failingTests(output);
  if (!now.size || [...now].some((t) => !baseline.includes(t))) return undefined;
  return [...now];
}
/**
 * The failing tests grouped by cause: the first line of each failure's message (numbers made
 * N, so the same mistake in two places is one cause). PHPUnit's numbered blocks carry it; a
 * runner whose failures this cannot read gives its test names under one unreadable cause.
 */
export function failureGroups(output: string) {
  const lines = output.split('\n');
  const groups = new Map<string, Set<string>>();
  const add = (cause: string, test: string) =>
    groups.set(cause, (groups.get(cause) ?? new Set()).add(test));
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\d+\) ([\w\\]+::\w+)/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    const message = (lines[j] ?? '').trim().replace(/\d+/g, 'N').slice(0, 160);
    add(message || '(sem mensagem)', m[1]);
  }
  if (!groups.size) for (const t of failingTests(output)) add('(causa não legível)', t);
  return [...groups]
    .map(([cause, tests]) => ({ cause, tests: [...tests] }))
    .sort((a, b) => b.tests.length - a.tests.length);
}
/** The failing tests by cause, as a short text for an agent (the largest causes first). */
export function failureDigest(output: string, max = 6000) {
  const groups = failureGroups(output);
  if (!groups.length) return '';
  const total = groups.reduce((n, g) => n + g.tests.length, 0);
  const lines = [`Testes que falham (${total}), por causa:`];
  for (const g of groups) {
    const names = g.tests.map((t) => t.replace(/^Tests\\/, '')).join(', ');
    lines.push(
      `- ${g.cause} (${g.tests.length}): ${names.length > 600 ? `${names.slice(0, 600)}…` : names}`,
    );
  }
  const text = lines.join('\n');
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}
