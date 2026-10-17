import { t } from '../i18n';
import type { DecisionQuestion } from '../database/entities';
import { renderPrompt } from '../prompts/prompt-files';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_FORMATS, Formats } from '../formats/formats';
/** Folder in the task folder (.ai-dev-team/ is excluded from git) holding the kit and the prints. */
export const EVIDENCE_DIR = '.ai-dev-team/evidence';
export interface Shot {
  file: string;
  title: string;
  url: string;
  at: string;
}
const SHOT_FILE = /^\d{2}-[a-z0-9-]+\.png$/;
/** The kit's manifest, checked: prints the agent cannot point outside the output folder. */
export function readManifest(json: string): { shots: Shot[] } | { problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { problem: t('evidence.manifest.unreadable') };
  }
  const shots = (parsed as { shots?: unknown })?.shots;
  if (!Array.isArray(shots) || !shots.length) return { problem: t('evidence.manifest.empty') };
  const out: Shot[] = [];
  for (const s of shots as Partial<Shot>[]) {
    if (typeof s?.file !== 'string' || !SHOT_FILE.test(s.file))
      return { problem: t('evidence.manifest.badFile', { file: JSON.stringify(s?.file) }) };
    if (typeof s.url !== 'string' || !s.url.trim())
      return { problem: t('evidence.manifest.noUrl', { file: s.file }) };
    if (typeof s.at !== 'string' || !s.at.trim())
      return { problem: t('evidence.manifest.noTime', { file: s.file }) };
    out.push({ file: s.file, title: String(s.title ?? ''), url: s.url, at: s.at });
  }
  return { shots: out };
}
/** The developer's test comment, in the format the company's cards use. */
export async function commentText(
  shots: Shot[],
  evidence: Formats['evidence'] = DEFAULT_FORMATS.evidence,
  packDir?: string,
) {
  const fill = (text: string, values: Record<string, string>) =>
    text.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => values[key] ?? match);
  const list = shots
    .map((s, i) =>
      fill(evidence.shot, {
        N: String(i + 1),
        TITLE: s.title,
        URL: s.url,
        AT: s.at,
        FILE: s.file,
      }),
    )
    .join('\n\n');
  let template = 'Evidência de teste (automática):\n\n{{SHOTS}}';
  if (evidence.comment) {
    // The company's comment format lives in its pack, never outside it.
    const root = resolve(packDir ?? '.');
    const path = resolve(root, evidence.comment);
    if (!packDir || !path.startsWith(`${root}/`))
      throw new Error(
        `formats.evidence.comment precisa ficar dentro do pacote: ${evidence.comment}`,
      );
    template = await readFile(path, 'utf8');
  }
  return fill(template, { SHOTS: list });
}
/** The evidence request (prompts/evidence.md of the project, the company pack or the core). */
export function evidencePrompt(
  input: { material: string; route: string; notes?: string[]; version: string },
  packDir?: string,
  projectId?: string,
) {
  return renderPrompt(
    'evidence.md',
    {
      EVIDENCE_DIR,
      ROUTE: input.route,
      VERSION: input.version,
      MATERIAL: input.material,
      NOTES: input.notes?.length
        ? `\n\nOrientações do operador para a evidência:\n${input.notes.map((n) => `- ${n}`).join('\n')}`
        : '',
    },
    packDir,
    projectId,
  );
}
/** What the operator sees when the prints could not show the result. */
/** Retry, the agent's own choices, or go on without evidence (a delivery with nothing to show). */
export function evidenceQuestion(pending: string, choices: string[] = []): DecisionQuestion {
  return {
    text: t('evidence.question', { pending }),
    options: [t('evidence.retry'), ...choices, t('evidence.skip')],
  };
}
