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
