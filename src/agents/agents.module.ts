import { Module } from '@nestjs/common';
import { AgentService } from './agent.service';
import { AgentRouter } from './agent-router.service';
import { CodexProvider } from './codex.provider';
import { ClaudeProvider } from './claude.provider';
import { GeminiProvider } from './gemini.provider';
import { ProcessRunnerService } from './process-runner.service';
import { SandboxService } from './sandbox.service';
import { DockerRunnerService } from './docker-runner.service';
@Module({
  providers: [
    AgentService,
    AgentRouter,
    CodexProvider,
    ClaudeProvider,
    GeminiProvider,
    ProcessRunnerService,
    SandboxService,
    DockerRunnerService,
  ],
  exports: [AgentService, AgentRouter, ProcessRunnerService, SandboxService, DockerRunnerService],
})
export class AgentsModule {}
