/** Branch names are generated, never taken from tracker or repository input as-is. */
const SAFE = /^(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** Refused whatever the configuration says. */
const ALWAYS_PROTECTED = ['main', 'master', 'develop', 'production', 'HEAD'];
/** "PF-2436" stays as is; anything else (e.g. "#7") becomes ref-safe ("7"). */
export function branchKey(key: string) {
  return key.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'task';
}
/** Card title → branch-safe words (e.g. 1234-fix-billing-payment-options). */
export function slugify(title: string) {
  const words = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return words.slice(0, 50).replace(/-+$/, '') || 'task';
}
export function renderBranch(pattern: string, key: string, id: string, title = '') {
  return pattern
    .replace(/\{key\}/g, branchKey(key))
    .replace(/\{id\}/g, id)
    .replace(/\{slug\}/g, slugify(title));
}
export function isSafeBranch(branch: string, protectedBranches: string[] = []) {
  return (
    SAFE.test(branch) &&
    !branch.endsWith('/') &&
    !branch.endsWith('.lock') &&
    !branch.endsWith('.') &&
    ![...ALWAYS_PROTECTED, ...protectedBranches].some(
      (p) => p.toLowerCase() === branch.toLowerCase(),
    )
  );
}
