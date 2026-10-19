# Guilda AI — guia do operador (pt-BR)

> Guia detalhado em português. A visão geral em inglês está no [README](../../README.md); os demais documentos ficam em [`docs/`](../) (inglês) e [`docs/pt-BR/`](./) (português).

Implementação NestJS de card/Issue (GitHub Issues, Jira, API/VS Code) → PostgreSQL/outbox → RabbitMQ → agente (Codex ou Claude) → testes → Git → draft PR (GitHub ou Bitbucket), para várias empresas numa mesma instalação. Não faz merge.

**Estado:** em uso diário pelo autor em mais de uma empresa (GitHub, Jira + Bitbucket, Coder + GitLab). A suíte automatizada usa PostgreSQL emulado (`pg-mem`) e mocks de RabbitMQ, IA e hosts, além de HTTP NestJS, subprocessos e Git locais reais.

## Arquitetura

### Modelo (visão)

A visão original do projeto: agentes especializados (Architect, Coder, Tester, Reviewer, Security, Notifier) trabalhando por filas, com estado, revisão e controle no orchestrator. **O que já existe hoje** em relação a ele:

| No modelo                        | Hoje                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub (issues, branches, PRs)   | GitHub e Bitbucket Cloud como hosts; GitHub Issues, Jira e API/VS Code (MCP) como fontes                                                        |
| n8n recebendo webhooks           | Webhooks assinados e polling do Jira direto no NestJS (sem n8n)                                                                                 |
| NestJS Orchestrator              | Sim: aceita tarefas, controla estado, tentativas, revisões, sub-tarefas e relatos ao tracker                                                    |
| RabbitMQ com uma fila por agente | Uma fila por empresa (`ai-dev-tasks.<empresa>`) + DLQ própria, alimentadas por outbox                                                           |
| Coder Agent                      | Sim (Codex ou Claude CLI, isolados, com fallback entre credenciais)                                                                             |
| Tester Agent                     | Testes do projeto rodam após o agente, no container do projeto; falhas voltam ao agente para correção                                           |
| Reviewer / Security Agent        | Revisor de IA antes do PR (papel `reviewer`), checagens de segurança locais (`checks`) e revisão humana no PR (`/ai` ou Change request no Jira) |
| Architect Agent                  | Ainda não; o plano vem das sub-tarefas do card                                                                                                  |
| Notifier Agent                   | Comentários e transições no Jira; respostas no PR                                                                                               |
| PostgreSQL                       | Sim: estado, auditoria e outbox                                                                                                                 |
| Redis                            | Não usado: locks via advisory locks do PostgreSQL                                                                                               |
| OpenRouter / Ollama              | Não; assinaturas/chaves Codex e Claude por empresa                                                                                              |
| Docker                           | Containers descartáveis para preparar e testar o projeto; agentes em sandbox (bubblewrap)                                                       |

### Fluxo implementado

```mermaid
flowchart TD
  A[GitHub Issue / card Jira / API e VS Code] --> B[API NestJS: webhook, polling, operador]
  B --> C[PostgreSQL: issue, task e outbox]
  C --> D[Publicador com confirmação]
  D --> E[RabbitMQ]
  E --> F[Worker NestJS]
  F --> G[Codex ou Claude isolado, com fallback]
  G --> H[Testes no container do projeto e commit]
  H --> I[Push e draft PR no GitHub ou Bitbucket]
  I --> K[Comentário e transição no Jira]
  I --> C
  F --> J[Retry limitado ou falha registrada]
  J --> C
```

A API não executa agentes. O worker é um processo separado; cada empresa tem um canal próprio com `prefetch` igual ao seu `worker.concurrency`. Ambos podem publicar a outbox. O banco controla estado, tentativas e auditoria; RabbitMQ transporta identificadores. O GitHub controla o código e PRs.

- Project, Issue, Task, AgentRun e PullRequest são entidades TypeORM. Outbox é a tabela adicional de entrega confiável.
- Issue, Task e Outbox são gravadas em uma transação. O webhook devolve 202 após esse commit, mesmo se RabbitMQ estiver fora do ar.
- Publicação usa mensagens persistentes e publisher confirms. Uma queda entre publish e commit pode duplicar mensagens; isso é esperado.
- Há unicidade por GitHub Issue e uma task por Issue. Redelivery não cria nova tarefa. `reopened` é ignorado nesta versão.
- Advisory locks PostgreSQL impedem execuções simultâneas da mesma task; são liberados quando a conexão morre.
- ACK apenas após SUCCESS ou ao receber uma duplicata já concluída. Falhas recebem NACK sem requeue e ficam em `ai-dev-tasks.<empresa>.dead`. Se recuperáveis, uma nova entrada na outbox agenda a tentativa seguinte. A DLQ contém tentativas falhas, inclusive de tasks que depois deram certo.
- Máximo padrão: três tentativas. Erros de rede Git/GitHub, HTTP 429 e 5xx são recuperáveis. Falta de CLI, testes reprovados, limite de saída, timeout e ausência de alterações encerram a tarefa com erro explícito.
- Commit SHA é salvo antes do push. Após falha no GitHub, a retomada usa o mesmo commit. Busca por `head` antes/depois da criação reduz PRs duplicados após respostas ambíguas.
- Um commit criado imediatamente antes de uma queda é detectado pelo SHA de base; os testes são repetidos antes do push.

## Requisitos

- Linux ou WSL2 com user namespaces e Bubblewrap funcionando, Node.js 22+, npm, Git e Docker Compose v2.
- Worker executado por usuário **não root**, em máquina/VM dedicada. macOS/Windows nativos não são suportados pelo sandbox deste MVP.
- Codex instalado em `/usr/local` ou `/usr`; os diretórios `/home`, `/opt` e instalações NVM pessoais não são montados no sandbox. Ajuste a instalação, não desative o isolamento.
- PostgreSQL 16, RabbitMQ 4, acesso HTTPS a GitHub, provedor de IA e registro das dependências do projeto alvo.
- Repositório alvo já inicializado, com uma branch padrão e testes que funcionem com o comando configurado. O exemplo usa npm e lockfile; outras stacks podem usar argv configurados pelo administrador.

## Instalação

```bash
cd ai-dev-team
npm ci
cp .env.example .env
cp tenants.example.yaml tenants.yaml
# Edite .env e tenants.yaml antes de continuar.
docker compose up -d
npm run migration:run
npm run build
npm run test
npm run lint
```

`DATABASE_PASSWORD=change_me` é somente exemplo: substitua. As migrations são explícitas; `synchronize` permanece desabilitado. O Dockerfile empacota apenas a API. O worker roda no host Linux para usar as CLIs instaladas; não monte o socket Docker no worker.

A imagem da API não inclui a ferramenta de migrations de desenvolvimento. Aplique migrations pelo checkout antes de iniciar a imagem. A imagem não embute o `tenants.yaml`: monte-o como volume somente leitura e aponte `TENANTS_FILE` para ele. Para usar a imagem, configure `DATABASE_HOST` e `RABBITMQ_URL` com os endereços acessíveis a partir do container; `localhost` dentro dele não é o host.

## CLIs e autenticação (agentes Codex e Claude)

Os agentes são as CLIs oficiais: **Claude Code** (`provider: claude`) e **Codex** (`provider: codex`, e também `openrouter`). O worker as executa dentro do sandbox (bubblewrap), com um home temporário que só recebe o arquivo de login **daquela credencial**. Passo a passo, no WSL:

### 1. Instalar as CLIs no sistema

O sandbox só enxerga `/usr`, `/bin` e `/lib`, e roda as CLIs com o `node` **do sistema** (`/usr/bin/node`), não o do nvm. O Gemini CLI exige Node 20+, e o Ubuntu 24.04 só traz o 18: instale o Node LTS pelo NodeSource. Precisa de `sudo` na instalação; o worker nunca roda com sudo.

```bash
# Node LTS no sistema (substitui o Node 18 do Ubuntu; a API/worker seguem no Node do nvm)
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
sudo -E bash /tmp/nodesource_setup.sh
sudo apt-get install -y nodejs
/usr/bin/node --version   # homologado: v24.21.0

# CLIs dos agentes, com o npm do sistema
sudo /usr/bin/npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli
claude --version          # homologado: 2.1.285
codex --version           # homologado: codex-cli 0.160.0
/usr/bin/gemini --version # homologado: 0.62.0 (o do nvm, se existir, pode aparecer antes no PATH)
codex exec --help | grep -E -- '--json|--sandbox|--config'
npm run doctor
```

