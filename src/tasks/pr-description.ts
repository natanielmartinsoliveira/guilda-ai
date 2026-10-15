import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { TenantProject } from '../tenants/tenants';
import { branchKey } from './branch';
import { ChecksResult, checksSummary } from '../checks/checks.service';
import { renderPrompt } from '../prompts/prompt-files';
import { DEFAULT_FORMATS, PrSection } from '../formats/formats';
/** Appended to every prompt of projects that use a PR template: the agent writes the prose. */
export async function prSectionsRequest(
  sections: PrSection[] = DEFAULT_FORMATS.pullRequest.sections,
  packDir?: string,
  projectId?: string,
) {
  const list = sections.map((s) => `<${s.tag}>${s.ask}</${s.tag}>`).join('\n');
  return `\n${await renderPrompt('pr-sections.md', { PR_SECTIONS: list }, packDir, projectId)}`;
}
/** What the agent wrote in each section of the <pr> block, by tag. */
export type PrSections = Record<string, string>;
/**
 * Content of the last <tag>...</tag> block of a message (examples quoted earlier ignored).
 * Smaller models sometimes never close the block: then it runs to the end of the message.
 */
export function parseTag(message: string | undefined, tag: string): string | undefined {
  const start = message?.lastIndexOf(`<${tag}>`) ?? -1;
  if (start < 0) return undefined;
  const rest = message!.slice(start + tag.length + 2);
  const end = rest.indexOf(`</${tag}>`);
  return (end < 0 ? rest : rest.slice(0, end)).trim() || undefined;
}
export interface Review {
  verdict: 'aprovado' | 'ajustes';
  issues?: string;
  summary?: string;
}
export interface ReviewOutcome {
  /** approved; changes-addressed (findings fixed, no further pass); skipped (no review). */
  final: 'approved' | 'changes-addressed' | 'skipped';
  rounds: Review[];
  skipped?: string;
}
/** The reviewer's <revisao> block; an unclear verdict counts as no review. */
export function parseReview(message?: string): Review | undefined {
  const block = parseTag(message, 'revisao');
  if (!block) return undefined;
  const verdict = parseTag(block, 'veredito')?.toLowerCase();
  if (verdict !== 'aprovado' && verdict !== 'ajustes') return undefined;
  const issues = parseTag(block, 'problemas');
  // Asking for changes without saying which is not actionable.
  if (verdict === 'ajustes' && !issues) return undefined;
  return { verdict, issues, summary: parseTag(block, 'resumo') };
}
/** Markdown summary of the automatic review for the PR body. */
export function reviewSummary(review?: ReviewOutcome) {
  if (!review) return 'Sem revisão automática (revisor não configurado).';
  if (review.final === 'skipped')
    return `Revisão automática não realizada: ${review.skipped ?? 'sem resposta'}.`;
  const lines = review.rounds.map((r, i) => {
    const what = r.verdict === 'aprovado' ? 'aprovado' : 'ajustes pedidos e aplicados';
    const summary = r.summary ? ` — ${r.summary}` : '';
    const issues =
      r.issues && r.verdict === 'ajustes' ? `\n  ${r.issues.split('\n').join('\n  ')}` : '';
    return `- Rodada ${i + 1}: ${what}${summary}${issues}`;
  });
  const head =
    review.final === 'approved'
      ? 'Revisão automática: aprovado.'
      : 'Revisão automática: ajustes aplicados, sem nova rodada de revisão.';
  return [head, ...lines].join('\n');
}
/** Last <pr> block of the agent's final message. */
export function parsePrSections(
  message?: string,
  wanted: PrSection[] = DEFAULT_FORMATS.pullRequest.sections,
): PrSections | undefined {
  const start = message?.lastIndexOf('<pr>') ?? -1;
  const block = start < 0 ? undefined : message!.slice(start).match(/^<pr>([\s\S]*?)<\/pr>/)?.[1];
  if (!block) return undefined;
  const sections: PrSections = {};
  for (const { tag } of wanted) {
    const value = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();
    if (value) sections[tag] = value;
  }
  return sections;
}
/** Project rules and the PR block request, appended to the agent prompt. */
export async function withProjectRules(
  prompt: string,
  cfg: TenantProject,
  packDir?: string,
  sections?: PrSection[],
) {
  return [
    prompt,
    cfg.instructions ? `\nRegras do projeto (obrigatórias):\n${cfg.instructions}` : '',
    cfg.pullRequest.template ? await prSectionsRequest(sections, packDir, cfg.id) : '',
  ]
    .filter(Boolean)
    .join('\n');
}
export function branchUrl(pattern: string | undefined, key: string, branch: string) {
  if (!pattern) return '';
  const k = branchKey(key);
  return pattern
    .replace(/\{key_lower\}/g, k.toLowerCase())
    .replace(/\{key\}/g, k)
    .replace(/\{branch\}/g, branch);
}
export interface PrFacts {
  key: string;
  title: string;
  url: string;
  branch: string;
  body: string;
  changedFiles: string[];
  testsPassed: boolean;
  testCommand: string[];
  sections?: PrSections;
  review?: ReviewOutcome;
  checks?: ChecksResult & { blocking?: boolean };
}
const check = (on: boolean) => (on ? '✅' : '⬜');
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(spec|test)\.[a-z]+$|Test\.php$/i;
const MIGRATION = /(^|\/)(migrations?|database\/migrations?|db\/migrate)\//i;
/**
 * Fills the team's PR template. {{PLACEHOLDERS}}: BRANCH_URL, KEY, TITLE, ISSUE_URL, PROBLEM,
 * SOLUTION, HOW_TO_TEST, DATABASE, MIGRATIONS, TESTS_WRITTEN, TESTS_PASSING, TRANSLATIONS,
 * TEST_COMMAND, REVIEW, CHECKS. Facts the system knows are filled by it; prose comes from the agent.
 */
