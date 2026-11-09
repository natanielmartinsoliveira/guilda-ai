import {
  failingTests,
  failureDigest,
  failureGroups,
  onlyPreexisting,
} from '../src/tasks/test-failures';
test('the failing tests each usual runner names', () => {
  const phpunit = `There were 2 errors:\n\n1) Tests\\Unit\\OrderTest::test_restore\nArgumentCountError\n\n2) Tests\\Feature\\ApiTest::test_list with data set #1\n`;
  expect([...failingTests(phpunit)]).toEqual([
    'Tests\\Unit\\OrderTest::test_restore',
    'Tests\\Feature\\ApiTest::test_list',
  ]);
  expect([...failingTests('  ● orders › lists them\n  ● Console\n')]).toEqual([
    'orders › lists them',
  ]);
  expect([...failingTests(' FAIL  src/a.test.ts > a > b\n')]).toEqual(['src/a.test.ts > a > b']);
  expect([...failingTests('FAILED tests/test_a.py::test_b - AssertionError\n')]).toEqual([
    'tests/test_a.py::test_b',
  ]);
  expect([...failingTests('--- FAIL: TestBar (0.00s)\n')]).toEqual(['TestBar']);
  expect(failingTests('Segmentation fault').size).toBe(0);
});
test('only what already failed on the base is discounted; anything new, or unreadable, is a failure', () => {
  const base = ['Tests\\Unit\\OrderTest::test_restore'];
  const same = '1) Tests\\Unit\\OrderTest::test_restore\n';
  const more = `${same}2) Tests\\Unit\\EmailTest::test_valid\n`;
  expect(onlyPreexisting(same, base)).toEqual(base);
  expect(onlyPreexisting(more, base)).toBeUndefined();
  expect(onlyPreexisting('Fatal error: out of memory', base)).toBeUndefined();
  expect(onlyPreexisting(same, undefined)).toBeUndefined();
  expect(onlyPreexisting(same, [])).toBeUndefined();
});
test('the failing tests grouped by the first line of their message, the largest cause first', () => {
  const out = [
    'There were 3 errors:',
    '',
    '1) Tests\\Unit\\OrderTest::test_a',
    'Error: Unknown named parameter $selectedTechnologies',
    '',
    '/var/www/html/tests/Unit/OrderTest.php:12',
    '',
    '2) Tests\\Unit\\ItemTest::test_b with data set #1',
    'Error: Unknown named parameter $selectedTechnologies',
    '',
    '3) Tests\\Unit\\MilestoneTest::test_c',
    'ArgumentCountError: Too few arguments to function restore(), 3 passed and 4 expected',
  ].join('\n');
  expect(failureGroups(out)).toEqual([
    {
      cause: 'Error: Unknown named parameter $selectedTechnologies',
      tests: ['Tests\\Unit\\OrderTest::test_a', 'Tests\\Unit\\ItemTest::test_b'],
    },
    {
      cause: 'ArgumentCountError: Too few arguments to function restore(), N passed and N expected',
      tests: ['Tests\\Unit\\MilestoneTest::test_c'],
    },
  ]);
  expect(failureDigest(out)).toBe(
    [
      'Testes que falham (3), por causa:',
      '- Error: Unknown named parameter $selectedTechnologies (2): Unit\\OrderTest::test_a, Unit\\ItemTest::test_b',
      '- ArgumentCountError: Too few arguments to function restore(), N passed and N expected (1): Unit\\MilestoneTest::test_c',
    ].join('\n'),
  );
  // another runner: its names, under one unreadable cause
  expect(failureGroups('FAILED tests/test_a.py::test_b - x')).toEqual([
    { cause: '(causa não legível)', tests: ['tests/test_a.py::test_b'] },
  ]);
  expect(failureDigest('all good')).toBe('');
});
