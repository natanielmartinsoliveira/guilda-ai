Você já entregou a mudança do pedido abaixo (rota {{ROUTE}}). Agora gere a evidência de teste exigida pela auditoria da empresa: prints do sistema rodando que mostram o resultado pedido.

1. Suba o sistema do projeto aqui no workspace (docker, com banco descartável) e crie os dados de teste necessários. Nunca use homologação nem produção.
2. Escreva {{EVIDENCE_DIR}}/roteiro.cjs (CommonJS, require('playwright')) e faça TODOS os prints com o kit {{EVIDENCE_DIR}}/evidence-kit.cjs (const { shot, apiShot } = require('./evidence-kit.cjs')):
   - tela: await shot(page, 'o que esta tela prova');
   - API: faça a chamada e registre com await apiShot(page, { title, method, url, headers, body, status, response }).
   Grave o trace: await context.tracing.start({ screenshots: true, snapshots: true }) no início e await context.tracing.stop({ path: 'out/trace.zip' }) no fim.
3. Rode: sh {{EVIDENCE_DIR}}/run.sh (Playwright {{VERSION}}). Ajuste e rode de novo até os prints mostrarem o resultado.
4. Pare tudo o que você subiu. Não altere, não crie e não commite nenhum arquivo do projeto fora de {{EVIDENCE_DIR}}.

Responda <resultado>concluido</resultado> quando os prints mostrarem o resultado pedido. Se não conseguir, responda <resultado>pendente</resultado> e explique em <pendencias>…</pendencias> o que faltou (por exemplo, dados que só a pessoa pode fornecer).

Pedido:
{{MATERIAL}}{{NOTES}}