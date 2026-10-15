import { Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Attachment } from '../attachments/attachments';
import { config } from '../config';
import type { Clarification } from '../database/entities';
import { NeedsInput } from '../tasks/decisions';
import type { Tenant } from '../tenants/tenants';
import {
  FigmaClient,
  FigmaError,
  FigmaLink,
  figmaLinks,
  indexMarkdown,
  rankScreens,
  Screen,
  screensOf,
  textsOf,
} from './figma';
export const NO_DESIGN =
  'A parte de front desta tarefa não tem design (nenhum link do Figma nem imagem anexada). Como seguir?';
export const NO_DESIGN_OPTIONS = [
  'Seguir o padrão das telas existentes',
  'Vou mandar o link do Figma do frame',
];
export const WHOLE_FILE =
  'O link do Figma aponta para o arquivo inteiro. Mande o link do frame das telas (com node-id).';
export const NO_ACCESS = 'Não consegui abrir o design no Figma';
export const ONLY_IMAGES = 'Seguir só com as imagens anexadas';
export const FIX_ACCESS = 'Vou corrigir o acesso (tente de novo)';
const MAX_SCREENS = 40;
const ATTACHED = 8;
const MAX_SIDE = 4096;
/** Screens per render request: Figma times out on big batches. */
const BATCH = 10;
export interface DesignInput {
  tenant: Tenant;
  /** Where a link may be, most specific first: the step, the operator's answers, the story. */
  texts: string[];
  /** What the front part is about: picks the screens attached as images. */
  about: string;
  clarifications: Clarification[];
  /** Images already attached to the task (prints). */
  images: number;
  /** The task's attachments directory; the design goes to its figma/ folder. */
  dir: string;
}
export interface DesignResult {
  source: 'figma' | 'images' | 'none';
  /** Extra attachments for the front agent (figma/index.md first, then the images). */
  files: Attachment[];
  /** One line for the front prompt. */
  note: string;
}
const IMAGES_NOTE = 'Use as imagens anexadas como referência visual.';
const PATTERN: DesignResult = {
  source: 'none',
  files: [],
  note: 'Não há design: siga o padrão visual das telas existentes do projeto (decisão do operador).',
};
const slug = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'tela';
const area = (s: { absoluteBoundingBox?: { width: number; height: number } | null }) =>
  (s.absoluteBoundingBox?.width ?? 0) * (s.absoluteBoundingBox?.height ?? 0);
/**
 * Decides where a front part's design comes from: the Figma frame linked in the step, the
 * operator's answers or the story; else the attached prints; else the operator is asked —
 * always before any AI is spent.
 */
