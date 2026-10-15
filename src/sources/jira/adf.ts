/** Minimal Atlassian Document Format node (Jira Cloud REST v3 rich text). */
export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}
/** Renders ADF as Markdown-ish plain text for the agent prompt. Unknown nodes keep their text. */
export function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return typeof node === 'string' ? node : '';
  return render(node as AdfNode)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function children(node: AdfNode, separator = ''): string {
  return (node.content ?? []).map(render).join(separator);
}
function render(node: AdfNode): string {
  const attrs = node.attrs ?? {};
  switch (node.type) {
    case 'text': {
      const link = node.marks?.find((m) => m.type === 'link')?.attrs?.href;
      const code = node.marks?.some((m) => m.type === 'code');
      const text = code ? `\`${node.text ?? ''}\`` : (node.text ?? '');
      return link ? `[${text}](${link})` : text;
    }
    case 'hardBreak':
      return '\n';
    case 'paragraph':
      return `${children(node)}\n\n`;
    case 'heading':
      return `${'#'.repeat(Number(attrs.level) || 1)} ${children(node)}\n\n`;
    case 'bulletList':
      return `${(node.content ?? []).map((item) => `- ${children(item).trim()}`).join('\n')}\n\n`;
    case 'orderedList':
      return `${(node.content ?? []).map((item, i) => `${i + 1}. ${children(item).trim()}`).join('\n')}\n\n`;
    case 'taskList':
      return `${(node.content ?? [])
        .map((item) => `- [${item.attrs?.state === 'DONE' ? 'x' : ' '}] ${children(item).trim()}`)
        .join('\n')}\n\n`;
    case 'codeBlock':
      return `\`\`\`${attrs.language ?? ''}\n${children(node)}\n\`\`\`\n\n`;
    case 'blockquote':
      return `${children(node)
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}\n\n`;
    case 'rule':
      return '---\n\n';
    case 'mention':
      return `@${String(attrs.text ?? attrs.id ?? '').replace(/^@/, '')}`;
    case 'emoji':
      return String(attrs.text ?? attrs.shortName ?? '');
    case 'inlineCard':
    case 'blockCard':
      return String(attrs.url ?? '');
    case 'media':
    case 'mediaSingle':
    case 'mediaGroup':
      // Files embedded in the description are also issue attachments, delivered separately.
      // The file name lets the agent match the image with /attachments/<name>.
      return node.type === 'media'
        ? attrs.alt
          ? `[anexo: ${String(attrs.alt)}]`
          : '[anexo]'
        : `${children(node, ' ')}\n\n`;
    case 'table':
      return `${(node.content ?? [])
        .map(
          (row) =>
            `| ${(row.content ?? []).map((cell) => children(cell).trim().replace(/\n+/g, ' ')).join(' | ')} |`,
        )
        .join('\n')}\n\n`;
    default:
      return node.text ?? children(node);
  }
}
