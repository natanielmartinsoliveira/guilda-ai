import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { loadPacks, packDirs } from './packs';
import { formatsConfig } from '../formats/formats';
import { methodProblems } from '../methods/method';
// Deliberately independent from config.ts: redact() depends on this module.
/** Every tenant implicitly has this source: tasks created through /api (VS Code, MCP). */
export const API_SOURCE = 'api';
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and -');
const argv = z.array(z.string().min(1));
const secret = z.string().min(1);
const githubHost = z.object({ id: slug, type: z.literal('github'), token: secret });
/**
 * Bitbucket Cloud. "access-token": repository/project/workspace access token (Bearer).
 * "api-token": Atlassian account API token, REST with e-mail (scopes read/write:repository and
 * read/write:pullrequest).
 */
const bitbucketHost = z
  .object({
    id: slug,
    type: z.literal('bitbucket'),
    auth: z.enum(['access-token', 'api-token']).default('access-token'),
    email: z.string().min(3).optional(),
    token: secret,
  })
  .refine((h) => h.auth === 'access-token' || !!h.email, {
    message: 'api-token auth requires email',
    path: ['email'],
  });
/**
 * Self-hosted GitLab. sshUrl: where workspaces clone from (ssh://host[:port]); merge requests
 * through the REST API come later.
 */
const gitlabHost = z.object({
  id: slug,
  type: z.literal('gitlab'),
  baseUrl: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), 'must use https')
    .transform((u) => u.replace(/\/+$/, '')),
  sshUrl: z
    .string()
    .regex(/^ssh:\/\/([A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+(:\d+)?$/, 'ssh://[user@]host[:port]'),
  /**
   * The server's public key (as ssh-keyscan prints it, without the host): git in the workspace
   * accepts exactly this key, without prompting and without touching the workspace's ~/.ssh.
   */
  sshHostKey: z
    .string()
    .regex(
      /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/]+={0,3}$/,
      'sshHostKey: one public key line ("ssh-ed25519 AAAA...")',
    )
    .optional(),
  token: secret,
  /** How often open MRs are read for "/ai ..." comments (the GitLab cannot call us). */
  pollSeconds: z.number().int().min(30).default(60),
  /** Usernames allowed to trigger with "/ai"; empty = anyone who can comment. */
  allowedUsers: z.array(z.string().min(1)).default([]),
});
const absolute = z
  .string()
  .refine((p) => p.startsWith('/'), 'absolute path')
  .refine((p) => !p.split('/').includes('..'), 'no .. in path')
  .transform((p) => p.replace(/\/+$/, '') || '/');
/**
 * The company's Coder workspace: clone, agent, tests and commits happen there (coder ssh), so
 * the code never lands on this machine. root: folder of the task copies, outside protect;
 * reference: a clone there whose objects speed up cloning (read only); protect: folders (the
 * operator's own clones) the agent must leave untouched.
 */
const coderWorkspace = z.object({
  type: z.literal('coder'),
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), 'must use https'),
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/, 'Coder workspace name'),
  agent: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'Coder agent name')
    .optional(),
  root: absolute,
  reference: absolute.optional(),
  protect: z.array(absolute).default(['/workspaces']),
});
/**
 * How a change is carried. Absent: the core's own planner, coder and reviewer. Otherwise a
 * method of the company pack (methods/<name>/method.yaml) with its options.
 */
const methodConfig = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'method name')
      .optional(),
    options: z.record(z.string(), z.string()).default({}),
    type: z.unknown().optional(),
  })
  .superRefine((m, ctx) => {
    if (m.type !== undefined || !m.name)
      ctx.addIssue({
        code: 'custom',
        message:
          'method: use { name: <method of the company pack>, options: { … } } (the form { type: … } no longer exists)',
      });
  })
  .transform((m) => ({ name: m.name!, options: m.options }))
  .optional();
const workspaceConfig = z
  .discriminatedUnion('type', [z.object({ type: z.literal('local') }), coderWorkspace])
  .default({ type: 'local' });
