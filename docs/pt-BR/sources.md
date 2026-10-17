# Origens de card

Cada empresa declara de onde vêm os cards em `sources:` do `company.yaml` (ou do `tenants.yaml`). O que cada tipo sabe fazer:

| Tipo            | Como os cards chegam                       | Iniciar pelo código                              | Bases de sub-tarefa                  |
| --------------- | ------------------------------------------ | ------------------------------------------------ | ------------------------------------ |
| `jira`          | leitura periódica da JQL                   | sim (`PF-123`)                                   | sim (`subtasks: branch-per-subtask`) |
| `businessmap`   | leitura periódica da coluna/tag do gatilho | sim (id do card, `48816`), mesmo fora do gatilho | não                                  |
| `github-issues` | webhook                                    | não                                              | não                                  |
| `bitbucket`     | webhook (comentários `/ai` em PR)          | não                                              | não                                  |

## Businessmap

Origem `businessmap`: a Guilda AI lê o quadro pela API v2. A única escrita é mover o card para as colunas de `moves` (nenhuma por padrão); nunca comenta, põe tag ou anexa nada.

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
      owners: [291] # só cards destes usuários (ids); vazio: de qualquer um
    repositoryField: 13 # campo (tipo link) com o repositório do card
    routeTags: { regra: feature, tela: screen } # tag do quadro → rota do método
    moves: { gate: 3169, building: 3170, built: 3171, review: 3172 } # opcional: coluna por etapa
```

- **Gatilho:** card aberto do quadro na coluna do gatilho **ou** com a tag. Cards encerrados/arquivados ficam de fora. Card já aceito continua na coluna sem gerar outra tarefa.
- **Repositório obrigatório:** o link do campo `repositoryField` escolhe o projeto (comparado com o `repository` de cada projeto GitLab). Sem link, ou com repositório não configurado, o card é ignorado (motivo no log, uma vez) e entra sozinho quando for corrigido.
- **Rota pela tag** (projetos com método): exatamente uma tag de rota. Sem `routeTags`, uma tag com o nome de uma rota do método é aquela rota. Maiúsculas e acentos não importam. Com duas tags de rota o card não entra; sem nenhuma ele entra e a tarefa pergunta ao operador qual rota (as rotas do método como opções, também como botões no Telegram): a rota nunca é deduzida.
- **O card acompanha a tarefa** (`moves`, opcional): `gate` quando começa uma fase do método marcada `board: gate` (por exemplo, esperando a aprovação do operador), `building` para `board: building`, `built` quando a entrega termina (ensaio incluído), `review` quando o PR abre. Um move recusado vai para o log; a tarefa segue.
- **Tarefa:** chave = id do card, corpo = descrição (HTML → texto) + títulos dos cards pai/relacionados. Anexos do card ainda não são lidos.

## Iniciar um card pelo código

No painel: **Nova tarefa → Card de origem**. Escolha a empresa, a origem (quando a empresa tem mais de uma que inicia cards) e a chave no formato da origem. As mesmas regras da leitura periódica valem: projeto pelo campo de repositório do card (Businessmap) ou pelo projeto do Jira, rota pela tag (projetos com método) ou, numa origem Businessmap, pela **Rota** que você escolhe ali (opcional; a tag do próprio card continua valendo, e uma escolha contra ela é recusada), e um card que já tem tarefa não gera outra.

Pela API:

```
GET  /api/tenants                                   → sources: [{ id, type, label, key, example, bases }]
POST /api/tenants/<empresa>/sources/<origem>/start  { "key": "PF-123", "base": "feature/PF-1"?, "route": "fix"? }
GET  /api/tenants/<empresa>/sources/<origem>/cards/<chave>/bases
```

- `202` com `{ taskId }`, ou `200` com `{ skipped, taskId? }` quando o card não vira tarefa (com o motivo).
- `400`: chave fora do formato da origem (a mensagem traz o exemplo), ou `route` numa origem que não recebe rota (só o Businessmap recebe). `404`: origem inexistente na empresa, ou que não inicia cards / não tem bases. `502`: falha da origem ou do code host (mensagem sem segredos).
- As rotas antigas `POST /tasks/from-jira` e `GET /jira/<chave>/bases` continuam, usando a primeira origem Jira da empresa.
