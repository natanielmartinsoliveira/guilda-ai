# Projects in a Coder workspace

For companies whose code **may not be on the operator's machine**. Guilda AI keeps running here (queue, stages, decisions, panel, Telegram), but the clone, the agent, the tests and the commit happen **inside the company's [Coder](https://coder.com) workspace**, through `coder ssh`.

## Requirements

1. **The company VPN on**, when Coder needs it (on Windows that is enough: WSL uses the Windows route). Test in WSL:
   `curl -s -o /dev/null -w '%{http_code}\n' https://<coder>/healthz` → `200`.
2. **Coder CLI logged in on WSL**, at the server's version:
   ```bash
   curl -fsSL -o ~/.local/bin/coder https://<coder>/bin/coder-linux-amd64 && chmod +x ~/.local/bin/coder
   ~/.local/bin/coder login https://<coder>
   ```
   When `coder` is not on the service's PATH, set it in `.env`: `CODER_BIN=/home/<user>/.local/bin/coder`.
3. **The workspace's git key in GitLab:** `coder publickey` prints the key Coder uses for git in every workspace; add it to your GitLab account (Preferences → SSH Keys). Without it, clone and push fail with "Could not read from remote repository".
4. **Claude logged in inside the workspace**, with the company account: open the workspace terminal (VS Code → Coder), run `claude` and `/login`. Guilda AI **never** copies credentials there nor brings them back.

## Configuration (company pack or `tenants.yaml`)

```yaml
hosts:
  - id: gitlab
    type: gitlab
    baseUrl: https://git.initech.example
    sshUrl: ssh://git@git.initech.example:2244 # the clone happens in the workspace, over ssh
    # The server's key (ssh-keyscan -p 2244 git.initech.example, without the host); check its
    # fingerprint with whoever runs the GitLab. Only this key is accepted, never a prompt.
    sshHostKey: ssh-ed25519 AAAA…
    token: ${INITECH_GITLAB_TOKEN}
projects:
  - id: orders
    host: gitlab
    repository: shop/orders
    defaultBranch: homolog
    branch: '{key}-{slug}' # e.g. 1234-fix-payment-options
    test: [make, test] # runs inside the workspace
    workspace:
      type: coder
      url: https://coder.initech.example
      name: ${INITECH_CODER_WORKSPACE} # each developer's workspace
      agent: main # optional
      root: /root/ai-dev-team # the tasks folder in the workspace (outside protect)
      reference: /workspaces/orders # optional: speeds up the clone (read-only)
      protect: [/workspaces] # default; the operator's clones the agent may not touch
    delivery: rehearsal # rehearsal (no push/MR) | draft (draft MR) | normal (MR)
    pullRequest:
      title: '{key} - {title}' # optional; default "AI: <card> <title>"
      reviewers: [${INITECH_GITLAB_USER}] # optional; GitLab users
```

Rules (an error when the configuration loads): `coder` works only with a `gitlab` host (clone and push over ssh with the workspace's key — an https host would take the token there); no `runner` (the `prepare`/`test` commands already run in the workspace — use `docker run` in them to test the task's copy); the company may only have `claude` credentials without `apiKey` and no `harness`; `root` absolute, without `..` and outside `protect`.

## What stays on this machine and what does not

- **Stays here:** the stage, short error messages, names of the changed files, the last 40 lines of the tests, the agent's final message and the automatic review's text.
- **Does not stay here:** the code, the diff (the reviewer reads the change in the workspace itself) and the commands' output (the audit keeps only the command, its duration, exit code and output size).
- Attachments and Figma prints are downloaded here (they are not the company's code) and **uploaded** to `<task folder>/.ai-dev-team/` in the workspace, outside git.

## Rehearsal mode

The whole flow runs (agent → tests → review → a **local** commit on the task branch) and ends as **"Rehearsal finished — nothing was published"**, with the path in the workspace (`<workspace>:<root>/<task>`), the branch, the commit and the files. Check it by opening the folder in Coder's VS Code. Then use **Discard rehearsal** on the task screen to remove the folder (also for `coder` tasks that failed or were cancelled; never for a running task).

**Start card again** (task screen, or `again: true` on `POST /api/tenants/:tenant/sources/:source/start`) gives the card a new task, on the route you pick: for a card whose last task ended and published nothing (a rehearsal without a draft PR, a failure, a cancellation). The earlier task stays in the history, marked as superseded with a link to the new one, and its workspace folder is discarded. A card with a PR/MR is never started again (ask for an adjustment or open a fix), and polls never do it: a card still in the trigger column keeps its task.

**Open draft PR** (task screen, or `promote_task` over MCP) publishes a checked rehearsal: on the current base branch, one commit with only the delivery's files (a method's `publish.exclude` paths left out), the company `git` identity and the PR title as message; then a push and a draft PR without reviewers. If the base branch changed the same files since the rehearsal, nothing is sent and the task fails saying so. The rehearsal's own commits stay in the folder under `refs/ai-dev-team/rehearsal/<task>`.

## Protections

- Your clones under `protect` (default `/workspaces`) are photographed before and after each agent run (HEAD, branch and `git status`). If they change, the task **fails** naming them — nothing is undone. If it was you editing in VS Code at the same time, just retry the task.
- A (read-only) reviewer that changes the task folder also fails the task.
- No command runs with its `cwd` in your clones; `reference` is only read by git (`--reference --dissociate`).

## Errors and what to do

| Message                                                | What to do                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Coder unreachable — is the VPN on?                     | Turn the VPN on; the task retries by itself.                                   |
| Workspace … stopped                                    | Guilda AI runs `coder start` itself; if it does not come up, it retries later. |
| Coder session expired                                  | Run `coder login <url>` in WSL and retry the task.                             |
| Claude not logged in in the workspace                  | Run `/login` in Claude inside the workspace and retry.                         |
| The agent changed repositories outside the task folder | Check the repositories named; retry.                                           |

## The repository's harness

In `coder` projects Claude runs with `--setting-sources user,project`: it uses each repository's `CLAUDE.md`, the skills and commands of `.claude/` and the enabled plugins, as when the team uses Claude in the workspace. MCP declared by the repository is still ignored (`--strict-mcp-config`).

## Security checks

`checks` works in `coder` projects: gitleaks, semgrep and osv run in the **workspace's** Docker, over the changed files (now and at the base commit). Only the rule, file, line and message come back; each finding's identity is a hash computed there. A finding that already existed at the base does not count.

## Change requests

- **In a rehearsal:** "Request change" on the task screen. The change runs in the same workspace folder and makes a new local commit; the rehearsal then points to it. Once discarded, it takes no more changes.
- **On a published MR (`draft`/`normal`):** comment `/ai <instructions>` on the MR (on a line of code, the file and line go along). Guilda AI reads the open MRs every `pollSeconds` (default 60) — an internal GitLab cannot call it. `allowedUsers` on the host limits who can trigger it.

## The company's method

A `coder` project can follow a company method (`method: { name: … }`) instead of the core's planner/coder/reviewer: phases, questions, gates and scripts defined in the company pack and run by the method engine. See [methods.md](methods.md).

## GitLab: publishing

- A GitLab token with the **`api`** scope in `.env`; API calls leave this machine (through the VPN, if any) carrying only metadata (title, description, comments).
- `delivery: draft` pushes **from inside the workspace** and opens the MR with the `Draft:` prefix (GitLab blocks the merge until someone removes it); `normal` opens a regular MR. An MR that already exists for the branch (open, merged or closed) is reused, never duplicated.
- `reviewers`: the users become the MR's reviewers; an unknown user stops the delivery with a clear error.
- MR review comments with `/ai <request>` (from `allowedUsers`) become a change of the task.

## Telegram

With Telegram on, every finished rehearsal (and every rehearsal change) sends: "🧪 Rehearsal finished — nothing was published", with the path in the workspace, the branch and the commit.

## Test evidence

With `evidence: { playwright: 1.48.2 }` in the project (Coder workspace only), every delivery of a method route with `evidence: true` gets the **"Generating test evidence"** step after the commit:

1. Guilda AI uploads the fixed kit to `.ai-dev-team/evidence/` of the task folder (outside git): `evidence-kit.cjs` (takes the print, masks `Authorization`/cookies/tokens and draws a frame with the **real URL** and the **date/time** in the time zone of `formats.evidence.timezone`) and `run.sh` (runs the official `mcr.microsoft.com/playwright:v<version>-noble` image on the workspace's network).
2. The AI starts the system with a throwaway database, creates the test data, writes `roteiro.cjs` using only the kit (`shot` for a screen, `apiShot` for an API route in Swagger style) and runs it until the prints show the result.
3. Guilda AI checks `manifest.json`, downloads the prints and the Playwright trace, removes the kit folder and builds the comment in the company's format (`formats.evidence.comment`, see [packs.md](packs.md)).
4. If the AI does not reach the result (or the manifest does not hold), the task stops at a decision; your answer (for example "use order X") guides the next try. The options are **Try again**, the AI's own suggestions and **Go on without evidence** (a delivery with nothing to show, such as unit tests only: the task finishes with no prints).

On a project with a method, the evidence agent runs with what the method's agent has: its `env` (e.g. the project's runtime on the `PATH`), `agent.addDirs` and `agent.allowedTools`.

In the panel, the task shows the prints, a **Copy comment** button and **Download trace**; Telegram says how many prints there are. `run.sh` installs the `playwright` package from npm on every run: the workspace must reach npm.

## Limitations

No Guilda AI `harness` (the harness is the repository's own).