/** Bitbucket Cloud webhook: "/ai ..." comments on pull requests request revisions. */
const bitbucketSource = z.object({
  id: slug,
  type: z.literal('bitbucket'),
  webhookSecret: z.string().min(16),
  /** Account ids or nicknames allowed to trigger; empty = anyone who can comment. */
  allowedUsers: z.array(z.string().min(1)).default([]),
});
const githubIssuesSource = z.object({
  id: slug,
  type: z.literal('github-issues'),
  webhookSecret: z.string().min(16),
  allowedAssociations: z.array(z.string().min(1)).default(['OWNER', 'MEMBER', 'COLLABORATOR']),
  /** false: only "/ai ..." PR comments (revisions), e.g. when tasks come from Jira. */
  createFromIssues: z.boolean().default(true),
});
const jiraKey = z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/, 'Jira project key, e.g. API');
const jiraSource = z
  .object({
    id: slug,
    type: z.literal('jira'),
    /** https://company.atlassian.net or the Data Center base URL. */
    baseUrl: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://'), 'must use https')
      .transform((u) => u.replace(/\/+$/, '')),
    deployment: z.enum(['cloud', 'datacenter']).default('cloud'),
    /** Cloud: account e-mail + API token. Data Center: personal access token only. */
    email: z.string().min(3).optional(),
    token: secret,
    /** Issues matching this JQL become tasks; move them out of it (transitions.start). */
    jql: z.string().min(1),
    pollSeconds: z.number().int().min(30).default(60),
    /** Jira project key → tenant project id holding the code. */
    projects: z.record(jiraKey, slug).default({}),
    defaultProject: slug.optional(),
    /**
     * Transition (or target status) names; absent means "do not move the card".
     * changeRequest: the status reviewers move a card to when asking for changes; new comments
     * on cards in that status become a revision of the task's PR.
     */
    transitions: z
      .object({
        start: z.string().min(1).optional(),
        review: z.string().min(1).optional(),
        changeRequest: z.string().min(1).optional(),
      })
      .default({}),
    /**
     * same-pr: a card's sub-tasks are steps of one delivery — one PR, one commit per sub-task,
     * in Jira order (sub-tasks themselves are never picked up).
     * branch-per-subtask: the card gets a story branch (from the default branch); each sub-task,
     * in order, gets its own branch stacked on the previous one and its own PR into the story
     * branch. The story's final PR stays with the team.
     * separate: every matching card, sub-tasks included, is its own task.
     */
    subtasks: z.enum(['same-pr', 'branch-per-subtask', 'separate']).default('same-pr'),
    comments: z.boolean().default(true),
  })
  .refine((s) => s.deployment === 'datacenter' || !!s.email, {
    message: 'Jira Cloud requires email (account of the API token)',
    path: ['email'],
  });
/** A route name of the project's method (checked against the method when a card arrives). */
const routeName = z.string().regex(/^[a-z][a-z0-9-]*$/, 'route name');
/**
 * Businessmap (Kanbanize) API v2, read-only: open cards of the board in the trigger columns or
 * with the trigger tag become tasks; the project comes from the repository link field and the
 * route of the project's method from a route tag (never inferred).
 */
const businessmapSource = z
  .object({
    id: slug,
    type: z.literal('businessmap'),
    baseUrl: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://'), 'must use https')
      .transform((u) => u.replace(/\/+$/, '')),
    token: secret,
    boardId: z.number().int().positive(),
    pollSeconds: z.number().int().min(30).default(60),
    trigger: z.object({
      columns: z.array(z.number().int().positive()).default([]),
      tag: z.string().min(1).optional(),
      /** Only cards owned by these users (Businessmap user ids); empty: any owner. */
      owners: z.array(z.number().int().positive()).default([]),
    }),
    /** Column (id) the card moves to at each step of its task; absent: the card stays. */
    moves: z
      .object({
        gate: z.number().int().positive().optional(),
        building: z.number().int().positive().optional(),
        built: z.number().int().positive().optional(),
        review: z.number().int().positive().optional(),
      })
      .strict()
      .default({}),
    /** Custom field (type link) holding the card's GitLab repository. */
    repositoryField: z.number().int().positive(),
    /**
     * Tag label (case and accents ignored) → route of the project's method. Without one, a tag
     * named as a route of the method is that route.
     */
    routeTags: z
      .record(z.string().min(1), routeName)
      .default({})
      // Card labels are compared normalized, so the configured ones are too.
      .transform((tags) =>
        Object.fromEntries(
          Object.entries(tags).map(([label, route]) => [
            label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(),
            route,
          ]),
        ),
      ),
  })
  .refine((s) => s.trigger.columns.length > 0 || !!s.trigger.tag, {
    message: 'trigger needs columns or tag',
    path: ['trigger'],
  });
