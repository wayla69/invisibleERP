import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { CopilotService } from './copilot.service';
import { CopilotController } from './copilot.controller';

// Embedded copilot (Phase 15 — B1). Reuses the AI module's KnowledgeService (RAG) + AgentService.
@Module({
  imports: [AiModule],
  controllers: [CopilotController],
  providers: [CopilotService],
})
export class CopilotModule {}
