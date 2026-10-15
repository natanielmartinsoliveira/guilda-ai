# Acme — company pack (example)

A pack holds what a company shares among its devs: projects, code hosts, card sources and,
later, method, prompts and formats. Personal values and secrets are declared in
`requires.yaml` and each dev fills them in their own `.env`.

1. Keep the pack in a private git repository of the company.
2. Each dev clones it and adds the clone to `GUILDA_PACKS` (folders separated by `:`).
3. Missing values stop the instance with the list of what to fill and what each one is for.