const image = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/, 'docker image reference');
/**
 * Runs the project's prepare/test commands inside a throwaway container of an existing image
 * (e.g. the image of the team's docker-compose), with the task workspace mounted. The agent
 * itself keeps running in the bubblewrap sandbox.
 */
const dockerRunner = z.object({
  type: z.literal('docker'),
  /** Already built image; never built from the repository. */
  image,
  /** Named network holding the services (DB, cache). "none" isolates; "host" is refused. */
  network: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)
    .refine((n) => n !== 'host', 'host network is not allowed')
    .default('none'),
  /** Where the workspace is mounted, usually the app path inside the image. */
  workdir: z.string().regex(/^\/[A-Za-z0-9._/-]*$/, 'absolute path'),
  /** uid[:gid] inside the container; defaults to the worker's own user. Root is refused. */
  user: z
    .string()
    .regex(/^\d+(:\d+)?$/)
    .refine((u) => !/^0(:|$)/.test(u), 'root is not allowed')
    .optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
  memory: z
    .string()
    .regex(/^\d+[kmg]?$/i)
    .default('4g'),
  cpus: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .default('2'),
  /** Open files limit, like docker-compose `ulimits.nofile` (test suites can need many). */
  nofile: z.number().int().min(1024).max(1048576).optional(),
});
/**
 * Local security checks, run in throwaway containers after the tests. Only findings the change
 * introduces count (legacy code never blocks): the changed files are compared with the same
 * files at the base commit. Nothing is sent anywhere; Semgrep only downloads its rules.
 */
const checks = z
  .object({
    /** gitleaks: secrets; semgrep: code (SAST); osv: vulnerable dependencies (lockfiles). */
    tools: z.array(z.enum(['gitleaks', 'semgrep', 'osv'])).min(1),
    /**
     * Case-insensitive regex on repository paths limiting the code analysis (semgrep), e.g.
     * a team's module. Secrets are checked in every changed file.
     */
    scope: z
      .string()
      .refine((s) => {
        try {
          new RegExp(s);
          return true;
        } catch {
          return false;
        }
      }, 'invalid regex')
      .optional(),
    /** Semgrep registry rule sets, e.g. p/php, p/typescript. */
    semgrep: z
      .object({ configs: z.array(z.string().regex(/^(p|r)\/[A-Za-z0-9._/-]+$/)).min(1) })
      .optional(),
    /** false: findings are reported in the PR but never block the delivery. */
    blocking: z.boolean().default(true),
    /**
     * Tools whose findings are only reported, e.g. osv on a project where updating
     * dependencies is outside the team's scope.
     */
    reportOnly: z.array(z.enum(['gitleaks', 'semgrep', 'osv'])).default([]),
    images: z
      .object({
        gitleaks: image.default('ghcr.io/gitleaks/gitleaks:latest'),
        semgrep: image.default('semgrep/semgrep:latest'),
        osv: image.default('ghcr.io/google/osv-scanner:latest'),
      })
      .prefault({}),
  })
  .refine((c) => !c.tools.includes('semgrep') || !!c.semgrep, {
    message: 'semgrep needs semgrep.configs',
    path: ['semgrep'],
  });
