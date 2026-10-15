const entities: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};
/** Businessmap descriptions are HTML: readable text for the agent (images become a marker). */
export function htmlToText(html: string | null | undefined) {
  return String(html ?? '')
    .replace(/<img\b[^>]*>/gi, ' [imagem]')
    .replace(
      /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_, href: string, text: string) => `${text} (${href})`,
    )
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h\d|ul|ol|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (m) => entities[m])
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
/** Tag labels compare without case, accents or surrounding spaces. */
export const normalizeLabel = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
/** "group/…/repo" of a link to the company's GitLab (host), or undefined. */
export function repositoryFromLink(link: string, host: string) {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return undefined;
  }
  if (url.hostname.toLowerCase() !== host.toLowerCase()) return undefined;
  const path = url.pathname
    .split('/-/')[0]
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/^\/+/, '');
  return path.includes('/') ? path : undefined;
}
