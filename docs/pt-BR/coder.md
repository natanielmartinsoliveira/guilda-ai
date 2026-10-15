# Projetos em workspace Coder

Para empresas cujo código **não pode ficar na máquina do operador**. A Guilda AI continua rodando aqui (fila, estágios, decisões, painel, Telegram), mas o clone, o agente, os testes e o commit acontecem **dentro do workspace [Coder](https://coder.com) da empresa**, por `coder ssh`.

## Pré-requisitos

1. **VPN da empresa ligada**, se o Coder exigir (no Windows serve: o WSL usa a rota do Windows). Teste no WSL:
   `curl -s -o /dev/null -w '%{http_code}\n' https://<coder>/healthz` → `200`.
2. **Coder CLI logado no WSL**, na mesma versão do servidor:
   ```bash
   curl -fsSL -o ~/.local/bin/coder https://<coder>/bin/coder-linux-amd64 && chmod +x ~/.local/bin/coder
   ~/.local/bin/coder login https://<coder>
   ```
   Se o `coder` não estiver no PATH do serviço, aponte no `.env`: `CODER_BIN=/home/<usuário>/.local/bin/coder`.
3. **Claude logado dentro do workspace**, com a conta da empresa: abra o terminal do workspace (VS Code → Coder), rode `claude` e `/login`. A Guilda AI **não** copia credencial para lá nem traz a de lá para cá.

## Configuração (pacote da empresa ou `tenants.yaml`)

```yaml
hosts:
  - id: gitlab
    type: gitlab
    baseUrl: https://git.initech.example
    sshUrl: ssh://git.initech.example:2244 # o clone acontece no workspace, por ssh
    token: ${INITECH_GITLAB_TOKEN}
projects:
  - id: orders
    host: gitlab
    repository: shop/orders
    defaultBranch: homolog
    branch: '{key}-{slug}' # ex.: 1234-fix-payment-options
    test: [make, test] # roda dentro do workspace
    workspace:
      type: coder
      url: https://coder.initech.example
      name: ${INITECH_CODER_WORKSPACE} # o workspace de cada dev
      agent: main # opcional
      root: /root/ai-dev-team # pasta das tarefas no workspace (fora de protect)
      reference: /workspaces/orders # opcional: acelera o clone (só leitura)
      protect: [/workspaces] # padrão; os clones do operador que o agente não pode tocar
    delivery: rehearsal # rehearsal (sem push/MR) | draft (MR rascunho) | normal (MR)
    pullRequest:
      title: '{key} - {title}' # opcional; padrão "AI: <card> <título>"
      reviewers: [${INITECH_GITLAB_USER}] # opcional; usuários do GitLab
```

Regras (erro ao carregar a configuração): `coder` só funciona com host `gitlab` (clone e push por ssh com a chave do workspace — um host https levaria o token para lá); não aceita `runner` (os comandos `prepare`/`test` já rodam no workspace — use `docker run` neles para testar a cópia da tarefa); a empresa só pode ter credenciais `claude` sem `apiKey` e sem `harness`; `root` absoluto, sem `..` e fora de `protect`.

## O que fica e o que não fica nesta máquina

- **Fica aqui:** estágio, mensagens de erro curtas, nomes dos arquivos alterados, últimas 40 linhas dos testes, a mensagem final do agente e o texto da revisão automática.
- **Não fica aqui:** o código, o diff (o revisor lê a mudança no próprio workspace) e a saída dos comandos (a auditoria guarda só o comando, a duração, o código de saída e o tamanho da saída).
- Anexos e prints do Figma são baixados aqui (não são código da empresa) e **enviados** para `<pasta da tarefa>/.ai-dev-team/` no workspace, fora do git.

## Modo ensaio

O fluxo inteiro roda (agente → testes → revisão → commit **local** na branch da tarefa) e termina como **"Ensaio concluído — nada foi publicado"**, com o caminho no workspace (`<workspace>:<root>/<tarefa>`), a branch, o commit e os arquivos. Confira abrindo a pasta pelo VS Code do Coder. Depois use **Descartar ensaio** na tela da tarefa para apagar a pasta (também vale para tarefas `coder` que falharam ou foram canceladas; nunca para uma tarefa rodando).

## Proteções

- Seus clones em `protect` (padrão `/workspaces`) são fotografados antes e depois de cada execução do agente (HEAD, branch e `git status`). Se mudarem, a tarefa **falha** dizendo quais — nada é desfeito. Se foi você editando no VS Code ao mesmo tempo, é só repetir a tarefa.
- O revisor (somente leitura) que alterar a pasta da tarefa também faz a tarefa falhar.
- Nenhum comando roda com `cwd` nos seus clones; o `reference` só é lido pelo git (`--reference --dissociate`).

## Erros e o que fazer

| Mensagem                                              | O que fazer                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| Coder inacessível — a VPN está ligada?                | Ligue a VPN; a tarefa tenta de novo sozinha.                                  |
| Workspace … parado                                    | A Guilda AI roda `coder start` sozinha; se não subir, ela tenta de novo depois. |
| Sessão do Coder expirada                              | Rode `coder login <url>` no WSL e repita a tarefa.                            |
| Claude sem login no workspace                         | Faça `/login` no Claude dentro do workspace e repita.                         |
| O agente alterou repositórios fora da pasta da tarefa | Confira os repositórios citados; repita.                                      |

## Harness do repositório

Em projetos `coder` o Claude roda com `--setting-sources user,project`: usa o `CLAUDE.md`, as skills e commands de `.claude/` e os plugins habilitados **de cada repositório**, como quando o time usa o Claude no workspace. MCP declarado pelo repositório continua ignorado (`--strict-mcp-config`).

## Checks de segurança

`checks` funciona em projetos `coder`: gitleaks, semgrep e osv rodam no Docker **do workspace**, sobre os arquivos alterados (agora e no commit base). Só voltam regra, arquivo, linha e mensagem; a identidade de cada achado é um hash calculado lá. Achado que já existia na base não conta.

## Pedido de ajuste

- **Em ensaio:** "Pedir ajuste" na tela da tarefa. O ajuste roda na mesma pasta do workspace e gera um novo commit local; o ensaio passa a apontar para ele. Depois de descartado, não aceita mais ajuste.
- **Em MR publicada (`draft`/`normal`):** comente `/ai <instruções>` na MR (em uma linha de código, o arquivo e a linha vão junto). A Guilda AI lê as MRs abertas a cada `pollSeconds` (padrão 60) — um GitLab interno não consegue chamá-la. `allowedUsers` no host limita quem pode disparar.

## Método da empresa

Um projeto `coder` pode seguir um método da empresa (`method: { name: … }`) em vez do planejador/programador/revisor do núcleo: fases, perguntas, portões e scripts definidos no pacote da empresa e executados pelo motor de métodos. Veja [methods.md](methods.md).

## GitLab: publicar

- Token do GitLab com escopo **`api`** no `.env`; as chamadas à API saem desta máquina (pela VPN, se houver) e levam só metadados (título, descrição, comentários).
- `delivery: draft` faz o push **de dentro do workspace** e abre a MR com prefixo `Draft:` (o GitLab não deixa mergear até alguém tirar); `normal` abre a MR comum. Uma MR que já existe para a branch (aberta, mergeada ou fechada) é reaproveitada, nunca duplicada.
- `reviewers`: os usuários viram revisores da MR; um usuário inexistente para a entrega com erro claro.
- Comentários de revisão da MR com `/ai <pedido>` (dos `allowedUsers`) viram ajuste da tarefa.

## Telegram

Com o Telegram ligado, cada ensaio concluído (e cada ajuste de ensaio) avisa: "🧪 Ensaio concluído — nada foi publicado", com o caminho no workspace, a branch e o commit.

## Evidência de teste

Com `evidence: { playwright: 1.48.2 }` no projeto (só workspace Coder), toda entrega de uma rota do método com `evidence: true` ganha a etapa **"Gerando evidência de teste"** depois do commit:

1. A Guilda AI sobe para `.ai-dev-team/evidence/` da pasta da tarefa (fora do git) o kit fixo: `evidence-kit.cjs` (tira o print, mascara `Authorization`/cookies/tokens e desenha a moldura com a **URL real** e **data/hora** no fuso de `formats.evidence.timezone`) e `run.sh` (roda a imagem oficial `mcr.microsoft.com/playwright:v<versão>-noble` na rede do workspace).
2. A IA sobe o sistema com banco descartável, cria os dados de teste, escreve `roteiro.cjs` usando só o kit (`shot` para tela, `apiShot` para rota de API no estilo Swagger) e roda até os prints mostrarem o resultado.
3. A Guilda AI confere o `manifest.json`, baixa os prints e o trace do Playwright, apaga a pasta do kit e monta o comentário no formato da empresa (`formats.evidence.comment`, veja [packs.md](packs.md)).
4. Se a IA não chegar ao resultado (ou o manifesto não fechar), a tarefa para numa decisão; sua resposta (por exemplo, "use a venda X") orienta a próxima tentativa.

No painel, a tarefa mostra os prints, o botão **Copiar comentário** e **Baixar trace**; o Telegram avisa quantos prints há. O `run.sh` instala o pacote `playwright` pelo npm a cada execução: o workspace precisa alcançar o npm.

## Limitações

Sem `harness` da Guilda AI (o harness é o do próprio repositório).
