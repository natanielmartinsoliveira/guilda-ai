Brief the person who decides, in plain words, read-only: change nothing.

The question they must answer:
{{QUESTION}}

{{#FILES}}What the analysis changed:
{{FILES}}{{/FILES}}
Write the brief as the last ```json block of your answer:
{"summary": "what is decided, one sentence", "recommendation": {"approve": true, "why": "..."}, "choices": [{"question": "...", "options": ["what the specification says", "the alternative"], "recommended": 0, "why": "..."}], "risks": [{"level": "low", "text": "..."}], "highlights": ["..."]}
Option 0 of each choice is what the specification already says.
