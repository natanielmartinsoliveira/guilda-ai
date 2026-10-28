import { createHash, randomBytes } from 'node:crypto';
/**
 * A card is text from outside: whoever can write a card can write to the agent. Two defences,
 * neither trusting the other: the card goes into prompts fenced by a marker it cannot guess (so
 * it cannot "close" the untrusted part and talk as the prompt), and a task whose card reads like
 * instructions to the AI waits for the operator before any agent sees it.
 */
const SIGNS: RegExp[] = [
  // Overriding the prompt's own rules.
  /\b(ignore|disregard|forget|override)\b[^\n.]{0,40}\b(previous|prior|above|earlier|all|system)\b[^\n.]{0,20}\b(instructions?|rules|prompt)/i,
  /\b(ignore|ignorar?|esque[cç]a|desconsidere)\b[^\n.]{0,40}\b(instru[cç][õo]es|regras|prompt)\b/i,
  // Another role for the agent.
  /\b(you are now|from now on,? you|act as|pretend to be)\b/i,
  // No \b at the end: JavaScript's \b is ASCII, and these end in ê/é.
  /\b(a partir de agora,? voc[êe]|voc[êe] agora [ée]|finja ser|aja como)/i,
  /\b(system prompt|prompt do sistema|developer message|mensagem do sistema)\b/i,
  // Secrets out of the sandbox.
  /\b(print|show|send|cat|echo|reveal|leak|upload|post|mostre|envie|imprima|revele|exiba)\b[^\n]{0,60}(\.env\b|\btoken\b|api[ _-]?key|\bsecret\b|\bsenha\b|\bpassword\b|credentials?|credenciais|id_rsa|ssh key|chave ssh)/i,
  // Data out of the workspace.
  /\b(curl|wget|nc|ncat|Invoke-WebRequest)\b[^\n]{0,80}https?:\/\//i,
  // The repository's remote.
  /\bgit\s+(push\s+(-f|--force)|remote\s+(add|set-url))\b/i,
  // Fake role or fence markers.
  /<\/?\s*(system|assistant|untrusted)\b|\[\/?INST\]|^#{1,3}\s*(system|assistant)\b|<<<\s*(END\s+)?UNTRUSTED/im,
];
const MAX_PASSAGES = 5;
/** The passages of the text that read like instructions to the AI (one line each, trimmed). */
export function suspiciousPassages(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split('\n')) {
    if (SIGNS.some((re) => re.test(line))) {
      const passage = line.trim().slice(0, 200);
      if (passage && !found.includes(passage)) found.push(passage);
    }
    if (found.length >= MAX_PASSAGES) break;
  }
  return found;
}
/** What the operator cleared: a changed card is screened again. */
export const cardSignature = (text: string) =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);
/**
 * The text between markers it cannot guess (a new random code per prompt); anything in it that
 * looks like a marker is neutralized, so the card cannot end the untrusted part early.
 */
export function fence(
  text: string,
  note: (code: string) => string,
  code = randomBytes(6).toString('hex'),
) {
  const safe = text.replace(/<<<\s*(END\s+)?UNTRUSTED/gi, '<<< (marker removed)');
  return `${note(code)}\n<<<UNTRUSTED ${code}>>>\n${safe}\n<<<END UNTRUSTED ${code}>>>`;
}
