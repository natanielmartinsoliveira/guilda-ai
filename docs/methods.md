# Company methods

A project can follow a **method** of its company instead of the core flow (the core's planner, coder and reviewer). The method lives in the company pack, in `methods/<name>/`, and the core's engine runs it. Nothing of the method is in the code.

```yaml
# company.yaml (project)
method: { name: my-method, options: { pythonPath: /opt/py } }
# and, when the company requires every project to use it:
requireMethod: my-method
```

## Method folder

```
methods/<name>/
  method.yaml     routes, phases, rules, environment
  prompts/*.md    prompts and questions (in the company's language)
  hooks/*.py|sh   scripts that run in the task's workspace
  tests/          cases checked by npm run method:check
```

## method.yaml

```yaml
name: my-method
workspace: coder # coder: runs only in a Coder workspace (the scripts run there); any: anywhere
options: # what each project may/must provide
  configFrom: { default: '{{workspace.reference}}', required: true }
env: # environment of the agent and the scripts (an empty value is not passed)
  GIT_AUTHOR_NAME: '{{git.name}}'
  PYTHONPATH: '{{options.pythonPath}}'
timeoutMinutes: 240
commits: method # method: the method commits; files left over at the end are a failure
revisions: refuse # refuse: a change request on a task of the method is refused
agent: # what the method's agent needs with nobody to approve it
  addDirs: ['~/.claude/plugins'] # folders it may read ("~/" = the workspace HOME)
  allowedTools: ['Bash(python3 -B:*)', 'Bash(git status:*)'] # Claude permission rules
hooks:
  prepare: hooks/prepare.py # every run, after the branch is prepared
  advance: hooks/advance.py # when a rehearsal finishes
messages: # the method's error texts
  noRoute: '…'
routes:
  feature:
    label: { en: 'New feature', pt-BR: 'Funcionalidade nova' }
    start: spec # first phase
    evidence: true # test evidence step (when the project has evidence)
    tests: true # the project's tests and checks at the end (default)
    vars: { ROUTE_NAME: 'new feature' } # placeholders of this route's prompts
  cleanup:
    label: …
    start: gate
    finish: { commit: 'cleanup {{slug}}' } # a commit at the end, of the changed files only
  direct:
    label: …
    flow: standard # the core flow, with:
    before: [hooks/direct.py]
    append: prompts/direct-rule.md
phases:
  spec:
    steps:
      - require: { var: spec_root, message: noSpecRoot }
      - discard: '{{vars.spec_root}}'
      - agent: prompts/specify.md
        answersTo: notes
      - within:
          {
            path: '{{vars.spec_root}}',
            question: prompts/outside-question.md,
            option: prompts/outside-option.md,
          }
    next: gate
  gate:
    steps:
      - ask:
          question: prompts/gate-{{route}}.md
          option: prompts/authorization-{{route}}.md
          files: { path: '{{vars.spec_root}}', routes: [feature] }
          chosen:
            commit: { paths: ['{{vars.spec_root}}'], message: 'spec {{slug}}', routes: [feature] }
            next: deliver
          other: { next: { feature: spec, default: gate } }
  deliver:
    steps:
      - agent: prompts/deliver-{{route}}.md
    next: done
```

## Steps

| Step      | Does                                                                                                                                                                                                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `require` | An empty variable → fails with the given message.                                                                                                                                                                                                                                       |
| `discard` | Discards changes and new files under the path.                                                                                                                                                                                                                                          |
| `agent`   | Runs the agent with the prompt; only `<resultado>concluido</resultado>` counts as done. Anything else becomes the question `prompts/stop-question.md` (`{{PENDING}}`, option `prompts/stop-option.md`); the answer goes to `answersTo` (`answers` or `notes`) and the phase runs again. |
| `within`  | Pending files outside the path become a question; the answer goes to `notes` and the phase runs again.                                                                                                                                                                                  |
| `ask`     | A question with one option. The chosen option (identical text) becomes `{{AUTHORIZATION}}`, makes the `commit` of `chosen` and goes to `next`; any other text goes to `notes` and to `other.next` (per route, with `default`).                                                          |
| `hook`    | Runs a script of the method.                                                                                                                                                                                                                                                            |

## Prompts

- `prompts/x-{{route}}.md` is the route's own; when it does not exist, `prompts/x.md` applies.
- Placeholders: `{{MATERIAL}}` (the card), `{{SLUG}}`, `{{ROUTE}}`, `{{AUTHORIZATION}}`, `{{NOTES}}`, `{{ANSWERS}}`, `{{FILES}}`, `{{PENDING}}` and the route's `vars`.
- Lists become `- item` lines. `{{#NOTES}}…{{/NOTES}}` appears only when there are items; `{{^FILES}}…{{/FILES}}` only when there are none.
- The tags the engine reads (`<resultado>`, `<pendencias>`) are the same in every language.

## Scripts (hooks)

- They run in the task folder in the workspace, with `python3` (`.py`) or `sh`, with the method's `env` and git's safety settings (no git hooks, no global config, no prompts).
- They get a JSON on stdin: `first`, `taskId`, `project`, `slug`, `route`, `root` (the tasks folder), `options` and `vars`.
- The last stdout line, when it is a JSON object, becomes `{{vars.*}}`. A non-zero exit stops the task with the script's message.

## Checking a method: `method:check`

In the method's `tests/` folder, YAML cases render the prompts through the engine and compare them with the expected text, and `tests/test_*.py` test the scripts with real git:

```yaml
# methods/<name>/tests/prompts.yaml
slug: 1234-order-discount
material: 'Card: ...'
cases:
  - {
      name: gate (feature),
      route: feature,
      prompt: 'prompts/gate-{{route}}.md',
      expect: expected/gate-feature.txt,
      values: { FILES: [] },
    }
```

```bash
npm run method:check -- <pack folder> <method>
```

With no case at all the command fails (a method without tests never passes silently).

## Example

The example method [`test/fixtures/methods/review-gate/`](../test/fixtures/methods/review-gate/) uses all of the above: three phases (specification → gate → delivery), six routes (one in the core flow), scripts that prepare and advance an accumulated specification, prompts that quote the gate's words literally, and the `method:check` tests. Copy the folder into `methods/<name>/` of your pack to start.
