import { Controller, Post, Body, Module, Sse, Query, type MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
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

  // GET /api/chat/stream — SSE: stream text deltas ของคำตอบสุดท้ายแบบ realtime
  // auth ผ่าน JwtAuthGuard เดิม (frontend ใช้ fetch() + Authorization header ได้)
  // history เป็น JSON string ผ่าน query (?history=...) เพราะ EventSource/GET ไม่มี body
  @Sse('chat/stream') @Permissions('ai_chat', 'dashboard')
  stream(
    @Query('message') message: string,
    @Query('history') historyRaw: string | undefined,
    @CurrentUser() u: JwtUser,
  ): Observable<MessageEvent> {
    const msg = (message ?? '').trim();
    let history: any[] = [];
    if (historyRaw) {
      try { const p = JSON.parse(historyRaw); if (Array.isArray(p)) history = p; } catch { /* ignore bad history */ }
    }

    return new Observable<MessageEvent>((subscriber) => {
      let cancelled = false;
      (async () => {
        try {
          if (!msg) {
            subscriber.next({ data: { done: true, reply: '', error: 'EMPTY_MESSAGE' } });
            subscriber.complete();
            return;
          }
          for await (const chunk of this.agent.stream(msg, history, u)) {
            if (cancelled) return;
            subscriber.next({ data: chunk });
          }
          subscriber.complete();
        } catch (e: any) {
          subscriber.next({ data: { done: true, reply: '', error: String(e?.message ?? e) } });
          subscriber.complete();
        }
      })();
      return () => { cancelled = true; };
    });
  }
}

@Module({
  imports: [PosModule, InventoryModule, FinanceModule, AnalyticsModule],
  controllers: [AiController],
  providers: [AgentService],
})
export class AiModule {}
