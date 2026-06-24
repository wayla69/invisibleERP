import { Injectable } from '@nestjs/common';
import type { JwtUser } from '../../common/decorators';
import { KnowledgeService } from '../ai/knowledge.service';
import { AgentService } from '../ai/agent.service';

// Embedded copilot (Platform Phase 15 — B1). A context-aware Q&A surface for any screen: it grounds answers
// in the tenant's own knowledge base (RAG, cite-or-refuse) and, when an Anthropic key is configured,
// synthesizes a reply with the existing agent. With NO key it degrades gracefully to a KB-cited answer (never
// a 503), so it works deterministically in CI. Read-only, tenant-scoped (RAG is RLS-scoped), no GL.
@Injectable()
export class CopilotService {
  constructor(
    private readonly kb: KnowledgeService,
    private readonly agent: AgentService,
  ) {}

  private get apiKey() { return process.env.ANTHROPIC_API_KEY || ''; }

  async ask(question: string, context: string | undefined, user: JwtUser) {
    const q = (question ?? '').trim();
    if (!q) return { answer: '', grounded: false, citations: [], source: 'none' };
    const kb: any = await this.kb.ask(q, user);
    const citations = kb.citations ?? [];
    if (!this.apiKey) {
      if (kb.refused) return { answer: 'ยังไม่มีข้อมูลอ้างอิงในฐานความรู้ และระบบ AI ยังไม่ได้ตั้งค่า (ANTHROPIC_API_KEY)', grounded: false, citations, source: 'fallback' };
      return { answer: `อ้างอิงจากฐานความรู้: ${String(citations[0]?.content ?? '').slice(0, 400)}`, grounded: true, citations, source: 'kb' };
    }
    try {
      const ctx = [context ? `บริบทหน้าจอ: ${context}` : '', kb.context ? `ข้อมูลอ้างอิง:\n${kb.context}` : ''].filter(Boolean).join('\n\n');
      const res: any = await this.agent.chat(`${ctx}\n\nคำถาม: ${q}`, [], user);
      return { answer: res.reply ?? '', grounded: !kb.refused, citations, source: 'ai' };
    } catch {
      return { answer: citations[0] ? `อ้างอิงจากฐานความรู้: ${String(citations[0].content).slice(0, 400)}` : 'ไม่สามารถตอบได้ในขณะนี้', grounded: !kb.refused, citations, source: 'fallback' };
    }
  }
}
