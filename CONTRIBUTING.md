# Contributing

Thanks for helping. Issues and pull requests are welcome in English or Portuguese.

## Ground rules

- **No company in the core.** Anything specific to a company — names, hosts, boards, field ids, tags, prompts, formats, ways of working — belongs in a company pack ([docs/packs.md](docs/packs.md)), never in `src/`, `prompts/`, `web/`, tests or docs. Tests and examples use fictitious companies (Acme, Initech, Globex, …) and `*.example` hosts. Run `npm run public:check` before opening a PR. `npm test` guards the same rule without the packs (`test/core-generic.spec.ts`): every domain in the core must be a vendor's, a tool's or an example's, and a stack's words (php, laravel, vue, mysql…) appear only where the test lists a generic reason; a company's stack goes in its pack (`stacks/`, `methods/`).
- **Behaviour is tested.** Write the failing test first; keep the whole suite green (`npm test`, `npm --prefix web test`, `npm run lint`). Tests never call real AI, hosts or boards.
- **Both languages.** A new panel or server text needs its key in `pt-BR` and `en` (`web/src/i18n/`, `src/i18n/`); a changed core prompt needs its `prompts/en/` counterpart with the same tags and placeholders. Tests check both.
- **Security first.** Commands as argument arrays (`shell: false`), secrets only from `.env`, nothing written outside the task workspace, nothing pushed by force. Changes to the sandbox or to what the agent may touch need a clear reason in the PR.
- **Card sources stay polite.** A source that cannot write back (or is configured read-only) never writes: no move, no comment, no attachment.

## Layout

```
src/            API, worker, sources, hosts, agents, method engine (NestJS)
web/            the panel (React + Vite)
prompts/        core prompts (pt-BR), prompts/en/ (English)
examples/packs/ an example company pack
test/           Jest tests; test/fixtures/methods/review-gate is the example method
docs/           English docs; docs/pt-BR/ Portuguese docs and the operator guide
```

## Methods

A company method is data plus scripts in its pack ([docs/methods.md](docs/methods.md)). Engine changes must keep the example method's checks green:

```bash
npm run method:check -- test/fixtures review-gate
```
