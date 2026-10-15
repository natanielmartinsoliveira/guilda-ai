# Origens de card

Cada empresa declara de onde vêm os cards em `sources:` do `company.yaml` (ou do `tenants.yaml`). O que cada tipo sabe fazer:

| Tipo            | Como os cards chegam                                    | Iniciar pelo código                              | Bases de sub-tarefa                  |
| --------------- | ------------------------------------------------------- | ------------------------------------------------ | ------------------------------------ |
| `jira`          | leitura periódica da JQL                                | sim (`PF-123`)                                   | sim (`subtasks: branch-per-subtask`) |
| `businessmap`   | leitura periódica da coluna/tag do gatilho (só leitura) | sim (id do card, `48816`), mesmo fora do gatilho | não                                  |
| `github-issues` | webhook                                                 | não                                              | não                                  |
| `bitbucket`     | webhook (comentários `/ai` em PR)                       | não                                              | não                                  |

## Businessmap

Origem `businessmap`, **só leitura**: a Guilda AI só faz `GET` na API v2 e nunca move, comenta ou anexa nada no quadro.

```yaml
sources:
  - id: businessmap
    type: businessmap
    baseUrl: https://initech.kanbanize.com
    token: ${INITECH_BUSINESSMAP_TOKEN} # API key do seu usuário (My Account → API)
    boardId: 79
    trigger:
      columns: [3170] # coluna(s) que disparam
      tag: ai-dev-team # ou esta tag, em qualquer fluxo do quadro
    repositoryField: 13 # campo (tipo link) com o repositório do card
    routeTags: { regra: feature, tela: screen } # tag do quadro → rota do método
```

- **Gatilho:** card aberto do quadro na coluna do gatilho **ou** com a tag. Cards encerrados/arquivados ficam de fora. Card já aceito continua na coluna sem gerar outra tarefa.
- **Repositório obrigatório:** o link do campo `repositoryField` escolhe o projeto (comparado com o `repository` de cada projeto GitLab). Sem link, ou com repositório não configurado, o card é ignorado (motivo no log, uma vez) e entra sozinho quando for corrigido.
- **Rota pela tag** (projetos com método): exatamente uma tag de rota. Sem `routeTags`, uma tag com o nome de uma rota do método é aquela rota. Maiúsculas e acentos não importam. Sem tag de rota, ou com duas, o card não entra: a rota nunca é deduzida.
- **Tarefa:** chave = id do card, corpo = descrição (HTML → texto) + títulos dos cards pai/relacionados. Anexos do card ainda não são lidos.

## Iniciar um card pelo código

No painel: **Nova tarefa → Card de origem**. Escolha a empresa, a origem (quando a empresa tem mais de uma que inicia cards) e a chave no formato da origem. As mesmas regras da leitura periódica valem: projeto pelo campo de repositório do card (Businessmap) ou pelo projeto do Jira, rota pela tag (projetos com método), e um card que já tem tarefa não gera outra.

Pela API:

```
GET  /api/tenants                                   → sources: [{ id, type, label, key, example, bases }]
POST /api/tenants/<empresa>/sources/<origem>/start  { "key": "PF-123", "base": "feature/PF-1"? }
GET  /api/tenants/<empresa>/sources/<origem>/cards/<chave>/bases
```

- `202` com `{ taskId }`, ou `200` com `{ skipped, taskId? }` quando o card não vira tarefa (com o motivo).
- `400`: chave fora do formato da origem (a mensagem traz o exemplo). `404`: origem inexistente na empresa, ou que não inicia cards / não tem bases. `502`: falha da origem ou do code host (mensagem sem segredos).
- As rotas antigas `POST /tasks/from-jira` e `GET /jira/<chave>/bases` continuam, usando a primeira origem Jira da empresa.
