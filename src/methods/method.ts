import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { TenantProject } from '../tenants/tenants';
// Deliberately independent from config.ts (the tenants loader validates methods with it).
/** A path inside the method folder (prompts/, hooks/): never absolute, never "..". */
const inside = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'path inside the method');
const label = z.union([z.string().min(1), z.record(z.string(), z.string().min(1))]);
const route = z.object({
  label,
  /** method (default): the method's phases, starting here. standard: the core's own flow. */
  flow: z.enum(['method', 'standard']).default('method'),
  start: z.string().optional(),
  /** Test evidence after the delivery, when the project asks for it. */
  evidence: z.boolean().default(false),
  /** The project's tests and checks after the delivery. */
  tests: z.boolean().default(true),
  /** At the end, a commit of exactly the files the route changed, with this message. */
  finish: z.object({ commit: z.string().min(1) }).optional(),
  /** Placeholders of this route's prompts. */
  vars: z.record(z.string().regex(/^[A-Z_]+$/), z.string()).default({}),
  /** standard flow: hooks run before the agent, and a text appended to its prompt. */
  before: z.array(inside).default([]),
  append: inside.optional(),
});
const next = z.union([z.string().min(1), z.record(z.string(), z.string().min(1))]);
const step = z.union([
  z.object({ require: z.object({ var: z.string().min(1), message: z.string().min(1) }) }).strict(),
  z.object({ discard: z.string().min(1) }).strict(),
  z.object({ agent: inside, answersTo: z.enum(['answers', 'notes']).default('answers') }).strict(),
  z
    .object({ within: z.object({ path: z.string().min(1), question: inside, option: inside }) })
    .strict(),
  z
    .object({
      ask: z.object({
        question: inside,
        option: inside,
        files: z
          .object({ path: z.string().min(1), routes: z.array(z.string()).optional() })
          .optional(),
        chosen: z.object({
          commit: z
            .object({
              paths: z.array(z.string().min(1)).min(1),
              message: z.string().min(1),
              routes: z.array(z.string()).optional(),
            })
            .optional(),
          next,
        }),
        other: z.object({ next }),
      }),
    })
    .strict(),
  z.object({ hook: inside }).strict(),
]);
export type MethodStep = z.infer<typeof step>;
const methodFile = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    /** coder: runs only in a Coder workspace (its hooks run there). */
    workspace: z.enum(['coder', 'any']).default('any'),
    options: z
      .record(
        z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
        z.object({ default: z.string().optional(), required: z.boolean().default(false) }),
      )
      .default({}),
    env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string()).default({}),
    timeoutMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(60),
    /** method: the method commits its own work (anything left over is a failure). */
    commits: z.enum(['method', 'core']).default('core'),
    /** refuse: an adjustment request on a task of the method is refused. */
    revisions: z.enum(['allow', 'refuse']).default('allow'),
    /** telemetry: after the phases; its JSON (MethodTelemetry) is kept on the task. */
    hooks: z
      .object({
        prepare: inside.optional(),
        advance: inside.optional(),
        telemetry: inside.optional(),
      })
      .default({}),
    /**
     * What the method's agent needs with nobody to approve it: folders it may read besides the
     * task folder (absolute, or "~/…" in the workspace HOME, e.g. its skills' plugin cache) and
     * the tools/commands it may run (Claude permission rules, e.g. "Bash(git status:*)").
     */
    agent: z
      .object({
        addDirs: z
          .array(
            z
              .string()
              .regex(/^(~\/|\/)[A-Za-z0-9._/-]*$/, 'addDirs: "~/dir" or "/dir"')
              .refine((d) => !d.split('/').includes('..'), 'addDirs: no ".."'),
          )
          .default([]),
        allowedTools: z
          .array(
            z
              .string()
              .regex(/^[A-Za-z]+(\([^()\n\r,]*\))?$/, 'allowedTools: "Tool" or "Tool(rule)"'),
          )
          .default([]),
        /** Keep the CLI's session transcripts (the method's own tools read them, e.g. telemetry). */
        sessions: z.boolean().default(false),
      })
      .default({ addDirs: [], allowedTools: [], sessions: false }),
    messages: z.record(z.string(), z.string()).default({}),
    /** A promoted rehearsal publishes the delivery without these paths (the method's own). */
    publish: z.object({ exclude: z.array(z.string().min(1)).default([]) }).default({ exclude: [] }),
    routes: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), route),
    phases: z.record(
      z.string().regex(/^[a-z][a-z0-9-]*$/),
      z.object({
        steps: z.array(step).min(1),
        next: next.optional(),
        /** The step of the card this phase stands for on the board (sources with `moves`). */
        board: z.enum(['gate', 'building']).optional(),
      }),
    ),
  })
  .superRefine((m, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (!Object.keys(m.routes).length) issue('a method needs at least one route');
    const phases = new Set([...Object.keys(m.phases), 'done']);
    for (const [id, r] of Object.entries(m.routes))
      if (r.flow === 'method' && (!r.start || !phases.has(r.start)))
        issue(`route "${id}": start must be one of its phases`);
    const targets = (n: z.infer<typeof next> | undefined) =>
      n === undefined ? [] : typeof n === 'string' ? [n] : Object.values(n);
    for (const [id, p] of Object.entries(m.phases)) {
      for (const t of targets(p.next))
        if (!phases.has(t)) issue(`phase "${id}": next "${t}" is not a phase`);
      for (const s of p.steps)
        if ('ask' in s)
          for (const t of [...targets(s.ask.chosen.next), ...targets(s.ask.other.next)])
            if (!phases.has(t)) issue(`phase "${id}": next "${t}" is not a phase`);
    }
  });
