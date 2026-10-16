# Front (`/app`)

Telas para o operador: **Decisões** (dúvidas da IA e falhas), **Tarefas** (lista e detalhe, com
"Pedir ajuste") e **Nova tarefa** (card do Jira pela chave, ou tarefa livre com anexos). Funciona
no celular (abas embaixo) e no desktop (navegação lateral, lista e detalhe lado a lado).

No desktop há também a aba **Escritório**: uma sala em pixel art por empresa, com um personagem
por papel (Arquiteto, Programador, Testador, Consertador, Segurança, Revisor, Entrega). Cada
tarefa ativa é uma pasta com o número do card que anda até a mesa da etapa atual; quem está
trabalhando se mexe e mostra o card e a IA em uso. Dúvidas e falhas esperam no balcão
"Aguardando você", tarefas sem cota de IA na copa, e os últimos 8 PRs ficam no mural. Clique
numa pasta ou num personagem para ver a tarefa. Quando uma decisão espera por você (em qualquer
empresa), uma janelinha de "pedido de decisão" aparece sobre o mapa com a mais recente:
**Responder** abre a tela dela, **Depois** a esconde nesta sessão. O botão "Demonstração" movimenta pastas de
exemplo, sem gastar IA. Arte: Kenney "Tiny Dungeon" e "Tiny Town" (CC0), baixada por
`scripts/office-assets.sh`.

## Acesso

- Endereço: `https://<seu domínio ngrok>/app/` (na primeira visita de cada navegador o ngrok
  mostra um aviso: clique em "Visit Site").
- Login: senha (o hash fica em `WEB_PASSWORD_HASH`, gerado por `npm run web:password`) e depois
  o código de 6 dígitos que chega no Telegram. A sessão vale 30 dias; "Sair" encerra no servidor.
- No celular: menu do navegador → "Adicionar à tela inicial".

## Compilar e publicar

```bash
npm run build:web              # instala e compila web/ em web/dist
systemctl --user restart ai-dev-team-api
```

A API serve `web/dist` em `/app`. Sem build, `/app` responde 503 com a instrução acima.

## Desenvolver

```bash
cd web
npm run dev                    # http://localhost:5173/app/ (proxy para a API na porta 3000)
npm test                       # Vitest
```

O proxy do Vite apresenta a origem da API (`http://localhost:3000`), que é uma origem aceita
para ações com sessão.

## Atualização ao vivo

O front abre `/api/events` (SSE). Cada mudança de tarefa, revisão ou decisão recarrega a empresa
afetada. Se a conexão cair, o front tenta de novo após 1 s, 2 s, 4 s… (até 30 s) e relê tudo.
