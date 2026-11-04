import { t } from '../i18n';
import type { ReviewTarget } from '../tasks/orchestrator.service';
/** A REVIEW task's state (result.mrReview): the merge request, then what the review found. */
export interface MergeRequestReview extends ReviewTarget {
  /** Where the merge request leaves its target branch, and the commit actually reviewed. */
  base?: string;
  head?: string;
  verdict?: 'aprovado' | 'ajustes';
  issues?: string;
  summary?: string;
  /** The reviewer approved and the tests passed: the card moves on. */
  approved?: boolean;
  /** The comment is on the merge request (a retry never comments twice). */
  commented?: boolean;
}
/** The project's tests on the merge request's code (result.mrTests). */
export interface MergeRequestTests {
  /** false: the prepare step failed, so the tests never ran. */
  ran: boolean;
  passed: boolean;
  command: string;
  exitCode?: number;
  output?: string;
  /** Failing on the merge request: the same suite where it leaves its target branch. */
  baseline?: { passed: boolean; exitCode?: number; output?: string };
}
/** The suite fails on the target too: the failures came before the merge request. */
export const preexisting = (tests: MergeRequestTests) =>
  tests.ran && !tests.passed && tests.baseline?.passed === false;
/** The one comment a review leaves on the merge request. */
export function mergeRequestComment(mr: MergeRequestReview, tests: MergeRequestTests) {
  const tested = !tests.ran
    ? t('review.mr.testsNotRun')
    : tests.passed
      ? t('review.mr.testsPassed')
      : preexisting(tests)
        ? t('review.mr.testsPreexisting')
        : t('review.mr.testsFailed', { code: String(tests.exitCode) });
  return [
    `**${mr.approved ? t('review.mr.approved') : t('review.mr.changes')}**`,
    '',
    mr.summary ?? '',
    ...(mr.verdict === 'ajustes' && mr.issues
      ? ['', `**${t('review.mr.problems')}**`, mr.issues]
      : []),
    '',
    tested,
    ...(tests.passed || !tests.output ? [] : ['```', tests.output.slice(-3000), '```']),
    '',
    `<sub>${t('review.mr.footer', { sha: (mr.head ?? mr.sha).slice(0, 8) })}</sub>`,
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