export async function renderPrTemplate(
  cfg: TenantProject,
  tenantsFile: string,
  facts: PrFacts,
  sections: PrSection[] = DEFAULT_FORMATS.pullRequest.sections,
) {
  const path = isAbsolute(cfg.pullRequest.template!)
    ? cfg.pullRequest.template!
    : resolve(dirname(tenantsFile), cfg.pullRequest.template!);
  const template = await readFile(path, 'utf8');
  const s = facts.sections ?? {};
  const migrations = facts.changedFiles.filter((f) => MIGRATION.test(f));
  const values: Record<string, string> = {
    BRANCH_URL: branchUrl(cfg.pullRequest.branchUrl, facts.key, facts.branch),
    KEY: facts.key,
    TITLE: facts.title,
    ISSUE_URL: facts.url,
    // The prose sections the company asks for (formats.pullRequest.sections).
    ...Object.fromEntries(
      sections.map((section) => [
        section.placeholder,
        sectionValue(section, s[section.tag], facts),
      ]),
    ),
    MIGRATIONS: migrations.length ? `Sim: ${migrations.map((m) => `\`${m}\``).join(', ')}` : 'Não',
    TESTS_WRITTEN: check(facts.changedFiles.some((f) => TEST_FILE.test(f))),
    TESTS_PASSING: check(facts.testsPassed),
    TEST_COMMAND: facts.testCommand.join(' '),
    REVIEW: reviewSummary(facts.review),
    CHECKS: checksSummary(facts.checks),
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => values[key] ?? match);
}
/** A section's text: what the agent wrote, else its fallback ("card" = start of the card). */
function sectionValue(section: PrSection, written: string | undefined, facts: PrFacts) {
  if (section.kind === 'check')
    // Answers in Portuguese or English (the core prompt may be in either language).
    return /^(sim|yes)\b/i.test(written ?? '')
      ? '✅'
      : /não se aplica|not applicable/i.test(written ?? '')
        ? '➖'
        : '⬜';
  if (written) return written;
  if (section.fallback === 'card') return facts.body.slice(0, 3000);
  return section.fallback ?? '';
}
/** PR title from the project pattern: {key} and {title}, each replaced once (no recursion). */
export function prTitle(pattern: string, key: string, title: string) {
  return pattern.replace(/\{key\}|\{title\}/g, (m) => (m === '{key}' ? key : title));
}