const project = z
  .object({
    id: slug,
    host: slug,
    repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/, 'owner/name'),
    defaultBranch: z.string().min(1).max(200).default('main'),
    test: argv.min(1),
    prepare: argv.default([]),
    /**
     * Tracked files kept out of the agents' working copy (git sparse-checkout patterns, from the
     * repository root), e.g. credentials committed to the repository. They stay in the repository
     * and in every commit; the credential check ignores them.
     */
    hiddenFiles: z
      .array(
        z
          .string()
          .min(1)
          .max(300)
          .refine(
            (p) => !p.startsWith('!') && !p.startsWith('/') && !p.split('/').includes('..'),
            'relative path pattern',
          ),
      )
      .default([]),
    /** Where prepare/test run. Omitted: the bubblewrap sandbox (tests without network). */
    runner: dockerRunner.optional(),
    /**
     * Task branch name: {key} is the tracker key (PF-2436, #7), {id} the task id, {slug} the card
     * title in branch-safe words. Teams whose test environments come from branch names use their
     * own pattern, e.g. feature/{key} or {key}-{slug}.
     */
    branch: z
      .string()
      .regex(/^[A-Za-z0-9._/{}-]+$/, 'letters, digits, . _ / - and {key}/{id}/{slug}')
      .refine((b) => b.includes('{key}') || b.includes('{id}'), 'must contain {key} or {id}')
      .default('ai/task-{id}'),
    /** Never pushed to, whatever the pattern produces (the default branch is always included). */
    protectedBranches: z
      .array(z.string().min(1))
      .default(['main', 'master', 'develop', 'production', 'sandbox']),
    checks: checks.optional(),
    /** Extra rules for the agent in every prompt of this project (e.g. translations). */
    instructions: z.string().max(20000).optional(),
    pullRequest: z
      .object({
        /** Markdown file (absolute, or relative to tenants.yaml) with {{PLACEHOLDERS}}. */
        template: z.string().min(1).optional(),
        /** Test environment URL: {key}, {key_lower}, {branch}. */
        branchUrl: z.string().min(1).optional(),
        /** PR title: {key} and {title} (e.g. "{key} - {title}"); default "AI: <key> <title>". */
        title: z.string().min(1).max(200).optional(),
        /** Usernames asked to review, on hosts that support it (GitLab). */
        reviewers: z
          .array(z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, 'reviewer username'))
          .max(10)
          .default([]),
        /**
         * Whether comments by app/bot accounts (e.g. a pipeline's quality agent) count as review
         * input. Off by default: they are long, repeat on every pipeline run and reach beyond
         * the card.
         */
        botComments: z.boolean().default(false),
      })
      .prefault({}),
    /** Where the task's working copy lives: this machine (default) or a Coder workspace. */
    workspace: workspaceConfig,
    /**
     * rehearsal: the whole flow (agent, tests, review, local commit) without push or PR.
     * draft / normal: published (draft PR / PR).
     */
    delivery: z.enum(['rehearsal', 'draft', 'normal']).default('normal'),
    method: methodConfig,
    /** Overrides of the company formats for this project (field by field). */
    formats: formatsConfig,
    /**
     * Test evidence for audits: after a delivery of a method route the agent runs a Playwright script in
     * the workspace (official image of this version) and framed prints come back to the task.
     */
    evidence: z
      .object({
        playwright: z.string().regex(/^\d+\.\d+\.\d+$/, 'Playwright version, e.g. 1.48.2'),
        timeoutMinutes: z.number().int().min(5).max(120).default(30),
      })
      .optional(),
  })
  .superRefine((p, ctx) => {
    if (p.evidence && p.workspace.type !== 'coder')
      ctx.addIssue({ code: 'custom', message: 'evidence needs a coder workspace' });
    if (p.workspace.type !== 'coder') return;
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const w = p.workspace;
    if (p.runner) issue('coder workspace runs tests in the workspace; remove runner');
    if (w.protect.some((dir) => w.root === dir || w.root.startsWith(`${dir}/`)))
      issue(`coder root ${w.root} is inside a protected folder (protect)`);
  });
/**
 * codex / claude: the vendor CLIs (subscription login or API key).
 * openrouter: the Codex CLI pointed at OpenRouter (any model it serves); requires apiKey and
 * model. gemini: the Gemini CLI with a Google AI Studio key; requires apiKey and model.
 */
