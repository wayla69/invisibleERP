import { Controller, Post, Body, Module } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AgentService } from './agent.service';
import { PosModule } from '../pos/pos.module';
import { InventoryModule } from '../inventory/inventory.module';
import { FinanceModule } from '../finance/finance.module';
import { AnalyticsModule } from '../analytics/analytics.module';

const ChatBody = z.object({ message: z.string().min(1), history: z.array(z.any()).optional(), agent_type: z.string().optional() });

@Controller('api')
export class AiController {
  constructor(private readonly agent: AgentService) {}

  // POST /api/chat — V2 ต่อ tools จริง (เดิม V1 เป็น passthrough ดึง DB ไม่ได้)
  @Post('chat') @Permissions('ai_chat', 'dashboard')
  chat(@Body(new ZodValidationPipe(ChatBody)) b: { message: string; history?: any[] }, @CurrentUser() u: JwtUser) {
    return this.agent.chat(b.message, b.history ?? [], u);
  }
}

@Module({
  imports: [PosModule, InventoryModule, FinanceModule, AnalyticsModule],
  controllers: [AiController],
  providers: [AgentService],
})
export class AiModule {}
