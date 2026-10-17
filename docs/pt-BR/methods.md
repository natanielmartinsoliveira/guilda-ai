# Métodos de trabalho da empresa

Um projeto pode seguir um **método** da empresa em vez do fluxo padrão (planejador, programador e revisor do núcleo). O método fica no pacote da empresa, em `methods/<nome>/`, e o motor do núcleo o executa. Nada do método fica no código.

```yaml
# company.yaml (projeto)
method: { name: meu-metodo, options: { pythonPath: /opt/py } }
# e, se a empresa exige que todo projeto o use:
requireMethod: meu-metodo
```

## Pasta do método

```
methods/<nome>/
  method.yaml     rotas, fases, regras, ambiente
  prompts/*.md    prompts e perguntas (na língua da empresa)
  hooks/*.py|sh   scripts que rodam no workspace da tarefa
```

## method.yaml

```yaml
name: meu-metodo
workspace: coder # coder: só roda em workspace Coder (os scripts rodam lá); any: qualquer
options: # o que cada projeto pode/precisa informar
  configFrom: { default: '{{workspace.reference}}', required: true }
env: # ambiente do agente e dos scripts (valor vazio não é passado)
  GIT_AUTHOR_NAME: '{{git.name}}'
  PYTHONPATH: '{{options.pythonPath}}'
timeoutMinutes: 240
commits: method # method: o método commita; sobra de arquivo no fim é falha
revisions: refuse # refuse: pedido de ajuste numa tarefa do método é recusado
agent: # o que o agente do método precisa sem ninguém para aprovar
  addDirs: ['~/.claude/plugins'] # pastas que ele pode ler ("~/" = HOME do workspace)
  allowedTools: ['Bash(python3 -B:*)', 'Bash(git status:*)'] # regras de permissão do Claude
hooks:
  prepare: hooks/prepare.py # toda execução, depois de preparar a branch
  advance: hooks/advance.py # quando um ensaio termina
messages: # textos de erro do método
  noRoute: '…'
routes:
  regra:
    label: { pt-BR: 'Regra de negócio', en: 'Business rule' }
    start: spec # fase inicial
    evidence: true # etapa de evidência (se o projeto tiver evidence)
    tests: true # testes e checks do projeto no fim (padrão)
    vars: { ROUTE_NAME: 'regra de negócio' } # placeholders dos prompts desta rota
  comentario:
    label: …
    start: gate
    finish: { commit: 'reconcile {{slug}}' } # commit no fim, só dos arquivos alterados
  superficie:
    label: …
    flow: standard # fluxo padrão do núcleo, com:
    before: [hooks/checa-alvo.py]
    append: prompts/regra-de-superficie.md
phases:
  spec:
    steps:
      - require: { var: specification_root, message: noSpecRoot }
      - discard: '{{vars.specification_root}}'
      - agent: prompts/analyse.md
        answersTo: notes
      - within:
          {
            path: '{{vars.specification_root}}',
            question: prompts/fora.md,
            option: prompts/fora-opcao.md,
          }
    next: gate
  gate:
    steps:
      - ask:
          question: prompts/gate-{{route}}.md
          option: prompts/autorizacao-{{route}}.md
          files: { path: '{{vars.specification_root}}', routes: [regra] }
          chosen:
            commit:
              {
                paths: ['{{vars.specification_root}}'],
                message: 'analyse {{slug}}',
                routes: [regra],
              }
            next: deliver
          other: { next: { regra: spec, default: gate } }
  deliver:
    steps:
      - agent: prompts/deliver-{{route}}.md
    next: done
```

## Passos

| Passo     | Faz                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `require` | Variável vazia → falha com a mensagem indicada.                                                                                                                                                                                                                                                                                                                     |
| `discard` | Descarta alterações e arquivos novos sob o caminho.                                                                                                                                                                                                                                                                                                                 |
| `agent`   | Roda o agente com o prompt; só `<resultado>concluido</resultado>` conta como concluído. Outra coisa vira a pergunta `prompts/stop-question.md` (`{{PENDING}}`), com as escolhas que o agente pôs em `<opcoes>` (uma por linha, até 4) ou, sem elas, a opção `prompts/stop-option.md`; a resposta entra em `answersTo` (`answers` ou `notes`) e a fase roda de novo. |
| `within`  | Arquivos pendentes fora do caminho viram pergunta; a resposta entra em `notes` e a fase roda de novo.                                                                                                                                                                                                                                                               |
| `ask`     | Pergunta com uma opção. A opção escolhida (texto idêntico, ou uma aprovação simples como "ok", "aprovado", "pode seguir", 👍 — o que vai citado é o texto da opção) vira `{{AUTHORIZATION}}`, faz o `commit` de `chosen` e vai para `next`; outro texto entra em `notes` e vai para `other.next` (por rota, com `default`).                                         |
| `hook`    | Roda um script do método.                                                                                                                                                                                                                                                                                                                                           |

## Repetir uma tarefa que falhou

Uma fase pode declarar `board: gate` ou `board: building`: quando ela começa, o card vai para a coluna que a origem dá para essa etapa (`moves` de uma origem Businessmap), uma vez por etapa. Uma tarefa de método que chega sem rota (card sem tag de rota) primeiro pergunta ao operador qual rota, com os rótulos das rotas como opções.

O **Repetir** simples de uma tarefa de método que falhou retoma a fase em que ela parou, mantendo os commits e as palavras escolhidas no portão (a causa costuma ser externa: VPN, cota). O **repetir com instrução** recomeça do zero.

## Prompts

- `prompts/x-{{route}}.md` é o da rota; se não existir, vale `prompts/x.md`.
- Placeholders: `{{MATERIAL}}` (o card), `{{SLUG}}`, `{{ROUTE}}`, `{{AUTHORIZATION}}`, `{{NOTES}}`, `{{ANSWERS}}`, `{{FILES}}`, `{{PENDING}}`, `{{REPORT}}` (o último relatório do agente, por exemplo para a pessoa revisar as decisões dele no portão) e os `vars` da rota.
- Listas viram linhas `- item`. `{{#NOTES}}…{{/NOTES}}` só aparece se houver itens; `{{^FILES}}…{{/FILES}}` só se não houver.

## Scripts (hooks)

- Rodam na pasta da tarefa no workspace, com `python3` (`.py`) ou `sh`, e com o `env` do método.
- Recebem no stdin um JSON: `first`, `taskId`, `project`, `slug`, `route`, `root` (pasta das tarefas), `options` e `vars`.
- A última linha do stdout, se for um objeto JSON, vira `{{vars.*}}`. Saída diferente de 0 interrompe a tarefa com a mensagem do script.

## Conferir o método: `method:check`

Na pasta `tests/` do método, casos em YAML renderizam os prompts pelo motor e comparam com o texto esperado, e `tests/test_*.py` testam os scripts com git de verdade:

```yaml
# methods/<nome>/tests/prompts.yaml
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
npm run method:check -- <pasta do pacote> <método>
```

Sem nenhum caso, o comando falha (um método sem testes não passa calado).

## Exemplo

O método de exemplo [`test/fixtures/methods/review-gate/`](../../test/fixtures/methods/review-gate/) usa tudo isso: três fases (especificação → portão → entrega), seis rotas (uma no fluxo padrão), scripts de preparo e avanço da especificação acumulada, prompts que citam as palavras do portão literalmente, e os testes do `method:check`. Copie a pasta para `methods/<nome>/` do seu pacote para começar.
