# Company packs

Instead of one `tenants.yaml` holding every company, each company can have a **pack**: a folder (ideally a private git repository of the company) its developers share.

```
<pack>/
  company.yaml    the company, in the same shape as an item of `tenants:`
  requires.yaml   what each developer must provide (in their own .env)
  README.md
  prompts/        optional: the company's own prompts
  formats/        optional: the company's own texts (evidence comment, PR template)
  methods/        optional: the company's way of working (docs/methods.md)
  setup.yaml      optional: baseline scripts offered by `npm run setup`
```

Complete example: [`examples/packs/acme/`](../examples/packs/acme/).

## requires.yaml

```yaml
- name: ACME_CODER_WORKSPACE
  description: Name of your Coder workspace (shown by coder list)
  example: dev-pat
- name: ACME_BOARD_TOKEN
  description: API token of the card board
  secret: true
```

- Every `${VARIABLE}` used in `company.yaml` must be declared here.
- `secret: true`: the value is hidden in logs, and `npm run setup` asks for it without echoing.
- `default`: used when the developer does not set the variable.
- With a value missing, the instance **does not start** and lists, per pack, what is missing and what it is for.
- Relative paths in `harness.path` and `pullRequest.template` point inside the pack.

## Using packs

`npm run setup` clones the packs and fills your `.env`. By hand, in your instance's `.env`:

```
GUILDA_PACKS=/home/you/guilda-packs/company-a:/home/you/guilda-packs/company-b
COMPANY_A_GIT_EMAIL=you@company-a.example
…
```

With `GUILDA_PACKS` set, the packs replace `TENANTS_FILE`. Without it, nothing changes.

## Migrating from a tenants.yaml

1. Create one pack per company and replace personal values and secrets with `${…}` declared in `requires.yaml`.
2. Compare: `npm run packs:compare -- /path/a:/path/b` loads `TENANTS_FILE` and the packs with the same environment and says **Identical** or the first place that differs (never the value). PR templates count by content: moving them into the pack is not a difference.
3. Only with **Identical**, put `GUILDA_PACKS` in `.env`.

## The company's prompts

Any core prompt (`prompts/*.md`: `coder.md`, `fixer.md`, `code-review.md`, `pr-sections.md`, `back-only.md`, `evidence.md`, …) can be replaced by the pack:

```
<pack>/prompts/<name>.md            for every project of the company
<pack>/prompts/<project>/<name>.md  for that project only
```

The first one that exists wins (project → pack → core). The `{{PLACEHOLDERS}}` are those of the core prompt; unknown ones stay as they are.

## What the projects share: projectDefaults

A company's projects usually share most of their settings (the workspace, the method, the checks, the pull request). Write them once in `projectDefaults` and keep in each project only what differs:

```yaml
projectDefaults:
  host: gitlab-acme
  branch: '{key}-{slug}'
  checks: { tools: [gitleaks, semgrep, osv] }
  workspace:
    { type: coder, url: https://coder.acme.test, name: '${ACME_WS}', root: /workspaces/ai-dev-team }
  method: { name: review-gate, options: { pythonPath: /workspaces/.ai-dev-team/pylib } }
projects:
  - {
      id: orders,
      repository: shop/orders,
      defaultBranch: homolog,
      test: [make, test],
      workspace: { reference: /workspaces/orders },
    }
```

Mappings merge key by key (the project's `workspace.reference` joins the default workspace, a project's `method.options` join the default options); lists and plain values are the project's when it has them. Each project is then validated as if it had been written whole.

## Lessons

What the company learned running a project's tasks lives in the pack, so the team shares it through git: `lessons/<project>.md` for one project and `lessons/_all.md` for every project, one `- ` line per lesson. Every agent prompt of that project receives them (the newest that fit 8 KB). A method's prompts place them with `{{#LESSONS}}…{{LESSONS}}…{{/LESSONS}}`; `method:check` renders without them.

**Save as lesson** on the task screen (prefilled with the task's failure) appends one to the project's file, uncommitted, with the card and the date: review it, then commit and push the pack.

**Automatic suggestions.** The system notices lessons on its own: a stop of a method's agent the operator answered (the problem, then the answer) is suggested at once; a final failure is counted per project, with ids, numbers, paths and `quoted` names left out, and suggested once the same one happens 3 times. Suggestions stay in the database until the operator rules on them in the task screen's **Project lessons**: **Save** writes the (editable) text into the pack like any lesson, **Dismiss** keeps it from coming back. Nothing reaches the prompts without that step.

## Formats

In `formats:` of `company.yaml` (and, for one project, in the project's `formats:`, field by field):

```yaml
formats:
  card: # sections of the card
    frontTitles: [front-end] # titles that open the screen part
    endTitles: [acceptance criteria] # titles that close it
    nothing: [not applicable] # phrases meaning "no screen"
  pullRequest:
    sections: # what the AI writes for the PR template (<tag> → {{PLACEHOLDER}})
      - { tag: problem, placeholder: PROBLEM, ask: 'the problem', fallback: card }
      - { tag: translations, placeholder: TRANSLATIONS, ask: 'Yes / Not applicable', kind: check }
  evidence:
    comment: formats/evidence.md # inside the pack; {{SHOTS}} = the prints
    shot: "{{N}}. {{TITLE}} — {{URL}} — {{AT}}\n[image {{FILE}}]"
    timezone: America/Sao_Paulo # time zone of the print stamp (default UTC)
```

- Case and accents do not matter in card titles and phrases.
- `fallback: card` uses the beginning of the card; `kind: check` becomes ✅ ("Yes…"), ➖ ("Not applicable") or ⬜.
- Without `formats`, the core defaults apply: card with generic terms (pt/en), PR with problem/solution/how to test, a neutral evidence comment in UTC.
- The example pack has one prompt and the three formats: [`examples/packs/acme/`](../examples/packs/acme/).

## setup.yaml (optional)

Scripts the company recommends on every developer machine (an SDK, a CLI). `npm run setup` describes each one and runs it only after the developer confirms:

```yaml
scripts:
  - run: scripts/install-board-cli.sh
    description: Installs the board CLI used by the team
```