Cada CLI fica onde o npm do sistema instalou: confira com `ls -l /usr/local/bin/{claude,codex} /usr/bin/gemini` e ajuste `CLAUDE_BIN`, `CODEX_BIN` e `GEMINI_BIN` no `.env` se for diferente. Os avisos do npm sobre `@github/keytar` e `node-pty` não afetam o uso headless com chave de API.

O provider confere as opções da CLI instalada a cada execução e falha com mensagem clara se a versão não tiver alguma (`--json`, `--sandbox`, `--config`, `--print`, `--permission-mode`...). Nenhuma flag que desligue o sandbox é usada. Para atualizar, repita o `npm install -g`.

### 2. Declarar as credenciais da empresa

Credenciais são **por empresa**, em `ai.credentials` do `tenants.yaml`: lista **ordenada** (é a ordem de fallback) que pode misturar provedores, assinaturas e chaves. `ai.providers` é o que o contrato da empresa permite receber o código.

```yaml
ai:
  providers: [claude, codex]
  credentials:
    - { id: claude-max, provider: claude } # assinatura (login)
    - { id: chatgpt, provider: codex } # assinatura ChatGPT (login)
    # - { id: anthropic-api, provider: claude, apiKey: '${EMPRESA_ANTHROPIC_API_KEY}' }
    # - { id: openai-api, provider: codex, apiKey: '${EMPRESA_OPENAI_API_KEY}' }
```

Cada credencial tem seu diretório de login: `AGENT_HOME/<empresa>/<id da credencial>/` (por padrão `.agent-home/...` no projeto). Assim duas empresas, ou duas assinaturas da mesma empresa, nunca se misturam.

### 3. Fazer o login de cada credencial de assinatura

Credenciais com `apiKey` dispensam este passo (a chave fica no `.env`; o Codex faz `login --with-api-key` sozinho no home temporário). Para assinatura, crie o diretório **antes** (o Codex recusa um `CODEX_HOME` inexistente) e faça o login apontando para ele:

```bash
cd ~/ai-dev-team
EMPRESA=acme   # id da empresa

# Codex (assinatura ChatGPT) — credencial "chatgpt"
mkdir -p -m 700 .agent-home/$EMPRESA/chatgpt
CODEX_HOME="$PWD/.agent-home/$EMPRESA/chatgpt" codex login
# No WSL, se o navegador não devolver o login ao terminal, use o código de dispositivo:
CODEX_HOME="$PWD/.agent-home/$EMPRESA/chatgpt" codex login --device-auth
CODEX_HOME="$PWD/.agent-home/$EMPRESA/chatgpt" codex login status   # "Logged in using ChatGPT"

# Claude (assinatura Pro/Max) — credencial "claude-max": abra, rode /login, depois /exit
mkdir -p -m 700 .agent-home/$EMPRESA/claude-max
CLAUDE_CONFIG_DIR="$PWD/.agent-home/$EMPRESA/claude-max" claude
```

Confira que o login ficou onde o sandbox procura:

```bash
ls -l .agent-home/$EMPRESA/chatgpt/auth.json .agent-home/$EMPRESA/claude-max/.credentials.json
```

O sandbox copia apenas esse arquivo para o home temporário de cada execução; renovações de token feitas lá dentro não voltam ao host, então um login expirado exige repetir este passo (o `ai_status` mostra a credencial em espera por `auth`). Nunca aponte `AGENT_HOME` para o seu diretório pessoal (`~/.codex`, `~/.claude`).

### 4. Escolher quem faz o quê (papéis)