@Injectable()
export class DesignService {
  /** Overridable in tests. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  async prepare(input: DesignInput): Promise<DesignResult> {
    const answers = (prefix: string) =>
      input.clarifications.filter((c) => c.question?.startsWith(prefix)).map((c) => c.text.trim());
    // The operator's latest answer wins over the card: it may correct a wrong or closed link.
    const links = [
      ...[...input.clarifications].reverse().flatMap((c) => figmaLinks(c.text)),
      ...input.texts.flatMap((t) => figmaLinks(t)),
    ];
    const link = links.find((l) => l.node);
    if (!link) {
      if (links.length) {
        const chosen = answers(WHOLE_FILE);
        if (input.images && chosen.includes(ONLY_IMAGES))
          return { source: 'images', files: [], note: IMAGES_NOTE };
        if (chosen.includes(NO_DESIGN_OPTIONS[0])) return PATTERN;
        throw new NeedsInput([
          {
            text: WHOLE_FILE,
            options: input.images ? [ONLY_IMAGES, NO_DESIGN_OPTIONS[0]] : [NO_DESIGN_OPTIONS[0]],
          },
        ]);
      }
      if (input.images) return { source: 'images', files: [], note: IMAGES_NOTE };
      // "I will send the link" without a link is no answer yet: ask again.
      if (answers(NO_DESIGN).some((a) => a && a !== NO_DESIGN_OPTIONS[1])) return PATTERN;
      throw new NeedsInput([{ text: NO_DESIGN, options: NO_DESIGN_OPTIONS }]);
    }
    try {
      const token = input.tenant.figma?.token;
      if (!token) throw new FigmaError(401, 'no Figma token');
      const files = await this.fromFigma(new FigmaClient(token, this.fetchImpl), link, input);
      return {
        source: 'figma',
        files,
        note: 'O design do Figma está em /attachments/figma/: leia primeiro figma/index.md (todas as telas e seus textos); as telas mais ligadas a esta tarefa vieram como imagem.',
      };
    } catch (error) {
      if (!(error instanceof FigmaError)) throw error;
      if (input.images && answers(NO_ACCESS).includes(ONLY_IMAGES))
        return { source: 'images', files: [], note: IMAGES_NOTE };
      const reason =
        error.status === 401
          ? 'sem token do Figma configurado'
          : error.status === 403
            ? 'sem permissão para este arquivo'
            : 'arquivo ou frame não encontrado';
      throw new NeedsInput([
        {
          text: `${NO_ACCESS} (${reason}). Como seguir?`,
          options: input.images ? [ONLY_IMAGES, FIX_ACCESS] : [FIX_ACCESS],
        },
      ]);
    }
  }
  private async fromFigma(client: FigmaClient, link: FigmaLink, input: DesignInput) {
    const { name, version, document } = await client.node(link.key, link.node!);
    const all = screensOf(document);
    const kept = new Set([...all].sort((a, b) => area(b) - area(a)).slice(0, MAX_SCREENS));
    const screens: Screen[] = all
      .filter((s) => kept.has(s))
      .map((s, i) => ({
        id: s.id,
        name: s.name,
        width: s.absoluteBoundingBox?.width ?? 0,
        height: s.absoluteBoundingBox?.height ?? 0,
        texts: textsOf(s),
        file: `figma/${String(i + 1).padStart(2, '0')}-${slug(s.name)}.png`,
      }));
    // One download per file version: the sub-tasks of a story share it.
    const cache = resolve(
      config().ATTACHMENTS_ROOT,
      input.tenant.id,
      '_figma',
      `${link.key}-${link.node!.replace(':', '-')}-${version.replace(/[^A-Za-z0-9]/g, '')}`,
    );
    if (!existsSync(join(cache, '.done'))) {
      await rm(cache, { recursive: true, force: true });
      await mkdir(cache, { recursive: true });
      await this.render(client, link.key, screens, cache);
      await writeFile(join(cache, '.done'), '');
    }
    const out = join(input.dir, 'figma');
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    for (const screen of screens) {
      const source = join(cache, basename(screen.file!));
      if (existsSync(source)) await copyFile(source, join(out, basename(screen.file!)));
      else screen.file = undefined;
    }
    const attached = new Set(
      rankScreens(
        screens.filter((s) => s.file),
        input.about,
        ATTACHED,
      ).map((s) => s.id),
    );
    const index = indexMarkdown({
      url: link.url,
      title: name,
      screens,
      attached,
      cut: all.length - screens.length,
    });
    await writeFile(join(out, 'index.md'), index);
    const files: Attachment[] = [
      { name: 'figma/index.md', contentType: 'text/markdown', size: Buffer.byteLength(index) },
    ];
    for (const id of attached) {
      const screen = screens.find((s) => s.id === id)!;
      files.push({
        name: screen.file!,
        contentType: 'image/png',
        size: (await stat(join(out, basename(screen.file!)))).size,
      });
    }
    return files;
  }
  /** Exports the screens as PNG, grouped by scale (none wider or taller than 4096 px). */
  private async render(client: FigmaClient, key: string, screens: Screen[], dir: string) {
    const groups = new Map<number, Screen[]>();
    for (const screen of screens) {
      const scale = Math.max(
        0.05,
        Math.floor(Math.min(1, MAX_SIDE / Math.max(screen.width, screen.height, 1)) * 100) / 100,
      );
      groups.set(scale, [...(groups.get(scale) ?? []), screen]);
    }
    for (const [scale, group] of groups)
      for (let at = 0; at < group.length; at += BATCH) {
        const batch = group.slice(at, at + BATCH);
        const urls = await client.images(
          key,
          batch.map((s) => s.id),
          scale,
        );
        for (const screen of batch) {
          const url = urls[screen.id];
          if (url) await writeFile(join(dir, basename(screen.file!)), await client.download(url));
        }
      }
  }
}
