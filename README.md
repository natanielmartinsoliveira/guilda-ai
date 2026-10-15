# Guilda AI

A self-hosted AI development team for one developer working for several companies. Cards come in (Jira, Businessmap, GitHub Issues, the panel or VS Code), an isolated agent (Claude Code, Codex, Gemini or OpenRouter models) implements them, the project's tests, security checks and an AI review run, and a draft PR/MR opens on GitHub, Bitbucket or GitLab. It never merges.

Each developer runs **their own instance**. Everything that belongs to a company — hosts, card sources, projects, AI policy, prompts, PR and evidence formats, even its own way of working — lives in a **company pack**: a private git repository the company's developers share. The core has no company in it.

> Documentação em português: [docs/pt-BR/guide.md](docs/pt-BR/guide.md).

## How it works

```
 card source            Guilda AI (your machine)                      code host
 ───────────            ─────────────────────────                     ─────────
 Jira / Businessmap ─┐   API (NestJS) ── PostgreSQL (state, outbox)
 GitHub Issues ──────┼─▶   │                  │
 panel / VS Code ────┘     ▼                  ▼
                         RabbitMQ ──▶ worker ──▶ agent in a sandbox (bubblewrap)
                                        │        or in the company's Coder workspace
                                        ├─▶ project tests (container) + security checks
                                        ├─▶ AI review (another model, read-only)
                                        └─▶ commit ──▶ push ──▶ draft PR/MR ──▶ GitHub / Bitbucket / GitLab
                                        ▲
 you: panel (/app), Telegram, VS Code (MCP) — answer questions, retry, request changes
```

- **Decisions, not guesses.** When the AI has a question, or a task fails, the task waits for you in the panel, on Telegram or in VS Code; your answer resumes it.
- **Many AI credentials, one policy per company.** Providers the company's contract allows, roles (planner, coder, fixer, reviewer, frontend), and automatic fallback when a credential runs out.
- **Company methods.** A company can replace the core flow with its own phases, gates and scripts ([docs/methods.md](docs/methods.md)), checked by `npm run method:check`.
- **Code that may not leave the company** runs in the company's [Coder](https://coder.com) workspace; only metadata comes back ([docs/coder.md](docs/coder.md)).

## Quick start

Requirements: Linux or WSL2 with working user namespaces and [bubblewrap](https://github.com/containers/bubblewrap), Node.js 22+, Git, Docker Compose v2, and the agent CLIs you will use (`claude`, `codex`, `gemini`) installed under `/usr` or `/usr/local`. Run the worker as a **non-root** user on a dedicated machine or VM.

```bash
git clone https://github.com/<you>/guilda-ai.git && cd guilda-ai
npm ci
docker compose up -d             # PostgreSQL and RabbitMQ
npm run setup                    # language, company packs, the values each pack needs (.env)
npm run migration:run
npm run build && npm run build:web
npm run web:password             # the panel's password
npm run start:all                # API + worker (or: npm run services:install)
```

`npm run setup` asks for your language, clones the company packs you were given (git URLs or folders) into `~/guilda-packs/`, asks for every value the packs require (secrets without echo; in your existing `.env` only the keys it asks for are added or updated), offers the packs' baseline scripts, and loads everything to show what it found. Without packs, copy [`tenants.example.yaml`](tenants.example.yaml) to `tenants.yaml` and edit it.

Then log in each AI credential (subscriptions) or put its API key in `.env`, and open `https://<your domain>/app/`. The [pt-BR guide](docs/pt-BR/guide.md) walks through CLIs, credentials, webhooks, services and troubleshooting in detail.

## Documentation

| Topic                                               |                                        |
| --------------------------------------------------- | -------------------------------------- |
| Company packs, prompts and formats                  | [docs/packs.md](docs/packs.md)         |
| Company methods and `method:check`                  | [docs/methods.md](docs/methods.md)     |
| Card sources (Jira, Businessmap, GitHub, Bitbucket) | [docs/sources.md](docs/sources.md)     |
| Coder workspaces, GitLab, test evidence             | [docs/coder.md](docs/coder.md)         |
| Panel and the Guild office                          | [docs/panel.md](docs/panel.md)         |
| Front-end phase with Figma                          | [docs/figma.md](docs/figma.md)         |
| Languages (pt-BR, en)                               | [docs/languages.md](docs/languages.md) |
| Everything else, in Portuguese                      | [docs/pt-BR/](docs/pt-BR/)             |

An example pack lives in [`examples/packs/acme/`](examples/packs/acme/) and an example method in [`test/fixtures/methods/review-gate/`](test/fixtures/methods/review-gate/).

## Security model

- Each task gets its own clone. Bubblewrap mounts the runtime read-only, exposes only that workspace and keeps `.git` read-only for the AI and the tests; the host home, the application's `.env` and other workspaces stay outside. Project tests run without network.
- Commands run with argument arrays (`shell: false`), a minimal environment, timeouts and output limits. Git hooks and credential helpers are disabled; pushes use a fixed SHA and explicit ref, never force. Changes to secrets, symlinks, CI workflows and agent configuration are refused.
- Secrets live only in `.env` and are redacted from logs and stored output.
- There is **no egress proxy and no CPU/memory/disk quota**: do not use it as an open executor for untrusted code.

Before publishing anything from your instance, `npm run public:check` scans the files for the names of your companies (taken from your packs, `tenants.yaml`, `.env` and an optional `.public-deny`) without ever printing them whole.

## Development

```bash
npm test                 # backend (Jest)
npm --prefix web test    # panel (Vitest)
npm run lint
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). The office art is Kenney's "Tiny Dungeon" and "Tiny Town" (CC0), downloaded by `scripts/office-assets.sh`.