const provider = z.enum(['codex', 'claude', 'openrouter', 'gemini']);
const minutes = z.number().int().positive();
const modelName = z.string().regex(/^[A-Za-z0-9._:/-]+$/, 'model id');
/** Reasoning effort: Claude --effort; Codex model_reasoning_effort (max → xhigh). */
const effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const credential = z.object({
  id: slug,
  provider,
  /** Without apiKey the CLI uses the login stored in AGENT_HOME/<tenant>/<credential id>/. */
  apiKey: secret.optional(),
  /** Defaults for every role using this credential; a role entry may override them. */
  model: modelName.optional(),
  effort: effort.optional(),
  /** How long this credential is skipped after each kind of capacity failure. */
  cooldown: z
    .object({
      quotaMinutes: minutes.default(360),
      rateLimitMinutes: minutes.default(5),
      authMinutes: minutes.default(1440),
    })
    .prefault({}),
});
/** What an agent run is for; each role has its own credentials, models and effort. */
export const ROLES = ['coder', 'fixer', 'reviewer', 'planner', 'frontend'] as const;
const roleEntry = z
  .union([
    slug,
    z.object({ credential: slug, model: modelName.optional(), effort: effort.optional() }),
  ])
  .transform((e) => (typeof e === 'string' ? { credential: e } : e));
/**
 * Tried in order, with the same fallback as credentials. coder: implementation, revisions and
 * review fixes (default: every credential in order). fixer: fixing failing tests (default:
 * coder). reviewer: reviews the diff before the PR, read-only; enabled only when listed.
 * planner: plans cards without sub-tasks before the coder, read-only; enabled only when listed.
 * frontend: implements a card's Front-end section after the coder, in its own commit; enabled
 * only when listed.
 */
const roles = z
  .object(
    Object.fromEntries(ROLES.map((r) => [r, z.array(roleEntry).min(1).optional()])) as {
      [K in (typeof ROLES)[number]]: z.ZodOptional<z.ZodArray<typeof roleEntry>>;
    },
  )
  .default({});
const relative = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'relative path inside path');
/**
 * The company's AI harness (skills, subagents, instructions), e.g. a clone of its harness
 * repository. Read at every run, so a `git pull` there is picked up without restarts.
 */
