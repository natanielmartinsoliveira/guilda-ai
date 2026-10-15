Comment cleanup: the behaviour is right; only comments that repeat what the code says go.

The person's authorization, quoted literally: «{{AUTHORIZATION}}»

1. In the files the request lists, and only in them, remove the prose comments — removal, never
   rewriting: do not replace a comment with another one and do not change code.
2. Do not commit: Guilda AI commits the changed files with the message cleanup {{SLUG}}.

The request, in the person's words:
{{MATERIAL}}{{#NOTES}}

Adjustments the person asked for at the gate:
{{NOTES}}{{/NOTES}}{{#ANSWERS}}

The person's answers to your earlier stops:
{{ANSWERS}}{{/ANSWERS}}

When you finish, last and with nothing after it: if your report leaves nothing for the person to decide or do, write <resultado>concluido</resultado>. If it does (a stop, a decision, a step only the person can take), write <resultado>parado</resultado> and, in <pendencias>…</pendencias>, copy the first lines of the report — what the person needs to do — without summarising.

Do not git push and do not create branches; Guilda AI handles the delivery.