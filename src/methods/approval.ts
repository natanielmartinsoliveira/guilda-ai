/** Whole answers that plainly approve (case, accents and end punctuation ignored). */
const APPROVALS = new Set([
  'sim',
  'ok',
  'okay',
  'aprovado',
  'aprovada',
  'aprovo',
  'autorizo',
  'autorizado',
  'pode seguir',
  'pode',
  'segue',
  'siga',
  '1',
  '👍',
  '✅',
  'yes',
  'approve',
  'approved',
  'go',
]);
/**
 * Whether an answer is a plain approval of a single-option question (a gate). Only a whole,
 * short approval counts: anything more ("ok, but change X") is an adjustment — when in doubt,
 * never an authorization.
 */
export function isApproval(answer: string) {
  const plain = answer
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[.!]+$/, '')
    .trim();
  return APPROVALS.has(plain);
}
