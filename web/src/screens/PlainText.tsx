import { Fragment, ReactNode } from 'react';
/** `code` spans of a line; everything else stays text (React escapes it, so no HTML gets through). */
function inline(line: string): ReactNode[] {
  return line
    .split(/(`[^`\n]+`)/)
    .map((part, i) =>
      part.length > 2 && part.startsWith('`') && part.endsWith('`') ? (
        <code key={i}>{part.slice(1, -1)}</code>
      ) : (
        <Fragment key={i}>{part}</Fragment>
      ),
    );
}
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;
/**
 * A text written by an agent (a question, a report), shown as it reads: blank lines split
 * paragraphs, "- " / "1. " lines are lists, single line breaks are kept.
 */
export function PlainText({ text }: { text: string }) {
  const blocks = text.trim().split(/\n\s*\n/);
  return (
    <div className="plain-text">
      {blocks.map((block, b) => {
        const lines = block.split('\n');
        if (lines.every((l) => BULLET.test(l)))
          return (
            <ul key={b}>
              {lines.map((l, i) => (
                <li key={i}>{inline(l.replace(BULLET, ''))}</li>
              ))}
            </ul>
          );
        return (
          <p key={b}>
            {lines.map((l, i) => (
              <Fragment key={i}>
                {i > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
