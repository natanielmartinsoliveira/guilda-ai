# Languages

Each developer picks the language of their own instance in `.env`:

```
GUILDA_LANG=pt-BR   # default
GUILDA_LANG=en
```

Any value other than `pt-BR` or `en` stops the instance from starting.

## What changes

- **Panel:** every screen, including the login screen and the Guild office. The language comes from the server (`/web-api/me`), so there is no per-browser choice.
- **Telegram:** notices of decisions, failures, opened PRs and rehearsals, and the replies to the buttons.
- **Engine questions:** for example those of the test evidence and the list of values missing in the packs.
- **Core prompts:** with `en`, `prompts/en/<name>.md` applies; without an English version, the Portuguese prompt is used.

## What does not change

- **The packs' prompts and formats:** they stay in the language the company wrote them in. A Portuguese pack still works in an English instance, because the language only picks the core's texts.
- **Tags the code reads** in the AI's answers are the same in both languages: `<resultado>concluido|pendente</resultado>`, `<pendencias>`, `<pr>`, `<revisao>`, `<veredito>aprovado|ajustes</veredito>`, `<duvidas>`, `<plano>`, `<resposta>`.
- **Decisions already saved** stay in the language they were created in.
- **Internal logs** stay in English.

## Translating more

- Panel: `web/src/i18n/pt-BR.ts` and `web/src/i18n/en.ts`.
- Server: `src/i18n/pt-BR.ts` and `src/i18n/en.ts`.
- Prompts: `prompts/en/`.
- Docs: `docs/` (English) and `docs/pt-BR/` (Portuguese).

A test fails when a key exists in one language and is missing in the other. Another test checks that every English prompt has the same tags and placeholders as its Portuguese version.