const harness = z.object({
  path: z.string().refine((p) => p.startsWith('/'), 'absolute path'),
  /** Folders whose subfolders hold a SKILL.md each. */
  skills: z.array(relative).default([]),
  /** Folders with subagents: <name>/AGENT.md or <name>.md. */
  agents: z.array(relative).default([]),
  /** Markdown appended to the agent's instructions. */
  instructions: relative.optional(),
});
const tenant = z
  .object({
    id: slug,
    name: z.string().min(1),
    git: z.object({ authorName: z.string().min(1), authorEmail: z.string().min(3) }),
    harness: harness.optional(),
    /** Texts the company's tools expect: card sections, PR sections, test evidence. */
    formats: formatsConfig,
    /** The company pack folder (set by the pack loader): prompts and formats of the company. */
    packDir: z
      .string()
      .refine((p) => p.startsWith('/'), 'absolute path')
      .optional(),
    /** Figma personal access token (read-only): front phases read the card's design with it. */
    figma: z.object({ token: z.string().min(1) }).optional(),
    /** A method every project of the company must follow (a method name of the company pack). */
    requireMethod: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
    ai: z.object({
      /** Providers the company's contract allows to receive its code. */
      providers: z.array(provider).min(1),
      /** Tried in order; the next one takes over when tokens, quota or rate limit run out. */
      credentials: z.array(credential).min(1),
      roles,
      review: z
        .object({
          /** Review passes that may send the change back to the coder before the PR. */
          rounds: z.number().int().min(1).max(3).default(1),
        })
        .prefault({}),
      /**
       * What one task may spend on AI before it stops and asks to release one more share (as the
       * providers report cost). Without it, cost never stops a task.
       */
      budget: z.object({ perTaskUsd: z.number().positive() }).optional(),
    }),
    hosts: z.array(z.discriminatedUnion('type', [githubHost, bitbucketHost, gitlabHost])).min(1),
    sources: z
      .array(
        z.discriminatedUnion('type', [
          githubIssuesSource,
          jiraSource,
          bitbucketSource,
          businessmapSource,
        ]),
      )
      .default([]),
    projects: z.array(project).min(1),
  })
  .superRefine((t, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    for (const c of t.ai.credentials) {
      if (!t.ai.providers.includes(c.provider))
        issue(`credential "${c.id}" uses provider "${c.provider}", not in ai.providers`);
      if ((c.provider === 'openrouter' || c.provider === 'gemini') && (!c.apiKey || !c.model))
        issue(`credential "${c.id}": ${c.provider} requires apiKey and model`);
    }
    for (const [role, entries] of Object.entries(t.ai.roles))
      for (const e of entries ?? [])
        if (!t.ai.credentials.some((c) => c.id === e.credential))
          issue(`ai.roles.${role} references unknown credential "${e.credential}"`);
    for (const [kind, list] of [
      ['credential', t.ai.credentials],
      ['host', t.hosts],
      ['source', t.sources],
      ['project', t.projects],
    ] as const) {
      const ids = list.map((x) => x.id);
      for (const id of ids.filter((id, i) => ids.indexOf(id) !== i))
        issue(`duplicate ${kind} id "${id}"`);
    }
    if (t.sources.some((s) => s.id === API_SOURCE))
      issue(`source id "${API_SOURCE}" is reserved for the operator API`);
    for (const s of t.sources)
      if (s.type === 'jira')
        for (const target of [...Object.values(s.projects), s.defaultProject])
          if (target && !t.projects.some((p) => p.id === target))
            issue(`source "${s.id}" maps to unknown project "${target}"`);
    for (const p of t.projects)
      if (!t.hosts.some((h) => h.id === p.host))
        issue(`project "${p.id}" references unknown host "${p.host}"`);
    // The evidence comment template is read after the prints are taken: checked here, so a
    // missing file fails at startup instead of after every evidence run.
    for (const comment of [t.formats, ...t.projects.map((p) => p.formats)]
      .map((f) => f?.evidence?.comment)
      .filter((c): c is string => !!c)) {
      if (!t.packDir) {
        issue(`formats.evidence.comment "${comment}" needs the company pack (packDir)`);
        continue;
      }
      const path = resolve(t.packDir, comment);
      if (!path.startsWith(`${resolve(t.packDir)}/`))
        issue(`formats.evidence.comment "${comment}" fica fora do pacote`);
      else if (!existsSync(path))
        issue(`formats.evidence.comment: ${comment} não existe em ${t.packDir}`);
    }
    for (const p of t.projects) for (const problem of methodProblems(t.packDir, p)) issue(problem);
    if (t.requireMethod)
      for (const p of t.projects)
        if (p.method?.name !== t.requireMethod)
          issue(`project "${p.id}": the company requires method ${t.requireMethod}`);
    // Clone and push go over ssh with the workspace's key: an https host would send its token
    // into the company's workspace.
    for (const p of t.projects)
      if (p.workspace.type === 'coder' && t.hosts.find((h) => h.id === p.host)?.type !== 'gitlab')
        issue(`project "${p.id}": a coder workspace only works with a gitlab host (ssh)`);
    // The agent runs inside the workspace with the login stored there: nothing is mounted.
    if (t.projects.some((p) => p.workspace.type === 'coder')) {
      for (const c of t.ai.credentials)
        if (c.provider !== 'claude' || c.apiKey)
          issue(
            `credential "${c.id}": a company with a coder workspace only uses claude logged in inside the workspace (no apiKey)`,
          );
      if (t.harness) issue('harness is not supported with a coder workspace yet');
    }
  });
