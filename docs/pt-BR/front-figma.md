# Fase de front (Codex + Figma)

Quando um card do Jira tem uma seção **Front-end** nos critérios de aceite e a empresa tem o
papel `frontend`, a tarefa roda em três partes, na mesma branch e com um PR só:

1. **Design**: o link do Figma (com `node-id`) da sub-tarefa, das respostas do operador ou da
   história é lido; cada tela vira uma imagem em `figma/`, com `figma/index.md` (nomes e textos
   de todas as telas). As 8 telas mais ligadas à parte de front vão como imagem para o agente.
   Sem link, valem os prints anexados. Sem nada, a tarefa para e pergunta (antes de gastar IA).
2. **Back**: o papel `coder` faz tudo, menos a seção Front-end. Commit `… (back-end)`.
3. **Front**: o papel `frontend` faz a seção Front-end, com o design. Commit `… (front-end)`.

Depois: testes, checagens de segurança e revisão automática sobre a mudança inteira.

## Configuração (`tenants.yaml`)

```yaml
ai:
  roles:
    frontend: [chatgpt, claude-max]   # Codex primeiro
figma:
  token: ${FIGMA_TOKEN}               # token pessoal, somente leitura
```

Sem `frontend`, nada muda. O token fica só no `.env` e é escondido nos logs.

## Conferir um design sem gastar IA

```bash
npm run design:check -- acme "<link do Figma com node-id>" "<texto da parte de front>"
```

Mostra a pasta com as imagens e o começo do `index.md`, ou a pergunta que a tarefa faria.

## Iniciar uma sub-tarefa sozinha

Na tela **Nova tarefa → Card do Jira**, a chave de uma sub-tarefa (empresa com
`subtasks: branch-per-subtask`) mostra **"Começar a partir de"**: a branch da história e as
branches das outras sub-tarefas que já existem no repositório. A sub-tarefa ganha a própria
branch a partir da escolhida, o PR vai para a branch da história, o texto e os prints da
história vão junto como contexto (o link do Figma dela também), e as outras sub-tarefas não
são tocadas. Se a branch da sub-tarefa já existir, ela não é iniciada.
