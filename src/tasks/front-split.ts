import { DEFAULT_FORMATS, Formats } from '../formats/formats';
import { renderPrompt } from '../prompts/prompt-files';
/** Optional markup before a title: list bullet, markdown heading or bold. */
const LEAD = String.raw`^\s*(?:[-*]\s+|#{1,6}\s+|\*\*)?`;
/** Compared without case or accents ("Critérios" = "criterios"). */
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
/** A configured title as a pattern: words separated by a space, a hyphen or nothing. */
function words(title: string) {
  return plain(title)
    .trim()
    .split(/[\s-]+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
    .join('[\\s-]?');
}
const any = (titles: string[]) => `(?:${titles.map(words).join('|')})`;
function patterns(card: Formats['card']) {
  const front = any(card.frontTitles);
  return {
    /** A card's front title: alone, with a path in parentheses or followed by ":". */
    front: new RegExp(`${LEAD}${front}\\b(?:\\*\\*)?\\s*(?:$|[(:\\-–—])`, 'i'),
    frontTitle: new RegExp(`${LEAD}${front}\\b(?:\\*\\*)?`, 'i'),
    /** Top-level titles that end the front section (e.g. acceptance criteria). */
    section: new RegExp(`${LEAD}${any(card.endTitles)}\\b`, 'i'),
    /** A section that only says there is no screen work. */
    nothing: new RegExp(`^[-:–—\\s]*${any(card.nothing)}\\b`, 'i'),
  };
}
/**
 * The card's front section (title included), when it has one with content. The card is never
 * cut: both phases read it whole; this only says there is front work, and which. Titles and
 * phrases come from the company's card format.
 */
export function frontSection(
  body: string,
  card: Formats['card'] = DEFAULT_FORMATS.card,
): string | undefined {
  const p = patterns(card);
  const lines = body.split('\n');
  const start = lines.findIndex((line) => p.front.test(plain(line)));
  if (start < 0) return undefined;
  const after = lines.findIndex((line, i) => i > start && p.section.test(plain(line)));
  const end = after < 0 ? lines.length : after;
  const rest = lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
  const titleExtra = plain(lines[start]).replace(p.frontTitle, '').trim();
  if (!rest && !titleExtra) return undefined;
  if (p.nothing.test(plain(`${titleExtra} ${rest}`.trim()))) return undefined;
  return lines.slice(start, end).join('\n').trim();
}
/** Scope of the back phase when the card has a Front-end section. */
export function backOnly(packDir?: string, projectId?: string) {
  return renderPrompt('back-only.md', {}, packDir, projectId);
}
