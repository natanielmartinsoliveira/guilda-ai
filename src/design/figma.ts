import { TaskError } from '../config';
export interface FigmaLink {
  key: string;
  /** "123:456", from node-id=123-456 (or 123:456, 123%3A456). */
  node?: string;
  url: string;
}
const LINK =
  /https?:\/\/(?:www\.)?figma\.com\/(?:design|file|proto)\/([A-Za-z0-9]{10,})[^\s<>()"'\]]*/g;
/** Figma links in a text, once each, in order. */
export function figmaLinks(text: string): FigmaLink[] {
  const found = new Map<string, FigmaLink>();
  for (const match of text.matchAll(LINK)) {
    const url = match[0];
    const id = /[?&]node-id=(\d+)(?:-|:|%3A)(\d+)/i.exec(url);
    const link = { key: match[1], node: id ? `${id[1]}:${id[2]}` : undefined, url };
    const seen = `${link.key}#${link.node ?? ''}`;
    if (!found.has(seen)) found.set(seen, link);
  }
  return [...found.values()];
}
export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  characters?: string;
  visible?: boolean;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  children?: FigmaNode[];
}
const SCREEN = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);
const CONTAINER = new Set(['SECTION', 'GROUP', 'CANVAS']);
const size = (n: FigmaNode) => n.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
/** Big enough to be a screen (a modal included); smaller frames are notes or layout. */
const screenSized = (n: FigmaNode) => size(n).width >= 320 && size(n).height >= 320;
const areaOf = (n: FigmaNode) => size(n).width * size(n).height;
const reading = (a: FigmaNode, b: FigmaNode) => size(a).y - size(b).y || size(a).x - size(b).x;
/**
 * The screens in a linked node: a board (or section) holding several screen-sized frames gives
 * them; a link to one screen gives that screen (its inner layout frames are not screens).
 */
export function screensOf(node: FigmaNode): FigmaNode[] {
  const found: FigmaNode[] = [];
  const walk = (n: FigmaNode) => {
    for (const child of n.children ?? []) {
      if (child.visible === false) continue;
      if (SCREEN.has(child.type)) found.push(child);
      else if (CONTAINER.has(child.type)) walk(child);
    }
  };
  walk(node);
  const screens = found.filter(screenSized);
  // A board is much bigger than its screens; a screen with a modal over the page is not.
  const biggest = Math.max(0, ...screens.map(areaOf));
  if (CONTAINER.has(node.type) || (screens.length >= 2 && areaOf(node) >= 2 * biggest))
    return (screens.length ? screens : found).sort(reading);
  return [node];
}
/** Visible texts, top to bottom, once each. */
export function textsOf(node: FigmaNode, max = 150): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (n: FigmaNode) => {
    if (out.length >= max || n.visible === false) return;
    if (n.type === 'TEXT' && n.characters) {
      // Zero-width characters (common in design files) are not text.
      const text = n.characters
        .replace(/[​-‍⁠﻿]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        out.push(text);
      }
    }
    for (const child of [...(n.children ?? [])].sort(reading)) walk(child);
  };
  walk(node);
  return out;
}
const words = (text: string) =>
  new Set(
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .match(/[a-z0-9]{4,}/g) ?? [],
  );
/** The screens that share most words with `about` (ties keep their order). */
export function rankScreens<T extends { name: string; texts: string[] }>(
  screens: T[],
  about: string,
  limit: number,
): T[] {
  const wanted = words(about);
  return screens
    .map((screen, i) => ({
      screen,
      i,
      score: [...words(`${screen.name} ${screen.texts.join(' ')}`)].filter((w) => wanted.has(w))
        .length,
    }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((s) => s.screen);
}
export interface Screen {
  id: string;
  name: string;
  width: number;
  height: number;
  texts: string[];
  /** Image path inside the attachments mount (figma/…png); absent when it failed to export. */
  file?: string;
}
const pad = (n: number) => String(n).padStart(2, '0');
/** figma/index.md: every screen with its texts; ★ = attached as an image. */
export function indexMarkdown(input: {
  url: string;
  title: string;
  screens: Screen[];
  attached: Set<string>;
  cut: number;
}): string {
  const head = [
    `# Design do Figma: ${input.title}`,
    `Link: ${input.url}`,
    `${input.screens.length} tela(s). As marcadas com ★ foram anexadas como imagem (as mais ligadas a esta tarefa); as outras imagens estão nesta mesma pasta.`,
    ...(input.cut ? [`Mais ${input.cut} telas menores ficaram de fora (limite de 40).`] : []),
  ];
  const body = input.screens.map((s, i) =>
    [
      `## ${input.attached.has(s.id) ? '★ ' : ''}${pad(i + 1)} — ${s.name} (${Math.round(s.width)}×${Math.round(s.height)}) — ${s.file ?? '(imagem indisponível)'}`,
      ...s.texts.map((t) => `- ${t}`),
    ].join('\n'),
  );
  return `${[head.join('\n'), ...body].join('\n\n')}\n`;
}
export class FigmaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
/** Figma REST API with a personal access token (read-only). */
export class FigmaClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  private async request(url: string, init?: RequestInit) {
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      throw new TaskError(
        `Figma unreachable: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    if (response.status === 429 || response.status >= 500)
      throw new TaskError(`Figma ${response.status}`, true);
    if (!response.ok) throw new FigmaError(response.status, `Figma ${response.status}`);
    return response;
  }
  private async get<T>(path: string): Promise<T> {
    const response = await this.request(`https://api.figma.com${path}`, {
      headers: { 'X-Figma-Token': this.token },
    });
    return (await response.json()) as T;
  }
  async node(key: string, id: string) {
    const out = await this.get<{
      name: string;
      version: string;
      nodes: Record<string, { document: FigmaNode } | null>;
    }>(`/v1/files/${key}/nodes?ids=${encodeURIComponent(id)}`);
    const document = out.nodes?.[id]?.document;
    if (!document) throw new FigmaError(404, 'Figma node not found');
    return { name: out.name, version: String(out.version), document };
  }
  async images(key: string, ids: string[], scale: number) {
    let out: { err: string | null; images: Record<string, string | null> };
    try {
      out = await this.get(
        `/v1/images/${key}?ids=${encodeURIComponent(ids.join(','))}&format=png&scale=${scale}`,
      );
    } catch (error) {
      // Figma answers a render that took too long with 400: try again later, it is not missing.
      if (error instanceof FigmaError && error.status === 400)
        throw new TaskError('Figma images: render failed (400)', true);
      throw error;
    }
    if (out.err) throw new TaskError(`Figma images: ${out.err}`, true);
    return out.images;
  }
  /** Rendered images live on a CDN: no token goes there. */
  async download(url: string) {
    const response = await this.request(url);
    return Buffer.from(await response.arrayBuffer());
  }
}
