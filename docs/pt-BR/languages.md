# Idiomas

Cada dev escolhe o idioma da própria instância no `.env`:

```
GUILDA_LANG=pt-BR   # padrão
GUILDA_LANG=en
```

Um valor diferente de `pt-BR` ou `en` impede a instância de subir.

## O que muda

- **Painel:** todas as telas, inclusive a tela de login e a Guilda. O idioma vem do servidor (`/web-api/me`), então não há escolha por navegador.
- **Telegram:** avisos de decisão, falha, PR aberto e ensaio, e as respostas aos botões.
- **Perguntas do motor:** por exemplo, as da evidência de teste e a lista de valores que faltam nos pacotes.
- **Prompts do núcleo:** com `en`, vale `prompts/en/<nome>.md`; sem a versão em inglês, cai no prompt em português.

## O que não muda

- **Prompts e formatos dos pacotes:** ficam na língua em que a empresa os escreveu. Um pacote em português continua valendo numa instância em inglês, porque o idioma só escolhe o núcleo.
- **Tags que o código lê** nas respostas da IA são as mesmas nos dois idiomas: `<resultado>concluido|pendente</resultado>`, `<pendencias>`, `<pr>`, `<revisao>`, `<veredito>aprovado|ajustes</veredito>`, `<duvidas>`, `<plano>`, `<resposta>`.
- **Decisões já gravadas** ficam no idioma em que foram criadas.
- **Logs internos** continuam em inglês.

## Traduzir mais

- Painel: `web/src/i18n/pt-BR.ts` e `web/src/i18n/en.ts`.
- Servidor: `src/i18n/pt-BR.ts` e `src/i18n/en.ts`.
- Prompts: `prompts/en/`.

Um teste falha se uma chave existir num idioma e faltar no outro. Outro teste confere que cada prompt em inglês tem as mesmas tags e os mesmos placeholders da versão em português.
