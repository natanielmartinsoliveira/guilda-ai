import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
/**
 * The core holds no company, no company's method and no project's stack: those live in the
 * company packs. Names cannot be listed here (this repository is public; npm run public:check
 * reads them from the packs instead), so this test looks for their traces: a domain that is no
 * vendor's or example's, and a stack's words where no generic reason allows them.
 */
const files = execFileSync('git', ['ls-files', 'src', 'prompts', 'web/src', 'scripts', 'deploy'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter((f) => f && !/\.(spec|test)\.(ts|tsx)$/.test(f) && !f.startsWith('web/src/test-'));
const lines = files.flatMap((file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .map((text, i) => ({ file, line: i + 1, text })),
);
/** Vendors the core talks to or names, the panel's art, and example/local hosts. */
const DOMAINS = new Set([
  'github.com',
  'api.github.com',
  'githubusercontent.com',
  'ghcr.io',
  'gitlab.com',
  'bitbucket.org',
  'api.bitbucket.org',
  'atlassian.net',
  'kanbanize.com',
  'coder.com',
  'telegram.org',
  'api.telegram.org',
  'figma.com',
  'www.figma.com',
  'api.figma.com',
  'anthropic.com',
  'api.anthropic.com',
  'openai.com',
  'api.openai.com',
  'openrouter.ai',
  'osv.dev',
  'mcr.microsoft.com',
  'ngrok.io',
  'ngrok.app',
  'ngrok-free.app',
  'ngrok-free.dev',
  'kenney.nl',
  'example.com',
  'localhost',
]);
const exampleHost = (h: string) =>
  /(^|\.)(example|test|invalid|localhost)$/.test(h) ||
  /^\d+\.\d+\.\d+\.\d+$/.test(h) ||
  h.endsWith('.atlassian.net');
/** A URL's host, or a host name written alone in quotes. */
const HOST =
  /https?:\/\/([a-z0-9.-]+)|['"`]((?:[a-z0-9-]+\.)+(?:com|br|net|org|io|dev|ai|app|cloud))['"`/]/gi;

test('every domain in the core is a vendor, a tool or an example: never a company', () => {
  const found = lines.flatMap(({ file, line, text }) =>
    [...text.matchAll(HOST)]
      .map((m) => (m[1] ?? m[2]).toLowerCase().replace(/\.$/, ''))
      // i18n keys that look like hosts ("detail.ai"), and a public suffix named in a comment
      .filter((h) => !/^detail\.ai$|^com\.br$/.test(h))
      .filter((h) => !DOMAINS.has(h) && !exampleHost(h))
      .map((h) => `${file}:${line} ${h}`),
  );
  expect(found).toEqual([]);
});

/**
 * Words of a project's stack. Where the core has a generic reason to say one, the file is
 * allowed it here, with the reason; anything else belongs in a pack (stacks/, methods/).
 */
const STACK =
  /\b(php|composer|laravel|phpunit|artisan|symfony|django|rails|rubygems|maven|gradle|pytest|dotnet|nuget|cargo|golang|spring|wordpress|magento|vue|angular|nextjs|nuxt|pnpm|yarn|mysql|mongodb)\b/gi;
const ALLOWED: Record<string, { words: string[]; why: string }> = {
  'src/checks/checks.service.ts': {
    words: ['composer', 'cargo', 'pnpm', 'yarn'],
    why: 'the lockfiles osv reads, of every ecosystem',
  },
  'src/checks/remote-checks.ts': {
    words: ['composer', 'cargo', 'pnpm', 'yarn'],
    why: 'the lockfiles osv reads, of every ecosystem',
  },
  'src/tasks/pr-description.ts': {
    words: ['php'],
    why: 'test files of every language (FooTest.php) are told apart from code',
  },
  'src/tenants/tenants.ts': { words: ['php'], why: 'an example semgrep ruleset in a comment' },
  'src/projects/pack-init.ts': {
    words: ['php'],
    why: 'an example semgrep ruleset in the generated comment',
  },
};

test("no stack's words in the core but where a generic reason allows them", () => {
  const found = lines.flatMap(({ file, line, text }) =>
    [...text.matchAll(STACK)]
      .map((m) => m[1].toLowerCase())
      .filter((word) => !ALLOWED[file]?.words.includes(word))
      .map((word) => `${file}:${line} ${word}`),
  );
  expect(found).toEqual([]);
});

test('the allowed exceptions are still needed (a stale one would hide a new use)', () => {
  for (const [file, { words }] of Object.entries(ALLOWED)) {
    const text = readFileSync(file, 'utf8').toLowerCase();
    for (const word of words)
      expect([file, new RegExp(`\\b${word}\\b`).test(text)]).toEqual([file, true]);
  }
});
