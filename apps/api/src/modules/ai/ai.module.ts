import { Controller, Get, Post, Param, Body, Module, Sse, Query, type MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AgentService } from './agent.service';
import { AiActionService } from './ai-action.service';
import { EmbedderService } from './embedder';
import { KnowledgeService } from './knowledge.service';
import { PosModule } from '../pos/pos.module';
import { InventoryModule } from '../inventory/inventory.module';
import { FinanceModule } from '../finance/finance.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { BiModule } from '../bi/bi.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { CpqModule } from '../cpq/cpq.module';
import { ServiceModule } from '../service/service.module';
import { ProfitabilityModule } from '../profitability/profitability.module';
import { LedgerModule } from '../ledger/ledger.module';
import { ProcurementModule } from '../procurement/procurement.module';

const ChatBody = z.object({ message: z.string().min(1), history: z.array(z.any()).optional(), agent_type: z.string().optional() });
const ProposeBody = z.object({ kind: z.enum(['journal_entry', 'purchase_order']), payload: z.any(), rationale: z.string().optional(), source: z.enum(['ai', 'human']).optional() });
const RejectBody = z.object({ reason: z.string().optional() });
const IngestBody = z.object({ title: z.string().min(1), source: z.string().optional(), content: z.string().min(1) });

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

// Phase D1 — agentic write-ops queue. Propose (anyone with ai_chat) → list/approve/reject (approvals).
// The service enforces SoD (approver ≠ proposer) + the kind-specific permission (e.g. gl_post) on approve.
@Controller('api/ai/actions')
export class AiActionController {
  constructor(private readonly actions: AiActionService) {}

  @Post() @Permissions('ai_chat')
  propose(@Body(new ZodValidationPipe(ProposeBody)) b: z.infer<typeof ProposeBody>, @CurrentUser() u: JwtUser) {
    return this.actions.propose({ kind: b.kind, payload: b.payload, rationale: b.rationale, source: b.source }, u);
  }

  @Get() @Permissions('ai_chat', 'approvals', 'dashboard')
  list(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.actions.list(status, u); }

  @Get(':id') @Permissions('ai_chat', 'approvals', 'dashboard')
  get(@Param('id') id: string) { return this.actions.get(+id); }

  @Post(':id/approve') @Permissions('approvals')
  approve(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.actions.approve(+id, u); }

  @Post(':id/reject') @Permissions('approvals')
  reject(@Param('id') id: string, @Body(new ZodValidationPipe(RejectBody)) b: z.infer<typeof RejectBody>, @CurrentUser() u: JwtUser) { return this.actions.reject(+id, b.reason, u); }
}

// Phase D2 — RAG knowledge base. Ingest policies/SOPs (perm masterdata), then search/ask with
// cite-or-refuse (perm ai_chat). The agent's `search_knowledge_base` tool uses the same service.
@Controller('api/ai/kb')
export class KnowledgeController {
  constructor(private readonly kb: KnowledgeService) {}

  @Post('documents') @Permissions('masterdata', 'ai_chat')
  ingest(@Body(new ZodValidationPipe(IngestBody)) b: z.infer<typeof IngestBody>, @CurrentUser() u: JwtUser) { return this.kb.ingest(b, u); }

  @Get('search') @Permissions('ai_chat', 'dashboard')
  search(@Query('q') q: string, @Query('k') k: string | undefined, @CurrentUser() u: JwtUser) { return this.kb.search(q ?? '', k ? +k : 5, u); }

  @Get('ask') @Permissions('ai_chat', 'dashboard')
  ask(@Query('q') q: string, @CurrentUser() u: JwtUser) { return this.kb.ask(q ?? '', u); }
}

@Module({
  imports: [PosModule, InventoryModule, FinanceModule, AnalyticsModule, BiModule, PipelineModule, CpqModule, ServiceModule, ProfitabilityModule, LedgerModule, ProcurementModule],
  controllers: [AiController, AiActionController, KnowledgeController],
  providers: [AgentService, AiActionService, EmbedderService, KnowledgeService],
  exports: [AgentService, KnowledgeService, EmbedderService],
})
export class AiModule {}
