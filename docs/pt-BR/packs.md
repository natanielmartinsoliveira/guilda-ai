# Pacotes por empresa

Em vez de um `tenants.yaml` com todas as empresas, cada empresa pode ter um **pacote**: uma pasta (de preferência um repositório git privado da empresa) que os devs dela compartilham.

```
<pacote>/
  company.yaml    a empresa, no mesmo formato de um item de `tenants:`
  requires.yaml   o que cada dev precisa fornecer (no próprio .env)
  README.md
```

Exemplo completo: [`examples/packs/acme/`](../../examples/packs/acme/).

## requires.yaml

```yaml
- name: ACME_CODER_WORKSPACE
  description: Nome do seu workspace no Coder (aparece em coder list)
  example: dev-fulano
- name: ACME_BOARD_TOKEN
  description: Token da API do quadro de cards
  secret: true
```

- Toda `${VARIAVEL}` usada no `company.yaml` precisa estar declarada aqui.
- `secret: true`: o valor é escondido nos logs.
- `default`: valor usado quando o dev não define a variável.
- Faltando valor, a instância **não sobe** e lista, por pacote, o que falta e para que serve.
- Caminhos relativos em `harness.path` e `pullRequest.template` apontam para dentro do pacote.

## Usar pacotes

No `.env` da sua instância:

```
GUILDA_PACKS=/home/voce/guilda-packs/empresa-a:/home/voce/guilda-packs/empresa-b
EMPRESA_A_GIT_EMAIL=voce@empresa-a.com
…
```

Com `GUILDA_PACKS` definido, os pacotes substituem o `TENANTS_FILE`. Sem ele, nada muda.

## Migrar de um tenants.yaml

1. Crie um pacote por empresa e troque valores pessoais e segredos por `${…}` declarados no `requires.yaml`.
2. Compare: `npm run packs:compare -- /caminho/a:/caminho/b` carrega o `TENANTS_FILE` e os pacotes com o mesmo ambiente e diz **Idênticos** ou o primeiro lugar diferente (nunca o valor). Templates de PR contam pelo conteúdo: movê-los para dentro do pacote não é diferença.
3. Só com **Idênticos**, ponha `GUILDA_PACKS` no `.env`.

## Prompts da empresa

Qualquer prompt do núcleo (`prompts/*.md`: `coder.md`, `fixer.md`, `code-review.md`, `pr-sections.md`, `back-only.md`, `evidence.md`, …) pode ser trocado pelo pacote:

```
<pacote>/prompts/<nome>.md            vale para todos os projetos da empresa
<pacote>/prompts/<projeto>/<nome>.md  só para aquele projeto
```

Vale o primeiro que existir (projeto → pacote → núcleo). Os `{{PLACEHOLDERS}}` são os mesmos do prompt do núcleo; os desconhecidos ficam como estão.

## O que os projetos compartilham: projectDefaults

Os projetos de uma empresa costumam compartilhar quase tudo (o workspace, o método, os checks, o PR). Escreva isso uma vez em `projectDefaults` e deixe em cada projeto só o que muda:

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

Objetos se juntam chave a chave (o `workspace.reference` do projeto entra no workspace padrão, as `method.options` do projeto entram nas padrão); listas e valores simples são os do projeto quando ele tem. Depois cada projeto é validado como se tivesse sido escrito inteiro.

## Lições

O que a empresa aprendeu rodando as tarefas de um projeto fica no pack, para o time compartilhar pelo git: `lessons/<projeto>.md` para um projeto e `lessons/_all.md` para todos, uma linha `- ` por lição. Todo prompt de agente daquele projeto recebe essas lições (as mais novas que cabem em 8 KB). Os prompts de um método escolhem onde elas entram com `{{#LESSONS}}…{{LESSONS}}…{{/LESSONS}}`; o `method:check` renderiza sem elas.

**Guardar como lição**, na tela da tarefa (já preenchido com a falha da tarefa), acrescenta uma lição no arquivo do projeto, sem commit, com o card e a data: confira, commite e faça push do pack.

**Sugestões automáticas.** O sistema percebe lições sozinho: uma parada do agente de um método que você respondeu (o problema e a sua resposta) vira sugestão na hora; uma falha final é contada por projeto, sem ids, números, caminhos e nomes `entre crases`, e vira sugestão quando a mesma acontece 3 vezes. As sugestões ficam no banco até você decidir, em **Lições do projeto** na tela da tarefa: **Guardar** grava o texto (editável) no pack como qualquer lição, **Descartar** impede que ela volte. Nada chega aos prompts sem esse passo.

## Formatos

Em `formats:` do `company.yaml` (e, para um projeto, em `formats:` do projeto, campo a campo):

```yaml
formats:
  card: # seções do card
    frontTitles: [front-end] # títulos que abrem a parte de tela
    endTitles: [critérios de aceite] # títulos que a encerram
    nothing: [não se aplica] # frases de "sem tela"
  pullRequest:
    sections: # o que a IA escreve para o template do PR (<tag> → {{PLACEHOLDER}})
      - { tag: problema, placeholder: PROBLEM, ask: 'o problema', fallback: card }
      - { tag: traducoes, placeholder: TRANSLATIONS, ask: 'Sim / Não se aplica', kind: check }
  evidence:
    comment: formats/evidence.md # dentro do pacote; {{SHOTS}} = os prints
    shot: "{{N}}. {{TITLE}} — {{URL}} — {{AT}}\n[imagem {{FILE}}]"
    timezone: America/Sao_Paulo # fuso do carimbo dos prints (padrão UTC)
```

- Maiúsculas e acentos não importam nos títulos e frases do card.
- `fallback: card` usa o começo do card; `kind: check` vira ✅ ("Sim…"), ➖ ("Não se aplica") ou ⬜.
- Sem `formats`, valem os padrões do núcleo: card com termos genéricos (pt/en), PR com problema/solução/como testar, comentário de evidência neutro em UTC.
- O pacote de exemplo tem um prompt e os três formatos: [`examples/packs/acme/`](../../examples/packs/acme/).

## Assistente e setup.yaml (opcional)

`npm run setup` pergunta o idioma, clona os pacotes (URLs git ou pastas) em `~/guilda-packs/`, pede cada valor do `requires.yaml` que ainda falta no `.env` (segredos sem eco; o `.env` existente nunca é sobrescrito, só recebe as chaves pedidas) e testa o carregamento. Rodar de novo só pergunta o que ainda falta.

Scripts que a empresa recomenda em toda máquina (um SDK, uma CLI) ficam no `setup.yaml` do pacote; o assistente descreve cada um e só roda depois da confirmação:

```yaml
scripts:
  - run: scripts/install-board-cli.sh
    description: Instala a CLI do quadro usada pelo time
```
