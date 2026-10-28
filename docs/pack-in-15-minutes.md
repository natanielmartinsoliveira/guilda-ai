# A company pack in 15 minutes

A pack is a private git repository with everything of one company for the Guilda AI: its code host, its projects, how they are built and tested, and what the agents learned on them. The core holds no company. This guide takes you from nothing to the first card.

## 1. Create the pack (1 minute)

```bash
npm run pack:init -- ~/guilda-packs/acme https://git.acme.test/shop/orders --name "Acme" [--coder https://coder.acme.test]
```

The URL is the company's first repository, as you copy it (https, `git@` or `ssh://`). It tells the host: GitHub, Bitbucket, or a GitLab server. With `--coder`, tasks run in each developer's Coder workspace and nothing is published until you ask (rehearsal). The pack is checked before it is written.

You get:

| File                   | What it is                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `company.yaml`         | The company: AI policy, host, `projectDefaults` (what every project shares) and the first project                  |
| `requires.yaml`        | What each developer fills in their own `.env`: name and e-mail on the commits, the host token, the Coder workspace |
| `stacks/node-npm.yaml` | An example stack: the `prepare`/`test` of a kind of project, with `{{placeholders}}`                               |
| `lessons/_all.md`      | Lessons for every project (the agents get them on every task)                                                      |
| `README.md`            | The next steps, for whoever opens the pack                                                                         |

## 2. Tell how the project is tested (5 minutes)

The first project starts with a `test` that fails on purpose: a task never passes without the project's tests. In `company.yaml`, either write the command:

```yaml
test: [sh, -c, 'docker run --rm --network none -v "$PWD":/app -w /app node:22 npm test']
```

or name a stack, adapting `stacks/node-npm.yaml` (or writing another, e.g. `stacks/php-docker.yaml`):

```yaml
stack: { name: node-npm }
```

Tests run without network. Put in `projectDefaults` whatever every project shares (the stack too: `stack: node-npm`), so each project keeps only what differs.

## 3. Publish it and set up your instance (5 minutes)

```bash
cd ~/guilda-packs/acme && git init && git add . && git commit -m "Acme pack" && git push <private repository>
cd <guilda-ai> && npm run setup     # give it the pack's git URL; it asks for the requires.yaml values
npm run doctor                      # checks the configuration and the tools
```

Every colleague does only this step, with the same pack URL.

## 4. More projects (1 minute each)

```bash
npm run project:add -- ~/guilda-packs/acme https://git.acme.test/shop/billing
```

It asks the host for the default branch and root files, picks the stack whose `detect` files the repository has, takes the workspace reference from the other projects, checks the pack and shows the short block before writing it.

## 5. The first card (3 minutes)

Start a task from the panel (**New task**), or connect a card source (Jira, Businessmap, GitHub Issues: [sources.md](sources.md)). Follow it in the task screen: metrics, decisions and, at the end, the draft PR (or the rehearsal to check in the workspace).

When something goes wrong and you answer it, the task screen suggests it as a lesson of the project: save it and commit the pack, so the next task (and your colleagues) already know.

More: [packs.md](packs.md) (every option of a pack), [methods.md](methods.md) (a company's own way of working), [coder.md](coder.md) (Coder workspaces).
