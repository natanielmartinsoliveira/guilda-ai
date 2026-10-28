import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { parseTenantsData } from '../tenants/tenants';
import { parseRepoUrl } from './project-add';
export interface PackInit {
  /** The company id (lowercase, digits, -). */
  id: string;
  name: string;
  /** The first project's repository, as developers copy its URL. */
  repoUrl: string;
  /** The company's Coder (https URL): tasks run in each dev's workspace there. */
  coder?: string;
  language: 'pt-BR' | 'en';
}
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** ACME from acme, NOVA_CORP from nova-corp: the prefix of the pack's variables. */
const prefixOf = (id: string) => id.toUpperCase().replace(/-/g, '_');
/** The host a repository URL points at: GitHub, Bitbucket or (any other server) GitLab. */
function hostOf(url: string) {
  const where = parseRepoUrl(url);
  if (!where) throw new Error(`not a repository URL: ${url}`);
  if (where.hostname === 'github.com') return { where, type: 'github' as const };
  if (where.hostname === 'bitbucket.org') return { where, type: 'bitbucket' as const };
  return { where, type: 'gitlab' as const };
}
const pt = (lang: PackInit['language'], ptText: string, enText: string) =>
  lang === 'pt-BR' ? ptText : enText;
/** The files of a new company pack, by path; nothing is written. */
export function packFiles(input: PackInit): Record<string, string> {
  if (!ID.test(input.id)) throw new Error(`invalid company id "${input.id}"`);
  if (input.coder && !input.coder.startsWith('https://'))
    throw new Error('the Coder URL must use https');
  const P = prefixOf(input.id);
  const { where, type } = hostOf(input.repoUrl);
  const repoName = basename(where.repository);
  const projectId = repoName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const token = `${P}_${type.toUpperCase()}_TOKEN`;
  const lang = input.language;
  const host =
    type === 'gitlab'
      ? [
          `  - id: gitlab`,
          `    type: gitlab`,
          `    baseUrl: https://${where.hostname}`,
          `    # Where workspaces clone from (ssh://host[:port]).`,
          `    sshUrl: ssh://${where.hostname}`,
          `    token: '\${${token}}'`,
        ]
      : [`  - { id: ${type}, type: ${type}, token: '\${${token}}' }`];
  const workspace = input.coder
    ? [
        "  # Tasks run in each dev's Coder workspace; the code never lands on their machine.",
        '  workspace:',
        '    type: coder',
        `    url: ${input.coder}`,
        `    name: '\${${P}_CODER_WORKSPACE}'`,
        '    root: /workspaces/ai-dev-team',
        '  # Rehearsal: nothing leaves the workspace until "Open draft PR" in the panel.',
        '  delivery: rehearsal',
      ]
    : ['  delivery: normal'];
  const company = [
    `# ${input.name}: company pack of the Guilda AI. Everything personal or secret comes from`,
    '# requires.yaml, filled by each dev in their own .env (npm run setup). See docs/packs.md.',
    `id: ${input.id}`,
    `name: ${JSON.stringify(input.name)}`,
    `git: { authorName: '\${${P}_GIT_NAME}', authorEmail: '\${${P}_GIT_EMAIL}' }`,
    'ai:',
    "  # Providers the company's contract allows to receive its code.",
    '  providers: [claude]',
    '  credentials:',
    "    # Without apiKey the CLI uses each dev's own login (subscription).",
    '    - { id: claude-login, provider: claude }',
    'hosts:',
    ...host,
    '# Card sources (Jira, Businessmap, GitHub Issues): see docs/sources.md.',
    'sources: []',
    '# What every project shares; each project below keeps only what differs.',
    'projectDefaults:',
    `  host: ${type}`,
    "  branch: '{key}-{slug}'",
    '  # Security checks of every delivery; semgrep rulesets: p/default, or the language one (p/php…).',
    '  checks: { tools: [gitleaks, semgrep, osv], semgrep: { configs: [p/default] } }',
    ...workspace,
    '  pullRequest:',
    "    title: '{key} - {title}'",
    '# More projects: npm run project:add -- <this folder> <repository URL>',
    'projects:',
    `  - id: ${projectId}`,
    `    repository: ${where.repository}`,
    '    defaultBranch: main',
    ...(input.coder ? [`    workspace: { reference: /workspaces/${repoName} }`] : []),
    "    # The project's own test command (or a stack from stacks/). Until then every task fails",
    "    # here, saying so: a task never passes without the project's tests.",
    '    test: [sh, -c, \'echo "set the test command of this project in company.yaml" >&2; exit 1\']',
    '',
  ].join('\n');
  const requires = [
    '# What each dev provides to use this pack (in their own .env, never in the pack).',
    stringify([
      {
        name: `${P}_GIT_NAME`,
        description: pt(
          lang,
          'Nome nos commits que a IA faz por você',
          'Name on the commits the AI makes for you',
        ),
        example: 'Jane Doe (AI)',
      },
      {
        name: `${P}_GIT_EMAIL`,
        description: pt(
          lang,
          'E-mail nesses commits (o da empresa)',
          'E-mail on those commits (your company e-mail)',
        ),
        example: `jane@${input.id}.example`,
      },
      {
        name: token,
        description: pt(
          lang,
          `Token do ${type} com acesso de leitura e escrita aos repositórios e PRs`,
          `${type} token with read/write access to the repositories and pull requests`,
        ),
        secret: true,
      },
      ...(input.coder
        ? [
            {
              name: `${P}_CODER_WORKSPACE`,
              description: pt(
                lang,
                'Nome do seu workspace no Coder (aparece em coder list)',
                'Your Coder workspace name (as coder list shows it)',
              ),
              example: 'jane-dev',
            },
          ]
        : []),
    ]),
  ].join('\n');
  const stack = [
    '# A stack: the prepare/test a kind of project shares, {{placeholders}} filled from vars.',
    '# A project uses it with  stack: { name: node-npm }  (see docs/packs.md, Stacks).',
    '# detect: the root files that make npm run project:add suggest it.',
    'detect: [package.json, package-lock.json]',
    'vars: { image: node:22 }',
    'prepare: [sh, -c, \'docker run --rm -v "$PWD":/app -w /app {{image}} npm ci --ignore-scripts\']',
    'test: [sh, -c, \'docker run --rm --network none -v "$PWD":/app -w /app {{image}} npm test\']',
    '',
  ].join('\n');
  const lessons = pt(
    lang,
    `# Todos os projetos de ${input.name}\n\n<!-- Uma linha "- " por lição; os agentes recebem em toda tarefa. -->\n`,
    `# Every project of ${input.name}\n\n<!-- One "- " line per lesson; the agents get them on every task. -->\n`,
  );
  const readme = pt(
    lang,
    `# ${input.name} — pacote da Guilda AI\n\nO que é da ${input.name} para a Guilda AI: hosts, projetos, stacks e lições. Segredos e dados pessoais ficam no \`.env\` de cada pessoa (lista em \`requires.yaml\`).\n\n## Próximos passos\n\n1. Defina o \`test\` do projeto \`${projectId}\` em \`company.yaml\` (ou use uma stack de \`stacks/\`).\n2. Publique esta pasta num repositório git privado da empresa.\n3. Cada pessoa: \`npm run setup\` no núcleo, com a URL deste repositório (ele pede os valores do \`requires.yaml\`).\n4. \`npm run doctor\` para conferir.\n5. Mais projetos: \`npm run project:add -- <esta pasta> <URL do repositório>\`.\n\nGuia completo: \`docs/pt-BR/pack-em-15-minutos.md\` no núcleo.\n`,
    `# ${input.name} — Guilda AI pack\n\nWhat belongs to ${input.name} for the Guilda AI: hosts, projects, stacks and lessons. Secrets and personal values stay in each dev's \`.env\` (listed in \`requires.yaml\`).\n\n## Next steps\n\n1. Set the \`test\` of project \`${projectId}\` in \`company.yaml\` (or use a stack from \`stacks/\`).\n2. Publish this folder as a private git repository of the company.\n3. Each dev: \`npm run setup\` in the core, with this repository's URL (it asks for the \`requires.yaml\` values).\n4. \`npm run doctor\` to check.\n5. More projects: \`npm run project:add -- <this folder> <repository URL>\`.\n\nFull guide: \`docs/pack-in-15-minutes.md\` in the core.\n`,
  );
  return {
    'company.yaml': company,
    'requires.yaml': requires,
    'stacks/node-npm.yaml': stack,
    'lessons/_all.md': lessons,
    'README.md': readme,
  };
}
/**
 * The new pack loads: company.yaml validated as the core reads it, with an example value for
 * every variable of requires.yaml.
 */
export function checkPack(files: Record<string, string>) {
  const env = Object.fromEntries(
    (parse(files['requires.yaml']) as { name: string; example?: string }[]).map((r) => [
      r.name,
      r.example ?? 'example-value',
    ]),
  );
  return parseTenantsData({ tenants: [parse(files['company.yaml'])] }, env);
}
/** Writes the pack into a folder that does not exist yet (or is empty). */
export function writePack(dir: string, files: Record<string, string>) {
  if (existsSync(dir) && readdirSync(dir).length)
    throw new Error(`${dir} already has files: choose an empty folder`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}
