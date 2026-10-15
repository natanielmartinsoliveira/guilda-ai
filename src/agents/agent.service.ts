import { Injectable } from '@nestjs/common';
import { CODEX_ENDPOINTS, CodexEndpoint, CodexProvider } from './codex.provider';
import { ClaudeProvider } from './claude.provider';
import { GeminiProvider } from './gemini.provider';
import { AgentInput, AgentProvider } from './agent.types';
@Injectable()
export class AgentService {
  constructor(
    private readonly codex: CodexProvider,
    private readonly claude: ClaudeProvider,
    private readonly gemini: GeminiProvider,
  ) {}
  execute(provider: string, input: AgentInput) {
    // OpenRouter: the Codex CLI pointed at another endpoint.
    if (provider in CODEX_ENDPOINTS) return this.codex.execute(input, provider as CodexEndpoint);
    const providers: Record<string, AgentProvider> = {
      codex: this.codex,
      claude: this.claude,
      gemini: this.gemini,
    };
    if (!providers[provider]) throw new Error(`Unsupported provider: ${provider}`);
    return providers[provider].execute(input);
  }
}