Sem `ai.roles`, implementação e correção de testes usam as credenciais na ordem, e não há planner nem revisor. Para ligar os papéis (detalhes em [Papéis de IA](#papéis-de-ia-e-escolha-de-modelos-airoles)):

```yaml
roles:
  coder: [claude-max, chatgpt] # Claude implementa; Codex se o Claude esgotar
  fixer: [{ credential: claude-max, effort: medium }, chatgpt]
  planner: [{ credential: claude-max, effort: high }] # cards sem sub-tarefas
  reviewer: [{ credential: chatgpt, effort: medium }] # outro modelo revisa antes do PR
review: { rounds: 1 }
```

### 5. Aplicar e verificar

```bash
systemctl --user restart ai-dev-team-api ai-dev-team-worker
```

No VS Code (MCP), `ai_status` com o id da empresa lista cada credencial, se está disponível e os papéis que atende; pela API, `GET /api/tenants/<empresa>/ai` com `Authorization: Bearer <API_TOKEN>`. Se uma credencial aparecer em espera por `auth`, refaça o login (passo 3).

Homologado neste ambiente, sempre pelo sandbox real (criar um arquivo, como um coder, e responder a revisão em modo somente leitura): Claude por assinatura (também com entrega real), Codex por assinatura ChatGPT, Gemini (`gemini-3.5-flash`, chave do AI Studio) e OpenRouter com modelos gratuitos. Veja [Gemini](#gemini-google-ai-studio) e [OpenRouter](#openrouter-e-por-que-groq-não-é-suportado).

### Custo e orçamento por tarefa

Cada execução registra o custo informado pelo provedor (o Claude informa `total_cost_usd`) e os modelos usados; a tela da tarefa mostra o custo de cada execução e o total, que soma também os Repetir e as retomadas. Com `ai.budget: { perTaskUsd: 15 }` na empresa, uma tarefa que chegou ao teto não começa outra execução: para numa decisão "💰 Orçamento da tarefa atingido…", e escolher "Liberar mais US$ 15" (ou responder "ok") libera mais uma parcela. Uma execução em andamento nunca é cortada. Sem `budget`, o custo nunca para uma tarefa. Depois de atualizar, rode `npm run migration:run` (coluna `costUsd` nas tarefas).

### Fallback entre IAs

O worker tenta as credenciais na ordem configurada, pulando as que estão em espera:

| Falha da CLI                                     | O que acontece                                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens/créditos/limite de uso acabaram (`quota`) | Credencial em espera por `cooldown.quotaMinutes` (padrão 6 h) ou pelo prazo que a CLI informar ("try again in 2 days"); a próxima assume |
| Rate limit / sobrecarga (`rate_limit`)           | Espera `rateLimitMinutes` (padrão 5 min) ou o prazo informado; a próxima assume                                                          |
| Chave inválida / login expirado (`auth`)         | Espera `authMinutes` (padrão 24 h) até você corrigir; a próxima assume                                                                   |
| Qualquer outra falha (código, testes, timeout)   | **Não** troca de credencial: é problema da tarefa, e repetir com todas só multiplicaria custo                                            |

Antes de cada execução da IA o workspace volta ao commit base, descartando edições parciais de uma execução interrompida. O estado das credenciais fica no banco (`ai_credential_states`) e vale para todas as tarefas da empresa: uma chave esgotada não é tentada de novo até o prazo passar. Se **todas** estiverem em espera, a tarefa não falha: fica `PENDING` na etapa `WAITING_CAPACITY` e volta sozinha quando a primeira credencial liberar, sem consumir tentativas. `get_task`/`GET .../tasks/:id` mostram `agentAttempts` (qual credencial rodou e por que as anteriores falharam), e `ai_status`/`GET /api/tenants/:empresa/ai` mostram quais estão disponíveis e até quando. Cada credencial lista também os papéis que atende, com modelo e esforço.

### Papéis de IA e escolha de modelos (`ai.roles`)

Cada execução de IA tem um papel, e cada papel tem sua lista de credenciais (com o mesmo fallback acima), seu modelo e seu esforço de raciocínio:

| Papel      | Quando roda                                                                                                   | Padrão sem `roles`             |
| ---------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `coder`    | Implementação, revisões (`/ai`, Change request) e ajustes pedidos pelo revisor                                | Todas as credenciais, na ordem |
| `fixer`    | Corrigir a suíte oficial que falhou depois do coder                                                           | Igual ao `coder`               |
| `planner`  | Antes do coder, em cards **sem sub-tarefas** (as sub-tarefas já são o plano); lê o projeto e escreve um plano | **Desligado**                  |
| `reviewer` | Depois dos testes passarem e antes do commit; revisa o diff                                                   | **Desligado**                  |

`planner` e `reviewer` só rodam quando listados: assim nunca caem, sem você decidir, numa IA fraca ou cara. Os dois rodam com o workspace **montado somente leitura** (e o Claude sem as ferramentas de edição; o Codex com `--sandbox read-only`; o Gemini em modo `plan`). São opcionais: sem capacidade ou com resposta ilegível, a entrega segue sem eles e o PR registra isso.

```yaml
ai:
  providers: [claude, codex, openrouter]
  credentials:
    - { id: claude-max, provider: claude } # assinatura
    - { id: chatgpt, provider: codex } # assinatura ChatGPT
    - {
        id: router,
        provider: openrouter,
        apiKey: '${OPENROUTER_API_KEY}',
        model: deepseek/deepseek-chat,
      }
  roles:
    coder: [{ credential: claude-max, model: opus, effort: high }, chatgpt]
    fixer: [{ credential: claude-max, model: sonnet, effort: medium }, chatgpt]
    planner: [{ credential: claude-max, model: opus, effort: high }] # nunca um modelo fraco
    reviewer: [{ credential: chatgpt, effort: medium }] # outro modelo que o coder
  review: { rounds: 1 } # passadas do revisor que podem devolver ao coder (1 a 3)
```

- Um item de papel é o id da credencial ou `{ credential, model, effort }`; `model`/`effort` da credencial valem quando o papel não define. `effort`: `low`, `medium`, `high`, `xhigh`, `max` (Claude `--effort`; Codex `model_reasoning_effort`, com `max` → `xhigh`; ignorado no Gemini).
- **Revisor:** pede ajuste só para bug, regra do card não atendida, segurança, teste ausente ou regra obrigatória do projeto; estilo e refatorações fora do escopo não bloqueiam. Os ajustes voltam ao `coder`, a suíte roda de novo, e o commit sai com tudo. Com `rounds: 1` não há segunda revisão depois do ajuste (custo previsível). O resultado vai no PR (`### Review` no corpo padrão, `{{REVIEW}}` no modelo do time) e em `result.review` da tarefa.
- **Use modelos diferentes** no coder e no revisor (por exemplo Claude escreve, Codex revisa): o mesmo modelo tende a concordar consigo mesmo.
- **Onde não se gasta token:** commit, push, PR, preparar dependências e rodar a suíte oficial são feitos pelo orchestrator, sem IA. O texto do PR sai na mesma execução do coder. Os prompts pedem ao agente que rode só os testes ligados à mudança, já que a suíte inteira roda depois. O que sobra de custo é escolhido por papel: modelo forte para planejar e implementar, um mais barato para corrigir teste.

### Gemini (Google AI Studio)

`provider: gemini` usa o **Gemini CLI** com uma chave do AI Studio (`GEMINI_API_KEY` dentro do sandbox). Exige `apiKey` e `model`:

```yaml
providers: [claude, gemini]
credentials:
  - { id: gemini-1, provider: gemini, apiKey: '${GEMINI_API_KEY_1}', model: gemini-3.5-flash }
roles:
  reviewer: [gemini-1]
```

- **Implementar:** modo `auto_edit`, em que o Gemini edita arquivos sozinho mas **não roda comandos** (sem aprovação, o modo headless os nega). Quem roda os testes é o orchestrator.
- **Revisor/planner:** modo `plan`, somente leitura, além do projeto montado só para leitura no sandbox. No teste, ele não conseguiu criar o arquivo pedido e respondeu a revisão.
- O prompt vai pela entrada padrão (sem limite de tamanho de argumento). As instruções do harness da empresa viram o contexto global do Gemini; ele não usa skills nem subagentes. Não há controle de esforço: `effort` é ignorado.
- **Plano gratuito:** `429 Resource has been exhausted` (limite por minuto) põe a chave em espera curta; "Quota exceeded ... per day" (limite diário), em espera longa. Nos dois casos a próxima chave assume. O próprio Gemini CLI também repete sozinho ao bater no limite por minuto, o que pode deixar uma execução lenta (no teste, 150 s para criar um arquivo; 29 s para revisar).
- Modelos disponíveis para a chave: `curl -s -H "x-goog-api-key: $GEMINI_API_KEY_1" https://generativelanguage.googleapis.com/v1beta/models`. `gemini-2.5-*` já não aceita usuários novos.

### OpenRouter (e por que Groq não é suportado)

`provider: openrouter` usa o **Codex CLI** apontado para `https://openrouter.ai/api/v1` (API Responses), com a chave em `OPENROUTER_API_KEY` dentro do sandbox (nunca `codex login`). Exige `apiKey` e `model` (id do OpenRouter). As chaves ficam no `.env` (`OPENROUTER_API_KEY_1=...`) e o `tenants.yaml` só as referencia:

```yaml
providers: [claude, codex, openrouter]
credentials:
  - {
      id: openrouter-1,
      provider: openrouter,
      apiKey: '${OPENROUTER_API_KEY_1}',
      model: 'cohere/north-mini-code:free',
    }
  - {
      id: openrouter-2,
      provider: openrouter,
      apiKey: '${OPENROUTER_API_KEY_2}',
      model: 'poolside/laguna-s-2.1:free',
    }
roles:
  reviewer: [openrouter-1, openrouter-2] # 429 põe a chave em espera e a próxima assume
```

- **Homologado pelo sandbox** (criar um arquivo com as ferramentas do Codex, como um coder, e responder no formato do revisor): `cohere/north-mini-code:free` e `poolside/laguna-s-2.1:free`. O OpenRouter aceita a requisição do Codex sem ajustes.
- **Plano gratuito** (conta sem crédito): só modelos `:free`, com limite baixo por dia e modelos que às vezes respondem `429` por sobrecarga. Serve para revisor e tarefas leves; para implementar, use assinatura (Claude/ChatGPT) ou coloque crédito e um modelo pago.
- Modelos menores às vezes não fecham o bloco de resposta (`</revisao>`): o leitor aceita o bloco aberto até o fim da mensagem.
- **Política de dados:** o OpenRouter repassa o código a terceiros; inclua `openrouter` em `providers` só nas empresas cujo contrato permite.

**Groq** e **Gemini** foram testados pelo Codex 0.160, que só fala a API Responses e sempre envia campos próprios:

| Serviço            | Resultado do teste                                                                                                                                                                                                                | Situação                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Groq               | Recusa `client_metadata`, ferramentas não-`function` (`web_search`, `namespace`) e `reasoning.summary`; no plano gratuito, o limite (8.000 tokens/min) é menor que uma única requisição do Codex (~5.800 tokens só de instruções) | Não suportado                                             |
| Gemini (AI Studio) | Não tem API Responses (404); só chat completions, que o Codex não usa mais                                                                                                                                                        | Suportado pelo **Gemini CLI** (`provider: gemini`, acima) |

A classificação lê apenas o canal de erro da CLI (eventos de erro do JSON do Codex, resultado de erro do Claude e o final do stderr), nunca a saída do agente: um teste que imprime "429" não parece chave esgotada. Mensagens de erro de provedores mudam; se uma falha de capacidade cair como falha comum, o padrão fica em `src/agents/failure.ts`. `ai.providers` continua sendo a política do contrato: credencial de provedor fora da lista impede a aplicação de subir.

Não envie chaves em issues, commits ou mensagens. O processo da IA não recebe tokens de repositório, senha do banco ou credenciais RabbitMQ. Apenas a chave de IA da própria empresa é repassada. A IA precisa ter acesso a essa chave para funcionar: o sandbox não elimina esse risco.

## Empresas (`tenants.yaml`)

Uma instalação atende várias empresas. Cada uma declara, em `tenants.yaml` (modelo em `tenants.example.yaml`):

- `git`: nome e e-mail dos commits automáticos;
- `ai`: provedores permitidos pelo contrato e credenciais em ordem de fallback;
- `hosts`: onde o código mora e com qual token (hoje: `github`);
- `sources`: de onde vêm as tarefas (hoje: `github-issues` e `jira`; a API/VS Code existe sempre);
- `projects`: repositórios aceitos, branch base e comandos `test`/`prepare`;
- `worker.concurrency` (opcional, padrão 1, máximo 8): quantas tarefas da empresa rodam ao mesmo tempo. Cada empresa tem a própria fila, então uma empresa ocupada (ou parada em perguntas) não segura as outras. Mensagens de antes desta mudança, na fila antiga `ai-dev-tasks`, ainda são consumidas, uma por vez.

Segredos ficam no `.env` e o YAML os referencia como `${NOME}`. Variável ausente impede API e worker de subirem, com o caminho exato do campo. `npm run doctor` valida o arquivo.

Isolamento entre empresas: workspaces em `WORKSPACE_ROOT/<empresa>/<task>`, logins de CLI em `AGENT_HOME/<empresa>/<provider>`, token e chave de IA resolvidos pela empresa da tarefa, e o mascaramento de logs remove os segredos de **todas** as empresas. Uma fonte só agenda trabalho nos projetos da própria empresa. Premissa: há um único operador; as empresas não acessam a instalação. Banco e worker são compartilhados (as filas são uma por empresa); não use como SaaS aberto a terceiros.

## Variáveis `.env`

| Variável                                        | Finalidade                                                 |
| ----------------------------------------------- | ---------------------------------------------------------- |
| NODE_ENV, PORT                                  | Ambiente e porta da API (3000)                             |
| DATABASE_HOST, DATABASE_PORT                    | PostgreSQL, padrão localhost:5432                          |
| DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD | Banco e credenciais                                        |
| RABBITMQ_URL                                    | Broker, padrão local `amqp://guest:guest@localhost:5672`   |
| TENANTS_FILE                                    | Caminho do `tenants.yaml`                                  |
| WORKSPACE_ROOT                                  | Diretório dedicado, padrão `./workspaces`                  |
| CODEX_BIN, CLAUDE_BIN                           | Executáveis instalados em diretórios visíveis no sandbox   |
| CODEX_TIMEOUT_MS, CLAUDE_TIMEOUT_MS             | 1.800.000 ms cada                                          |
| AGENT_HOME                                      | Raiz dedicada de autenticação: `<empresa>/<codex\|claude>` |
| BWRAP_BIN                                       | Executável `bwrap` obrigatório                             |
| MAX_OUTPUT_BYTES                                | Limite por stream, padrão 1 MiB; excesso mata o processo   |
| MAX_ATTEMPTS, RETRY_DELAY_MS                    | 3 tentativas, intervalo de 30 s × tentativa                |
| TEST_TIMEOUT_MS                                 | 600.000 ms                                                 |
| `<EMPRESA>_*`                                   | Segredos referenciados pelo `tenants.yaml`                 |

Os comandos `test` e `prepare` de cada projeto são arrays de argv, executados sem shell e dentro do sandbox; `test` roda sem rede. `prepare: [npm, ci, --ignore-scripts]` instala dependências sem lifecycle scripts; pacotes nativos podem exigir preparação específica confiável. Não copie comandos de Issues para esses campos.

## GitHub: token ou App

Caminho mais simples: token fine-grained limitado ao repositório alvo, com Contents e Pull requests em read/write e Metadata em read. O token precisa respeitar as regras de proteção de branches da organização. Não conceda bypass de proteção ou administração.

Para uma GitHub App, configure essas permissões, assine Issues e instale a App no repositório. É possível fornecer um installation access token válido no `token` do host, mas **emissão e renovação automática de tokens de App não estão implementadas**. Tokens curtos exigem renovação pelo operador e reinício dos processos. O MVP não contém gerador JWT de App.

## Usar pelo VS Code (MCP) e enviar arquivos

Além de Issues, tarefas podem ser criadas pela API do operador, com anexos (prints, PDFs, logs, specs). O jeito prático é o servidor MCP: no Claude Code do VS Code você diz _"manda pro time da acme: corrige o bug X, anexa esse print"_ e ele chama a ferramenta.

1. No `.env`, defina `API_TOKEN` (`openssl rand -hex 32`) e rode `npm run build`.
2. Mantenha a API (`npm run start`) e o worker ligados.
3. Registre o servidor uma vez, para todos os projetos. Do Windows (VS Code aberto em `\\wsl.localhost\...`):

   ```bash
   claude mcp add --scope user ai-dev-team -- wsl.exe -d Ubuntu-24.04 -- bash /home/<usuário>/ai-dev-team/scripts/mcp.sh
   ```

   De dentro do WSL/Remote-WSL: `claude mcp add --scope user ai-dev-team -- bash ~/ai-dev-team/scripts/mcp.sh`.

Ferramentas: `list_tenants`, `create_task` (tenant, título, descrição, projeto opcional quando a empresa tem um só, `files` com caminhos absolutos), `get_task`, `list_tasks`, `revise_task` (ajuste no PR de uma tarefa, com `files` opcionais) e `ai_status` (credenciais de IA e quais estão em espera). Caminhos do Windows (`C:\...`, `\\wsl.localhost\...`) são convertidos para o WSL. A criação é assíncrona: devolve `taskId`; o PR aparece em `get_task` quando terminar.

Anexos:

- são gravados em `ATTACHMENTS_ROOT/<empresa>/<fonte>/<id>/` **antes** de a tarefa entrar na fila, com nomes saneados e sem sobrescrita; ficam fora do repositório e nunca entram no commit;
- o sandbox monta essa pasta somente leitura em `/attachments`, apenas se for da mesma empresa da tarefa;
- o prompt lista os arquivos; imagens PNG/JPEG/GIF/WebP vão nativamente ao Codex (`--image`) e o Claude recebe `--add-dir /attachments`;
- limites: `ATTACHMENT_MAX_FILES` arquivos de até `ATTACHMENT_MAX_BYTES` cada (padrão 10 × 10 MiB); acima disso HTTP 413 e nada é criado.

Tarefas da API recebem a chave `T-xxxxxxxx`; o PR traz o texto do pedido, já que não há issue para linkar. Endpoints (Bearer `API_TOKEN`): `GET /api/tenants`, `POST /api/tenants/:empresa/tasks` (multipart: `title`, `description`, `project`, `files`), `GET /api/tenants/:empresa/tasks[?limit]`, `GET /api/tenants/:empresa/tasks/:id`. Uma task de outra empresa responde 404. Sem `API_TOKEN` a API não existe (404). A porta 3000 escuta em todas as interfaces: não a exponha além da sua máquina/túnel do webhook.

## Harness de IA por empresa

Cada empresa pode apontar `harness` para o seu repositório de skills/agents já clonado no WSL (exemplo em `tenants.example.yaml`):

- `skills`: pastas cujas subpastas têm `SKILL.md`; `agents`: subpastas com `AGENT.md` ou arquivos `<nome>.md`; `instructions`: um Markdown opcional. Em nomes repetidos vale a primeira pasta listada; nomes iniciados com `_` (templates) e READMEs são ignorados.
- A cada execução o harness é lido de novo (um `git pull` nele vale na próxima tarefa) e montado **somente leitura** no home descartável da CLI, do mesmo jeito que o instalador oficial faz em `~/.claude`: skills em `skills/<nome>`, agents em `agents/<nome>.md`. No Codex, as instruções viram o `AGENTS.md` global e as skills vão para `CODEX_HOME/skills` (suporte a skills depende da versão do Codex).
- Links simbólicos que apontem para fora da pasta do harness são recusados; uma empresa nunca vê o harness de outra.
- O `CLAUDE.md`/`AGENTS.md` do próprio repositório agora é lido pelo agente. Settings (onde ficam hooks e plugins) só vêm do home descartável (`--setting-sources user`) e servidores MCP declarados no repositório são ignorados (`--strict-mcp-config`). O antigo `--safe-mode` desligava tudo isso, inclusive as instruções do projeto.

## Testes no container do projeto

Projetos cujo ambiente é Docker (serviços do compose, versão específica da linguagem) declaram `runner` (exemplo em `tenants.example.yaml`). Então `prepare` e `test` rodam num container descartável da imagem já existente do time, com o workspace da tarefa montado em `workdir`, na rede indicada. O agente continua no sandbox bubblewrap.

- O `docker run` é montado só a partir do `tenants.yaml`: compose files e Dockerfiles do repositório nunca são lidos, então o código da branch não muda como nem onde roda. A imagem nunca é construída a partir do repositório.
- Endurecimento: usuário do worker (root recusado), `--cap-drop ALL`, `no-new-privileges`, limites de memória/CPU/processos, `.git` somente leitura, rede `host` recusada (`none` por padrão). O container tem nome único e é removido ao final, inclusive em timeout.
- Variáveis de `env` (e `AI_TASK_ID`) vão pelo ambiente do processo, nunca na linha de comando auditada; valores de chaves com PASS/SECRET/TOKEN/KEY são mascarados nos logs.
- Requisitos: o usuário do worker no grupo `docker` e as imagens construídas (`npm run doctor` confere). **Acesso ao Docker equivale a root no host**: use esta opção só em máquina dedicada e para projetos confiáveis. Os testes usam os serviços do seu ambiente (ex.: o banco de testes do compose); rodar testes manualmente ao mesmo tempo que uma tarefa pode causar conflitos. `AI_TASK_ID` permite isolar dados por tarefa quando o projeto suportar.

## Checagens de segurança locais (`checks`)

Depois que os testes passam (e de novo depois de cada ajuste do revisor), três ferramentas gratuitas rodam em containers descartáveis, **na sua máquina**: nenhum código sai dela.

| Ferramenta                    | O que pega                                                                        | Rede                                             |
| ----------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------ |
| `gitleaks`                    | Senhas, tokens e chaves no código                                                 | Nenhuma                                          |
| `semgrep` (Community Edition) | Falhas de segurança no código (SQL injection, XSS, `eval`, criptografia fraca...) | Só para baixar as regras (`--metrics=off`)       |
| `osv` (osv-scanner)           | Dependências com vulnerabilidade conhecida, quando a mudança altera um lockfile   | Consulta o osv.dev com nome e versão dos pacotes |

**Só o que a mudança introduz conta.** Os arquivos alterados são copiados como estão agora e como eram no commit base, a mesma ferramenta roda nos dois, e o que já existia é descartado (comparando a regra e o trecho de código, não o número da linha: código legado que só mudou de lugar não vira "novo"). Assim, código legado nunca trava uma entrega, e o custo acompanha o tamanho da mudança, não do repositório (num projeto real: 98 arquivos em ~1 min).

- **Achado novo:** volta para o `fixer` (o mesmo limite de `TEST_FIX_ATTEMPTS`), com a instrução de corrigir na causa e nunca silenciar a ferramenta; a suíte roda de novo e as checagens também. Se sobrar achado, a tarefa falha antes de qualquer commit.
- **Ferramenta que não rodou** (imagem ausente, sem rede): aparece no PR com ⚠️, mas não bloqueia.
- **No PR:** seção `### Security checks` no corpo padrão e `{{CHECKS}}` no modelo do time.

```yaml
projects:
  - id: portal
    checks:
      tools: [gitleaks, semgrep, osv]
      # Regex (sem distinguir maiúsculas) dos caminhos analisados pelo Semgrep: o escopo do time.
      # Segredos são checados em qualquer arquivo alterado.
      scope: '(^|/)[^/]*review[^/]*(/|$)'
      semgrep: { configs: [p/php, p/javascript] } # conjuntos de regras do registro do Semgrep
      reportOnly: [osv] # só informa (atualizar dependências está fora do escopo do time)
      # blocking: false   # tudo só informativo
      # images: { semgrep: semgrep/semgrep:1.178.0 }   # para fixar versões
```

Antes do primeiro uso, baixe as imagens (o worker não faz `pull` sozinho):

```bash
docker pull semgrep/semgrep:latest
docker pull ghcr.io/gitleaks/gitleaks:latest
docker pull ghcr.io/google/osv-scanner:latest
```

Exemplos de uso: um projeto PHP com Semgrep só no escopo do time e dependências apenas informativas; um projeto TypeScript com o código todo (`p/typescript`, `p/nodejs`, `p/javascript`). O legado medido na primeira execução nunca bloqueia.

## Correção automática a partir dos testes

Se a validação oficial (`test` do projeto) falhar depois que o agente alterou o código, a saída dos testes volta para o agente corrigir, sobre as próprias alterações, até `TEST_FIX_ATTEMPTS` vezes (padrão 2; 0 desliga). O agente é instruído a não apagar nem enfraquecer testes existentes. `get_task` mostra `fixAttempts`. Commits retomados após uma queda não passam por esse ciclo: se falharem nos testes, a tarefa falha. Cada ciclo custa uma execução de IA e de testes a mais: considere isso no `consumer_timeout` do RabbitMQ.

## Repetir ou cancelar tarefas

- **Retry** (`retry_task` no MCP; `POST /api/tenants/:empresa/tasks/:id/retry[?revision=N]`): recoloca na fila uma tarefa ou revisão `FAILED`/`CANCELLED`, **recomeçando do zero**. A tarefa volta à ponta atual da branch base e a revisão à ponta atual do PR. Use depois de corrigir a causa (token, e-mail, configuração). Tarefa que já tem PR é recusada (409): peça uma revisão `/ai`. Uma tarefa de **método** é exceção: retoma da fase em que parou, mantendo os commits e a autorização dada no portão (a causa costuma ser externa: VPN, cota). Para recomeçar uma tarefa de método do zero, use "repetir com instrução".
- **Cancelar** (`cancel_task`; `POST .../cancel[?revision=N]`): vale para jobs na fila, em `WAITING_CAPACITY`, esperando o operador (`WAITING`) ou falhos. Um job em execução não é interrompido (409); mensagens já enfileiradas são descartadas pelo worker.
- Ambos falham com 409 se o worker estiver executando a tarefa naquele momento, e fecham a decisão aberta do job (veja abaixo).

## Decisões: dúvidas da IA e falhas

Ambiguidade é grave: se algo do card pode mudar o resultado e não está claro, a IA **não chuta**. O planner (ou o coder, quando não há planner, como em sub-tarefas e revisões) termina com um bloco `<duvidas>`. As edições são descartadas, e a tarefa fica **`WAITING`** com uma **decisão** aberta. Nada é comentado no Jira.

- **Responder:** `list_decisions` / `answer_decision` no VS Code (MCP), ou `GET /api/tenants/:empresa/decisions[?status=all]` e `POST /api/tenants/:empresa/decisions/:id/answer` com `{ "answers": [...] }` (uma por pergunta, na ordem). Cada resposta vira um **esclarecimento**, que entra em todos os prompts seguintes da tarefa e das revisões dela. A tarefa volta para a fila e recomeça, planejando de novo com a informação nova.
- **Limite:** 3 rodadas de dúvidas por tarefa/revisão. Na 4ª, a tarefa falha com "Card ambíguo demais".
- **Falhas:** quando uma tarefa ou revisão falha de vez (depois das tentativas automáticas), ela fica `FAILED` como antes (com o comentário no Jira) e abre uma decisão. As respostas são `{ "action": "retry" }`, `{ "action": "cancel" }` ou `{ "action": "retry_with_instructions", "instructions": "..." }`. A instrução vira esclarecimento.
- Uma decisão só é respondida uma vez (409 na segunda). `retry_task` e `cancel_task` continuam valendo e fecham a decisão aberta.

### Avisos no Telegram

Com `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` no `.env`, o bot avisa cada decisão nova (dúvida da IA ou falha) e cada PR aberto (`TELEGRAM_NOTIFY_PR=false` desliga os de PR). Nas falhas, os botões **Repetir** e **Cancelar** respondem a decisão direto do Telegram. Nas dúvidas também: uma pergunta com opções (o portão de um método, por exemplo) traz um botão por opção, e qualquer dúvida é respondida com **Responder** na mensagem do aviso — o texto inteiro para uma pergunta, uma linha numerada por pergunta (`1. …`, `2. …`) para várias; fora desse formato o bot explica e nada é registrado. "Repetir com instrução" continua pelo front e pelo VS Code.

- Para configurar: crie o bot com o @BotFather (`/newbot`), coloque o token no `.env`, mande "oi" ao bot e pegue o id do seu chat (`https://api.telegram.org/bot<token>/getUpdates`, campo `chat.id`). Reinicie a API.
- Só esse chat é aceito: mensagens e cliques de qualquer outro são ignorados.
- Os avisos ficam numa fila no banco (`notifications`): com o Telegram fora do ar, são reenviados (até 10 vezes, com intervalo crescente). Nada trava por causa deles.
- O token nunca aparece em logs; as perguntas da IA são gravadas e enviadas com segredos mascarados.
- Clique numa decisão já respondida (inclusive pelo VS Code) só mostra "Essa decisão já foi respondida". Se a tarefa estiver rodando naquele momento, o clique tenta de novo por alguns segundos.
- Os testes automáticos nunca falam com o Telegram: `test/setup.ts` zera as variáveis do bot.

## Front (celular e navegador)

O front fica em `https://<seu domínio ngrok>/app` (servido pela própria API). Ele usa as mesmas rotas `/api` do VS Code, com login próprio:

1. `npm run web:password` (pede a senha duas vezes, sem mostrar; mínimo 12 caracteres) e coloque a linha `WEB_PASSWORD_HASH=...` no `.env`.
2. `WEB_PUBLIC_URL=https://<seu domínio ngrok>` no `.env` (também liga os links nas mensagens do Telegram).
3. Telegram configurado (o código de acesso chega por ele). `npm run build:web` e reinicie a API.

- **Login:** senha → código de 6 dígitos no Telegram (5 minutos, uso único). Sessão de 30 dias num cookie seguro; "sair" revoga. Cada login novo avisa no Telegram.
- **Proteções:** 5 erros bloqueiam o IP por 15 minutos (20 no total bloqueiam todos); ações só da origem do próprio front; cabeçalhos de segurança em `/app`. Sem `WEB_PASSWORD_HASH` ou sem Telegram, o login não existe (404).
- **Iniciar pelo card:** `POST /api/tenants/:empresa/tasks/from-jira {"key":"PF-123"}` (e o botão no front) inicia o card como se tivesse a label, sem precisar dela; não duplica tarefa nem toma branch existente, e diz o motivo quando não inicia.
- **Ao vivo:** `GET /api/events` (SSE) avisa mudanças de tarefas, revisões e decisões.
- Na primeira visita de cada navegador, o ngrok gratuito mostra uma tela de aviso: clique em "Visit Site".

## Rodar como serviço (systemd no WSL)

Para desenvolvimento, `npm run start:all` sobe API e worker num terminal só. Para deixar rodando:

```bash
npm run build
bash scripts/install-services.sh --ngrok   # API, worker e túnel; sem --ngrok, só API e worker
sudo loginctl enable-linger $USER           # uma vez: mantém os serviços sem terminal aberto
journalctl --user -u ai-dev-team-worker -f  # logs
```

As unidades (`deploy/systemd/`) reiniciam sozinhas em caso de falha e usam o Node do nvm. O túnel usa `NGROK_DOMAIN` do `.env`. Postgres e RabbitMQ voltam sozinhos (`restart: unless-stopped`). Depois de `git pull`/`npm run build`, aplique com `systemctl --user restart ai-dev-team-api ai-dev-team-worker`. O WSL encerra a distribuição depois de um tempo sem sessões abertas; se isso acontecer, abrir um terminal do Ubuntu sobe tudo de novo.

## Iterar no PR: code review e `/ai <instruções>`

Quando o PR não ficou como esperado, o revisor pede o ajuste do jeito que já trabalha, e a IA aplica num novo commit no mesmo PR:

| Onde                                                     | Como o pedido chega                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub**                                               | Review com **"Request changes"**: o texto da revisão e todos os comentários dela nas linhas do código (arquivo, linha, respostas) viram uma revisão. Aprovações e reviews só com comentário não disparam nada. Precisa do evento **Pull request reviews** no webhook (ou "Send me everything").                                                                                                                                                            |
| **Jira + Bitbucket/GitHub** (sem webhook do repositório) | Card movido para o status de **Change request**: os comentários novos **do card e do PR** — inclusive os feitos nas linhas do código, com arquivo e linha — viram uma única revisão. Comentários resolvidos, rascunhos (ainda não publicados), apagados e os do próprio AI Dev Team ficam de fora; cada comentário é usado uma vez. Se o PR não puder ser lido naquele momento, o card fica para a próxima leitura, em vez de aplicar só metade do pedido. |
| **Comentário `/ai ...`**                                 | Pedido avulso, a qualquer momento (GitHub; Bitbucket só com webhook).                                                                                                                                                                                                                                                                                                                                                                                      |

- **Comentários de bots** (contas de aplicativo, como o agente de qualidade do pipeline) são ignorados por padrão: são longos, se repetem a cada execução do pipeline e vão além do card. Para incluí-los no projeto: `pullRequest: { botComments: true }`.
- O agente trata cada ponto; conversa sem pedido de mudança não exige alteração. O que estiver errado, ambíguo ou fora do escopo ele **não aplica às cegas**: explica.
- **Resposta no PR:** o AI Dev Team comenta o commit aplicado e, ponto a ponto, o que foi feito e o que não foi aplicado (com o motivo).

- **`/ai` no PR do GitHub:** comente `/ai troque o nome da função para greet e cubra o caso vazio`. O comentário precisa começar com `/ai`, ser de um autor em `allowedAssociations` e não vir de bot. O webhook precisa do evento **Issue comments**, além de Issues.
- **No VS Code:** _"pede pro time ajustar o PR da tarefa X: ..."_ → ferramenta `revise_task` (aceita `files`). Serve para tarefas de qualquer origem, inclusive Jira e API.
- **API:** `POST /api/tenants/:empresa/tasks/:id/revisions` (multipart: `instructions`, `files`).

Como funciona:

- a revisão parte do **head atual da branch do PR**, incluindo commits feitos por pessoas, e adiciona um commit `fix(ai): <chave> revision N`. Nunca há push forçado: se a branch mudar durante a revisão, o push é recusado e a revisão falha, sem sobrescrever nada;
- o agente recebe a tarefa original, as revisões anteriores, o pedido atual, os anexos (os da tarefa e os da revisão, em `/attachments/rev-<id>/`) e o comando para ver o diff completo do PR;
- mesmo pipeline da tarefa: fallback de credenciais, testes obrigatórios, validação de arquivos protegidos, retry e espera por capacidade;
- o resultado, commit aplicado ou motivo da falha, é comentado no PR. A tarefa continua `SUCCESS`; uma revisão que falha não afeta o PR;
- revisões de uma tarefa rodam uma de cada vez, na ordem. O mesmo comentário reentregue pelo GitHub não gera duas revisões;
- só depois de a tarefa ter aberto o PR, e no máximo `MAX_REVISIONS` (padrão 10) por tarefa. Fora disso, o webhook responde 202 com o motivo no log de entregas e a API responde 409.

`get_task` lista as revisões com status, commit e erro. Para empresas cujas tarefas vêm do Jira mas o código está no GitHub, declare uma fonte `github-issues` com `createFromIssues: false`: ela só atende comentários `/ai`.

### Histórias com sub-tarefas e Change request (Jira)

- **Gatilho recomendado:** card atribuído a você **e** com a label `[ai-dev]` (`assignee = currentUser() AND labels = "[ai-dev]" ...`; com colchetes, a label precisa de aspas na JQL). Cards já existentes entram assim que passam a bater com a JQL.
- **Sub-tarefas (`subtasks: same-pr`, padrão):** o card pai vira **um PR**, com **um commit por sub-tarefa**, na ordem da tabela de sub-tarefas do card (reordene no Jira para mudar a ordem). Sub-tarefas já concluídas são puladas, e as próprias sub-tarefas nunca são tarefas avulsas. A primeira etapa abre o PR draft; cada etapa seguinte parte do estado atual do PR, recebe a história completa, o plano com o que já foi feito e o seu próprio texto e anexos, roda os testes e gera o commit `feat(ai): <sub-tarefa> <título>`.
  - Jira: o pai vai para `start` ao ser aceito e para `review` quando a última etapa entra. Cada sub-tarefa vai para `start` quando começa e para `review` com o seu commit.
  - Uma etapa que falha **para a cadeia**: os dois cards são comentados. Corrija (à mão no PR, ou `/ai`) e repita a etapa (`retry_task` com `revision`); a cadeia continua sozinha.
  - Etapas automáticas não contam no `MAX_REVISIONS`.
  - `subtasks: separate`: cada card que bate com a JQL, sub-tarefa inclusive, vira tarefa e PR próprios.
- **Uma branch e um PR por sub-tarefa (`subtasks: branch-per-subtask`):** para times que empilham as sub-tarefas (migration → backend → front). A história ganha a branch `branch` do projeto (ex.: `feature/PF-23986`), criada a partir do `defaultBranch` pela primeira sub-tarefa. Cada sub-tarefa aberta, na ordem do card, ganha sua branch (`feature/PF-24275`) a partir da **anterior**, com PR **para a branch da história**; a próxima só começa quando a anterior abre o PR. O PR da história para o `defaultBranch` é manual. Ajustes pedidos no PR de uma sub-tarefa (Change request no card dela) entram como commit na branch dela.
  - Branch que já existe no repositório (criada à mão) **nunca é assumida**: a tarefa falha avisando. Rótulo só em histórias novas.
  - Jira: a história vai para `start` ao ser aceita e para `review` quando a última sub-tarefa abre o PR; cada sub-tarefa vai para `start` ao começar e para `review` com o PR. Falha de uma sub-tarefa para a cadeia e é comentada nos dois cards; `retry_task` a retoma.
- **Padrão de branch (`branch`):** `{key}` (chave do card) e/ou `{id}` (id da tarefa); padrão `ai/task-{id}`. `protectedBranches` nunca são usadas (main/master/develop/production sempre protegidas).
- **Modelo de PR do time (`pullRequest.template`):** arquivo Markdown (caminho relativo ao `tenants.yaml`) com `{{PLACEHOLDERS}}`: `BRANCH_URL` (de `pullRequest.branchUrl`, com `{key_lower}`, `{key}`, `{branch}`), `KEY`, `TITLE`, `ISSUE_URL`, `PROBLEM`, `SOLUTION`, `HOW_TO_TEST`, `DATABASE`, `MIGRATIONS`, `TESTS_WRITTEN`, `TESTS_PASSING`, `TRANSLATIONS` (✅/⬜/➖), `TEST_COMMAND`. O sistema preenche o que sabe (testes, migrations, URL); o texto vem de um bloco `<pr>` que o agente escreve ao terminar. Itens que só humanos atestam (code review, design, P.O., infra) ficam ⬜.
- **Regras do projeto (`instructions`):** texto acrescentado a todo prompt do projeto (ex.: traduções PT/EN/ES obrigatórias).
- **Change request (`transitions.changeRequest`):** quando um card com PR aberto vai para esse status, os **comentários novos do card e do PR** (inclusive nas linhas do código; exceto os do próprio AI Dev Team, que começam com "AI Dev Team", resolvidos, rascunhos e de bots) viram uma revisão no mesmo PR — veja [Iterar no PR](#iterar-no-pr-code-review-e-ai-instruções). O card vai para `start` enquanto o agente trabalha e volta para `review` com o commit. Cada comentário é usado uma vez.
- Imagens embutidas na descrição aparecem no texto como `[anexo: <arquivo>]`, o mesmo nome em `/attachments`. Links externos (Figma, Google Docs) não são acessíveis ao agente: anexe as imagens no card.

## Bitbucket Cloud

Host `type: bitbucket` (exemplo completo, a Globex, em `tenants.example.yaml`); `repository` é `workspace/repo_slug`.

- Autenticação: `auth: access-token` (padrão), com um access token de repositório, projeto ou workspace (permissões de escrita em Repositories e Pull requests), ou `auth: api-token` + `email`, com um API token da conta Atlassian (escopos `read/write:repository:bitbucket` e `read/write:pullrequest:bitbucket`). Clone e push usam os usuários estáticos documentados pela Atlassian (`x-token-auth` / `x-bitbucket-api-token-auth`) em header HTTP, nunca gravados no remote. App passwords foram descontinuadas pela Atlassian e não são suportadas.
- O PR é criado como **draft**, sem fechar a branch de origem; uma busca por branch antes/depois da criação evita PR duplicado. Resultados de revisões são comentados no PR.
- Revisões pelo PR: fonte `type: bitbucket` (webhook). No repositório, em Repository settings → Webhooks, aponte para `/webhooks/<empresa>/<fonte>` com o evento **Pull request: Comment created** e o mesmo segredo; a assinatura `X-Hub-Signature` é validada. Comentários `/ai ...` inline levam o arquivo e a linha para as instruções. `allowedUsers` (account id ou nickname) restringe quem dispara; vazio aceita quem pode comentar no repositório.
- Com tarefas vindas do Jira, a chave (`ENG-123`) no commit e no título do PR faz a integração Jira ↔ Bitbucket mostrar o PR no card.
- Bitbucket Data Center (servidor próprio) ainda não é suportado.

## Jira

Fonte `type: jira` (exemplo completo em `tenants.example.yaml`). Funciona por **polling de JQL** dentro do processo da API: não exige URL pública nem webhook de administrador do Jira.

- A cada `pollSeconds` (mínimo 30), busca a primeira página da `jql`. Cada card vira **uma** tarefa; cards já aceitos custam só uma consulta no banco. Com várias réplicas da API, um lock no PostgreSQL faz só uma buscar por vez.
- O projeto (repositório) sai de `projects` (chave do projeto no Jira → id do projeto) ou `defaultProject`. Cards sem mapeamento são ignorados e registrados em log uma vez.
- A descrição é convertida do formato rico do Jira Cloud (ADF) para texto; no Data Center, o wiki markup vai como está.
- Anexos do card são baixados com a credencial do Jira, **somente do mesmo domínio do `baseUrl`**, e seguem o mesmo caminho dos anexos do VS Code. Arquivos acima do limite são ignorados e isso é anotado no texto da tarefa.
- Retorno no card, sempre sem afetar a tarefa se o Jira falhar: ao aceitar, aplica `transitions.start` e comenta; ao abrir o PR, comenta o link e aplica `transitions.review`; em falha definitiva, comenta o erro (mascarado). `transitions` aceita o nome da transição ou do status de destino.
- A chave (`API-123`) vai na mensagem de commit e no título do PR, que é o que as integrações GitHub/Bitbucket ↔ Jira usam para mostrar o PR no card. Não há "Closes" automático: o card anda pelas transições.

Cloud: `baseUrl: https://<empresa>.atlassian.net`, `email` da conta e API token. Data Center: `deployment: datacenter` e Personal Access Token em `token`. Recomendado: um usuário técnico só com acesso aos projetos envolvidos, porque os comentários saem em nome dele. `baseUrl` precisa ser https.

## Configurar webhook

No repositório GitHub: Settings → Webhooks → Add webhook.

1. Payload URL: `https://SEU-DOMINIO/webhooks/<empresa>/<source>`, por exemplo `/webhooks/acme/github`.
2. Content type: `application/json`.
3. Secret: exatamente o `webhookSecret` daquela fonte. Cada empresa tem o seu; um payload assinado com o segredo de outra é recusado.
4. Selecione eventos individuais e marque **Issues** e **Issue comments** (este para `/ai` nos PRs); mantenha SSL verification habilitado.
5. Ative o webhook. O evento ping retorna 202 ignorado; `issues.opened` cria tarefas (a menos que `createFromIssues: false`) e comentários `/ai ...` em PRs pedem revisões.

Use proxy HTTPS/túnel autorizado apontando para porta 3000. Preserve o corpo e o header `X-Hub-Signature-256`. O corpo é validado com HMAC SHA-256 e comparação em tempo constante. O parser padrão aceita até aproximadamente 100 KiB; payloads maiores são rejeitados antes do controller.

O filtro de associação impede que qualquer desconhecido acione o worker em um repositório público. OWNER/MEMBER/COLLABORATOR são aceitos por padrão (`allowedAssociations`). Assinatura válida, repositório declarado nos `projects` daquela empresa e associação permitida são três verificações distintas. Empresa ou fonte desconhecida responde 404, sem revelar quais existem.

Payload reduzido de exemplo:

```json
{
  "action": "opened",
  "repository": {
    "name": "demo",
    "full_name": "example/demo",
    "default_branch": "main",
    "owner": { "login": "example" }
  },
  "issue": {
    "id": 123,
    "number": 7,
    "title": "Adicionar função hello com teste",
    "body": "Siga os padrões existentes.",
    "state": "open",
    "html_url": "https://github.com/example/demo/issues/7",
    "author_association": "OWNER"
  }
}
```

## Executar

Do diretório do projeto, em dois terminais do usuário não root:

```bash
# Terminal 1: API e publicador
npm run start:dev
```

```bash
# Terminal 2: consumidor e publicador
npm run worker
```

Após build, use `node dist/main.js` e `node dist/worker.js`. Os processos precisam ler o mesmo `.env` e executar a partir da raiz do projeto, que contém `prompts/`. RabbitMQ management: `http://localhost:15672`. As portas Compose ficam presas ao loopback. Volumes nomeados persistem banco e filas; `docker compose down` os preserva.

Para simular um webhook assinado:

```bash
TENANT=acme REPOSITORY=acme/site WEBHOOK_SECRET=... ISSUE_NUMBER=7 ISSUE_ID=123 bash scripts/test-webhook.sh
```

Esse script **agenda trabalho real** se o worker estiver ligado. Use um repositório de teste e número de Issue existente, porque o PR contém `Closes #7`. Repetir o mesmo ISSUE_ID deve devolver o mesmo taskId. Um novo ID produz nova tarefa.

## Homologar uma Issue real

1. Prepare um repositório pequeno com package-lock.json, teste determinístico e branch padrão existente.
2. Configure as variáveis, autenticação, Compose, migrations, API e worker como acima.
3. Abra uma Issue como proprietário/colaborador: “Adicione uma função hello(name) com um teste unitário, seguindo os padrões atuais”.
4. Confirme em Recent Deliveries do webhook o HTTP 202 e anote taskId da resposta.
5. Consulte tasks, agent_runs e pull_requests usando `scripts/inspect-task.sql` ou um cliente PostgreSQL.
6. Confirme sequência de etapas: WORKSPACE → PREPARED → DEPENDENCIES (opcional) → AGENT → DIFF → TESTS → COMMIT → COMMITTED → PUSH → PULL_REQUEST → DONE.
7. Confirme branch `ai/task-<UUID>`, commit fixo, testes aprovados, draft PR e status SUCCESS. Revise o diff antes de mesclar.
8. Reenvie a mesma entrega: não deve haver nova tarefa, execução ou PR.

O critério de aceitação do MVP só estará homologado quando esse teste real chegar a SUCCESS e o PR existir no GitHub. Nenhum merge é automático.

## Observabilidade e falhas

Logs JSON incluem evento, taskId, issueId nas etapas, provider, status e duração nos subprocessos. AgentRun registra comandos do orchestrator, saídas limitadas, exit code e início/fim. Comandos internos da IA aparecem no JSON da própria CLI, não como registros AgentRun individuais. Os prompts vão por stdin, não pela linha de comando.

O mascaramento remove secrets conhecidos e padrões comuns; não garante detectar todo segredo que o repositório ou a IA invente. Evite dados sensíveis no repositório alvo e restrinja acesso ao banco de auditoria.

| Sintoma                                                 | Verificação/ação                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP 401                                                | Secret ou bytes do corpo alterados pelo proxy                                                                                                    |
| HTTP 403                                                | Owner/repo ou associação do autor não permitidos                                                                                                 |
| HTTP 400/413                                            | Formato inválido ou corpo acima do limite                                                                                                        |
| PENDING sem execução                                    | Broker/worker fora do ar; confira outbox não publicada e logs                                                                                    |
| Worker recusa inicialização                             | Linux e usuário não root são obrigatórios                                                                                                        |
| bwrap “Operation not permitted”                         | Host bloqueia user namespaces; use VM Linux compatível, sem desligar sandbox                                                                     |
| CLI não encontrada                                      | Instale em /usr ou /usr/local e configure caminho absoluto                                                                                       |
| Codex/Claude sem autenticação                           | `apiKey` da credencial válida ou login em `AGENT_HOME/<empresa>/<credencial>`; a credencial fica em espera `auth` até corrigir. Veja `ai_status` |
| Tarefa parada em `WAITING_CAPACITY`                     | Todas as credenciais da empresa em espera; `ai_status` mostra até quando e o último erro. Adicione outra credencial ou aguarde                   |
| API/worker não sobem: `tenants: ...`                    | Campo inválido ou variável `${...}` ausente; a mensagem indica o caminho. Rode `npm run doctor`                                                  |
| `credential "x" uses provider "y", not in ai.providers` | Credencial de provedor que o contrato da empresa não permite; ajuste a config, não o código                                                      |
| HTTP 404 no webhook                                     | Empresa ou fonte da URL não existe no `tenants.yaml`                                                                                             |
| Claude não executa um comando                           | Política acceptEdits é conservadora; testes continuam sob responsabilidade do worker                                                             |
| NO_CHANGES                                              | A IA não produziu diff; revise a Issue e AgentRun                                                                                                |
| Testes falham                                           | Corrija o projeto/ambiente/comando; não é feito push                                                                                             |
| Git push falha                                          | Token, regras da organização, rede e branch remota; nunca é feito force push                                                                     |
| Falha durante clone                                     | Workspace parcial falha com segurança; preserve-o para diagnóstico e abra nova Issue após corrigir                                               |
| PR criado mas resposta perdida                          | Próxima tentativa procura PR existente pela branch                                                                                               |
| Task FAILED                                             | Terminal no MVP; não há endpoint de retry manual. Corrija a causa e abra nova Issue                                                              |

O timeout de acknowledgement do RabbitMQ no Compose é 6h. Uma entrega pode rodar a IA uma vez por credencial disponível, então mantenha `consumer_timeout` acima de `nº de credenciais × timeout do agente + prepare + testes` da maior empresa (padrão: 3 × 30 min + 2 × 10 min). Anexos também não são removidos automaticamente. As linhas de outbox/DLQ/auditoria e os workspaces não são removidos automaticamente. Defina retenção operacional.

## Limites de segurança e de escopo

Cada task recebe clone próprio. Bubblewrap monta o filesystem de runtime em leitura, expõe só aquele workspace e mantém `.git` somente leitura para IA/testes. Host home, `.env` da aplicação e outros workspaces ficam fora do sandbox. Diretórios de runtime /usr e libs ainda são visíveis; o host deve ser dedicado e não guardar secrets nesses locais.

As etapas de IA e instalação de dependências têm rede para acessar seus serviços. Testes externos rodam sem rede. **Não há proxy de egress, quotas de CPU/memória/disco, segredo de IA inacessível ao agente nem isolamento multitenant.** Não use o MVP como executor aberto de código hostil. Para produção com usuários não confiáveis, adicione VMs/containers por tarefa, quotas e controle de saída de rede.

O worker usa `spawn` com arrays e `shell:false`, ambiente mínimo, timeout e limite de saída. Git hooks e credential helpers são desativados. Push usa URL configurada, SHA fixo e ref explícita, sem force. Credenciais não são persistidas no remote. Mudanças em secrets, symlinks, workflows e configurações de agentes são recusadas. Repositórios que já versionam arquivos de credenciais são recusados antes da IA. `.env.example` é permitido como arquivo existente, mas não pode ser alterado pela IA nesta política conservadora.

O sandbox não é um mecanismo de recuperação universal. Uma queda no meio do clone ou perda do workspace pode exigir nova tarefa; não removemos dados automaticamente. Locks, confirmação de mensagens e reconciliação de PRs precisam também ser validados com PostgreSQL/RabbitMQ reais antes de produção.

## Referências consultadas

- [Codex CLI](https://developers.openai.com/codex/cli/reference)
- [Claude Code CLI](https://code.claude.com/docs/en/cli-reference)
- Os arquivos em `docs/cli/` registram o help efetivamente observado durante esta entrega.

## Escritório da guilda

Com a API em `localhost:3000` e a autenticação web configurada, execute `npm --prefix web run dev` e acesse `http://localhost:5173/app/escritorio`. O frontend mantém o login e as rotas existentes. Cada tarefa ou revisão em uma função tem seu próprio personagem, identificado pela chave da missão. O mesmo personagem caminha entre as estações quando a etapa muda. Clique nele para abrir o detalhe e suas ações; os personagens-base e as mesas abrem o resumo da função. O mural reúne tarefas e PRs, o aviso abre decisões e o baú lista entregas concluídas.

Cada estação oferece de um a quatro lugares, conforme `worker.concurrency` da empresa e o número de membros na função. A sala alarga e mantém o tamanho durante a visita; ao trocar de empresa ou alternar a demonstração, o cálculo recomeça. Se houver mais de quatro membros em uma função, o rótulo mostra `+N` e todos continuam acessíveis nos cartões, inclusive os excedentes. Tarefas trabalhando têm prioridade de lugar. As abas mostram também quantas tarefas de cada empresa estão em execução, mesmo quando você está em outra sala.

A aba **Todas as empresas** é opcional e aparece quando há pelo menos duas empresas. O escritório continua abrindo na primeira empresa, e a escolha não é lembrada entre visitas. Essa aba mostra um campus com salas independentes em uma grade de até três por linha, separadas por pátios. Cada sala mantém seus lugares e personagens; eles não atravessam entre empresas. Ligar a demonstração sai do campus e usa uma sala só.

Cada empresa recebe uma cor de uma paleta de oito tons. No campus, essa cor identifica a placa da sala, os chips nos painéis e uma faixa sob a chave dos personagens. Clique na placa para enquadrar a sala em modo manual; os botões de sala acima do mapa oferecem a mesma ação pelo teclado. Os cartões agrupam todas as chaves por empresa, as áreas e o histórico agregam os dados, e o detalhe sempre abre na empresa da tarefa, inclusive para executar suas ações. **Abrir sala** no painel de uma estação volta à aba daquela empresa. Uma atualização SSE preserva os personagens e animações das salas que não mudaram; o crescimento dos lugares é controlado por empresa durante a visita ao campus.

A câmera inicia em **Acompanhar**: enquadra os personagens andando; quando eles param, enquadra quem trabalha; se ninguém trabalha, mostra a sala inteira. **Visão geral** mostra toda a sala ou o campus inteiro. No campus, o acompanhamento considera os personagens de todas as empresas; no celular, quando ninguém trabalha ou caminha, enquadra a primeira sala com tarefas. Arrastar o mapa, usar a roda do mouse, fazer pinça no celular ou usar **Aproximar** e **Afastar** ativa o modo manual. Com o mapa focado pelo teclado, use as setas para mover e `+`/`-` para ampliar ou reduzir. Clique em **Acompanhar** para retomar o acompanhamento. As chaves nos cartões e as tarefas do histórico centralizam a câmera no membro correspondente e abrem o detalhe. O mapa cabe na tela, inclusive no celular.

Credenciais, estados e atualizações vêm das tarefas e revisões via SSE, sem inventar progresso percentual ou identidades de agentes. Contagens e histórico estão limitados às 50 missões retornadas por empresa. A demonstração exibe cinco tarefas simuladas, duas vagas por estação e paralelismo; seus painéis continuam consultando apenas missões reais.

A apresentação Phaser fica em `web/src/office/game.ts`, o desenho de cada sala em `room.ts`, a grade e o modelo do campus em `campus.ts`, os corredores e marcos em `layout.ts`, os lugares em `seats.ts`, o enquadramento em `camera.ts` e a associação de dados às funções em `spots.ts`. Os sprites existentes são reutilizados, sem novas dependências. A preferência de movimento reduzido posiciona personagens e câmera diretamente, sem caminhadas ou balanço. Valide com `npm --prefix web test`, `npm --prefix web run build` e `npm test`.
