import { Injectable } from '@nestjs/common';
import { llmClient } from '../../common/llm-client';
import type { JwtUser } from '../../common/decorators';
import { QueryService } from '../query/query.service';
import { modelFor, aiDpaBlocked } from '../../common/ai-models';

// Natural-language analytics (Platform Phase 17 — B3). Turns a plain question into a governed query over the
// A5 semantic layer and runs it. With an Anthropic key Claude maps NL → {dimension, date filters}; with NO
// key a deterministic keyword mapping is used (so CI passes). The query itself is the SAME RLS-scoped,
// whitelist-only engine as A5 — NL never produces raw SQL. Read-only, no GL.
@Injectable()
export class NlAnalyticsService {
  constructor(private readonly query: QueryService) {}
  private get apiKey() { return aiDpaBlocked() ? '' : (process.env.ANTHROPIC_API_KEY || ''); } // gated → keyword map
  private get model() { return modelFor('nl_query'); } // short NL→query parse → CHEAP tier (was Opus)

  private keywordMap(question: string): { dimension: string } {
    const q = question.toLowerCase();
    if (/branch|สาขา/.test(q)) return { dimension: 'branch' };
    if (/payment|tender|ชำระ|จ่าย/.test(q)) return { dimension: 'payment_method' };
    if (/daily|\bday\b|รายวัน|ต่อวัน/.test(q)) return { dimension: 'period_day' };
    return { dimension: 'period_month' };
  }

  async ask(question: string, user: JwtUser) {
    const q = (question ?? '').trim();
    if (!q) return { question: q, resolved: null, source: 'none', result: null };
    let spec: any = this.keywordMap(q);
    let source = 'keyword';
    if (this.apiKey) {
      try {
        const dims = this.query.dimensionKeys();
        const client = llmClient(this.apiKey); // provider seam (docs/24 R4-4) — retries/backoff live inside
        const res: any = await client.create({
          model: this.model, max_tokens: 300,
          system: `Map the user's question to a JSON query over POS sales. "dimension" must be exactly one of: ${dims.join(', ')}. Return ONLY JSON: {"dimension": "...", "date_from"?: "YYYY-MM-DD", "date_to"?: "YYYY-MM-DD"}.`,
          messages: [{ role: 'user', content: q }],
        });
        const out = (res.content as any[]).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
        const parsed = JSON.parse(out);
        if (parsed?.dimension && dims.includes(parsed.dimension)) { spec = parsed; source = 'ai'; }
      } catch { /* keep keyword mapping */ }
    }
    const result = await this.query.run(spec, user);
    return { question: q, resolved: spec, source, result };
  }
}