export type Method = z.infer<typeof methodFile> & { dir: string };
export type MethodRoute = z.infer<typeof route>;
const cache = new Map<string, Method>();
/** methods/<name>/method.yaml of the company pack, validated (cached per folder). */
export function loadMethod(packDir: string, name: string): Method {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`invalid method name "${name}"`);
  const dir = resolve(packDir, 'methods', name);
  const cached = cache.get(dir);
  if (cached) return cached;
  const file = join(dir, 'method.yaml');
  if (!existsSync(file)) throw new Error(`method "${name}" not found in ${packDir}/methods`);
  const parsed = methodFile.safeParse(parse(readFileSync(file, 'utf8')));
  if (!parsed.success)
    throw new Error(
      `method "${name}": ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  const method = { ...parsed.data, dir };
  cache.set(dir, method);
  return method;
}
/** Forget loaded methods (tests write method folders). */
export function clearMethods() {
  cache.clear();
}
export function routeOf(method: Method, id: string): MethodRoute {
  const r = Object.hasOwn(method.routes, id) ? method.routes[id] : undefined;
  if (!r) throw new Error(`route "${id}" is not a route of method ${method.name}`);
  return r;
}
/** Routes for the operator: id and label in the instance language. */
export function methodRoutes(method: Method, language: string) {
  return Object.entries(method.routes).map(([id, r]) => ({
    id,
    label: typeof r.label === 'string' ? r.label : (r.label[language] ?? Object.values(r.label)[0]),
  }));
}
/** {{workspace.reference}}-style values from the project. */
export function projectValue(text: string, project: Pick<TenantProject, 'workspace'>) {
  return text.replace(/\{\{workspace\.reference\}\}/g, () =>
    project.workspace.type === 'coder' ? (project.workspace.reference ?? '') : '',
  );
}
/** The project's option values, defaults filled from the project. */
export function methodOptions(
  method: Method,
  project: Pick<TenantProject, 'workspace' | 'method'>,
): Record<string, string> {
  const given = project.method?.options ?? {};
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(method.options)) {
    const value = given[name] ?? (spec.default ? projectValue(spec.default, project) : '');
    if (value) out[name] = value;
  }
  return out;
}
/** Problems of a project's method configuration (empty when it is fine). */
export function methodProblems(
  packDir: string | undefined,
  project: Pick<TenantProject, 'workspace' | 'method' | 'id'>,
) {
  if (!project.method) return [];
  if (!packDir)
    return [
      `project "${project.id}": method ${project.method.name} needs the company pack (packDir)`,
    ];
  let method: Method;
  try {
    method = loadMethod(packDir, project.method.name);
  } catch (error) {
    return [`project "${project.id}": ${error instanceof Error ? error.message : String(error)}`];
  }
  const problems: string[] = [];
  for (const name of Object.keys(project.method.options))
    if (!Object.hasOwn(method.options, name))
      problems.push(`project "${project.id}": method ${method.name} has no option "${name}"`);
  const values = methodOptions(method, project);
  for (const [name, spec] of Object.entries(method.options))
    if (spec.required && !values[name])
      problems.push(`project "${project.id}": method ${method.name} needs option "${name}"`);
  if (method.workspace === 'coder' && project.workspace.type !== 'coder')
    problems.push(`project "${project.id}": method ${method.name} runs in a coder workspace`);
  return problems;
}
const tokens = z.number().int().nonnegative();
/**
 * What a method's telemetry hook reports: per agent of the method, how many runs, how many of
 * them it could measure, their time and tokens.
 */
export const methodTelemetry = z.object({
  agents: z.record(
    z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/),
    z.object({
      runs: tokens,
      measured: tokens,
      durationMs: z.number().nonnegative(),
      input: tokens,
      output: tokens,
      cacheCreation: tokens,
      cacheRead: tokens,
    }),
  ),
  /** Where the method's own reports are, in the task folder. */
  reports: z.array(z.string().max(300)).max(50).default([]),
});
export type MethodTelemetry = z.infer<typeof methodTelemetry>;