const file = z.object({ tenants: z.array(tenant).min(1) }).superRefine((f, ctx) => {
  const ids = f.tenants.map((t) => t.id);
  for (const id of ids.filter((id, i) => ids.indexOf(id) !== i))
    ctx.addIssue({ code: 'custom', message: `duplicate tenant id "${id}"` });
});
export type Tenant = z.infer<typeof tenant>;
export type TenantProject = Tenant['projects'][number];
export type TenantHost = Tenant['hosts'][number];
export type TenantSource = Tenant['sources'][number];
export type JiraSource = Extract<TenantSource, { type: 'jira' }>;
export type GithubIssuesSource = Extract<TenantSource, { type: 'github-issues' }>;
export type BusinessmapSource = Extract<TenantSource, { type: 'businessmap' }>;
export type AiProvider = z.infer<typeof provider>;
export type AiCredential = Tenant['ai']['credentials'][number];
export type AiRole = (typeof ROLES)[number];
export type AiEffort = z.infer<typeof effort>;
export type TenantHarness = NonNullable<Tenant['harness']>;
export type DockerRunnerConfig = z.infer<typeof dockerRunner>;
export type ChecksConfig = z.infer<typeof checks>;
export type CoderWorkspaceConfig = z.infer<typeof coderWorkspace>;
// Secrets stay in .env; the YAML only references them as ${NAME}.
function interpolate(value: unknown, env: NodeJS.ProcessEnv, path: string): unknown {
  if (typeof value === 'string')
    return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name: string) => {
      if (!env[name]) throw new Error(`tenants: ${path} references unset variable ${name}`);
      return env[name];
    });
  if (Array.isArray(value)) return value.map((v, i) => interpolate(v, env, `${path}[${i}]`));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolate(v, env, path ? `${path}.${k}` : k)]),
    );
  return value;
}
export function loadTenants(text: string, env: NodeJS.ProcessEnv = process.env): Tenant[] {
  return parseTenantsData(parse(text), env);
}
/** `{ tenants: [...] }` already read (tenants.yaml or packs): interpolated and validated. */
export function parseTenantsData(raw: unknown, env: NodeJS.ProcessEnv = process.env): Tenant[] {
  const parsed = file.safeParse(interpolate(raw, env, ''));
  if (!parsed.success)
    throw new Error(
      `tenants: invalid configuration\n${parsed.error.issues
        .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n')}`,
    );
  return parsed.data.tenants;
}
let cached: Tenant[] | undefined;
/** Values of the packs' secret variables (requires.yaml), redacted like tokens. */
let packSecrets: string[] = [];
/** The companies: from the packs in GUILDA_PACKS when set, otherwise from tenants.yaml. */
export function tenants(): Tenant[] {
  if (cached) return cached;
  const dirs = packDirs(process.env.GUILDA_PACKS);
  if (dirs.length) {
    const loaded = loadPacks(dirs);
    packSecrets = loaded.secrets;
    return (cached = loaded.tenants);
  }
  packSecrets = [];
  return (cached = loadTenants(
    readFileSync(resolve(process.env.TENANTS_FILE || 'tenants.yaml'), 'utf8'),
  ));
}
/** Replaces the loaded configuration; intended for tests. */
export function useTenants(list: Tenant[] | undefined) {
  cached = list;
  if (!list) packSecrets = [];
}
export function findTenant(id: string): Tenant | undefined {
  return tenants().find((t) => t.id === id);
}
/** Every credential of every tenant, so logs never leak one company's secret anywhere. */
export function tenantSecrets(): string[] {
  let list: Tenant[];
  try {
    list = tenants();
  } catch {
    return [];
  }
  return [
    ...packSecrets,
    ...list.flatMap((t) => [
      ...(t.figma ? [t.figma.token] : []),
      ...t.ai.credentials.map((c) => c.apiKey).filter((s): s is string => !!s),
      // Container variables that look like credentials (DB passwords, tokens) are masked too.
      ...t.projects.flatMap((p) =>
        Object.entries(p.runner?.env ?? {})
          .filter(([key, value]) => /PASS|SECRET|TOKEN|KEY/i.test(key) && value.length >= 4)
          .map(([, value]) => value),
      ),
      ...t.sources.flatMap((s) =>
        s.type === 'jira'
          ? [s.token, Buffer.from(`${s.email}:${s.token}`).toString('base64')]
          : s.type === 'businessmap'
            ? [s.token]
            : [s.webhookSecret],
      ),
      // Tokens plus every Basic-auth encoding a host adapter may put in a header.
      ...t.hosts.flatMap((h) =>
        [
          h.token,
          ...(h.type === 'github'
            ? [`x-access-token:${h.token}`]
            : h.type === 'gitlab'
              ? []
              : [
                  `x-token-auth:${h.token}`,
                  `x-bitbucket-api-token-auth:${h.token}`,
                  ...(h.email ? [`${h.email}:${h.token}`] : []),
                ]),
        ].map((value, i) => (i === 0 ? value : Buffer.from(value).toString('base64'))),
      ),
    ]),
  ];
}
