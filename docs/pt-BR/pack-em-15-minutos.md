# Um pacote de empresa em 15 minutos

Um pacote é um repositório git privado com tudo o que é de uma empresa para a Guilda AI: o host do código, os projetos, como eles são construídos e testados e o que os agentes aprenderam neles. O núcleo não tem nenhuma empresa. Este guia vai do zero ao primeiro card.

## 1. Crie o pacote (1 minuto)

```bash
npm run pack:init -- ~/guilda-packs/acme https://git.acme.test/shop/orders --name "Acme" [--coder https://coder.acme.test]
```

A URL é a do primeiro repositório da empresa, como você copia (https, `git@` ou `ssh://`). Ela diz o host: GitHub, Bitbucket ou um servidor GitLab. Com `--coder`, as tarefas rodam no workspace Coder de cada pessoa e nada é publicado até você pedir (ensaio). O pacote é conferido antes de ser gravado.

Você recebe:

| Arquivo                | O que é                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `company.yaml`         | A empresa: política de IA, host, `projectDefaults` (o que todo projeto compartilha) e o primeiro projeto |
| `requires.yaml`        | O que cada pessoa preenche no próprio `.env`: nome e e-mail dos commits, token do host, workspace Coder  |
| `stacks/node-npm.yaml` | Uma stack de exemplo: o `prepare`/`test` de um tipo de projeto, com `{{placeholders}}`                   |
| `lessons/_all.md`      | Lições de todos os projetos (os agentes recebem em toda tarefa)                                          |
| `README.md`            | Os próximos passos, para quem abrir o pacote                                                             |

## 2. Diga como o projeto é testado (5 minutos)

O primeiro projeto começa com um `test` que falha de propósito: nenhuma tarefa passa sem os testes do projeto. No `company.yaml`, ou escreva o comando:

```yaml
test: [sh, -c, 'docker run --rm --network none -v "$PWD":/app -w /app node:22 npm test']
```

ou aponte uma stack, adaptando `stacks/node-npm.yaml` (ou escrevendo outra, como `stacks/php-docker.yaml`):

```yaml
stack: { name: node-npm }
```

Os testes rodam sem rede. Ponha no `projectDefaults` o que todo projeto compartilha (a stack também: `stack: node-npm`), para cada projeto declarar só o que muda.

## 3. Publique e configure a sua instância (5 minutos)

```bash
cd ~/guilda-packs/acme && git init && git add . && git commit -m "Pacote Acme" && git push <repositório privado>
cd <guilda-ai> && npm run setup     # informe a URL git do pacote; ele pede os valores do requires.yaml
npm run doctor                      # confere a configuração e as ferramentas
```

Cada colega faz só este passo, com a mesma URL do pacote.

## 4. Mais projetos (1 minuto cada)

```bash
npm run project:add -- ~/guilda-packs/acme https://git.acme.test/shop/billing
```

Ele pergunta ao host a branch padrão e os arquivos da raiz, escolhe a stack cujos arquivos de `detect` o repositório tem, tira o reference do workspace dos outros projetos, confere o pacote e mostra o bloco curto antes de gravar.

## 5. O primeiro card (3 minutos)

Comece uma tarefa pelo painel (**Nova tarefa**), ou ligue uma fonte de cards (Jira, Businessmap, GitHub Issues: [sources.md](sources.md)). Acompanhe na tela da tarefa: métricas, decisões e, no fim, o PR rascunho (ou o ensaio para conferir no workspace).

Quando algo der errado e você responder, a tela da tarefa sugere aquilo como lição do projeto: guarde e commite o pacote, para a próxima tarefa (e os colegas) já saberem.

Mais: [packs.md](packs.md) (todas as opções de um pacote), [methods.md](methods.md) (o jeito de trabalhar próprio de uma empresa), [coder.md](coder.md) (workspaces Coder).
