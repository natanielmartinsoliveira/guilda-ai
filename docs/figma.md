# Front-end phase (Figma)

When a Jira card has a **Front-end** section in its acceptance criteria and the company has the `frontend` role, the task runs in three parts, on the same branch and with a single PR:

1. **Design**: the Figma link (with `node-id`) of the sub-task, of the operator's answers or of the story is read; each screen becomes an image in `figma/`, with `figma/index.md` (names and texts of all screens). The 8 screens most related to the front-end part go to the agent as images. Without a link, the attached prints apply. With nothing, the task stops and asks (before spending AI).
2. **Back-end**: the `coder` role does everything except the Front-end section. Commit `… (back-end)`.
3. **Front-end**: the `frontend` role does the Front-end section, with the design. Commit `… (front-end)`.

Then: tests, security checks and the automatic review over the whole change.

## Configuration

```yaml
ai:
  roles:
    frontend: [chatgpt, claude-max]   # Codex first
figma:
  token: ${FIGMA_TOKEN}               # personal token, read-only
```

Without `frontend`, nothing changes. The token lives only in `.env` and is hidden in logs.

## Check a design without spending AI

```bash
npm run design:check -- acme "<Figma link with node-id>" "<text of the front-end part>"
```

Shows the folder with the images and the beginning of `index.md`, or the question the task would ask.

## Starting a sub-task on its own

On **New task → Source card**, the key of a sub-task (a company with `subtasks: branch-per-subtask`) shows **"Start from"**: the story branch and the branches of the other sub-tasks that already exist in the repository. The sub-task gets its own branch from the chosen one, the PR goes to the story branch, the story's text and prints go along as context (its Figma link too), and the other sub-tasks are not touched. If the sub-task's branch already exists, it is not started.
