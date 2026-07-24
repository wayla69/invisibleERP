import { Injectable, BadRequestException, Optional, Inject } from '@nestjs/common';
import { llmClient } from '../../common/llm-client';
import type { JwtUser } from '../../common/decorators';
import { modelFor, aiDpaBlocked } from '../../common/ai-models';
import { aiTenantOptedOut } from '../../common/ai-consent';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';

// AI configuration assistant (Platform Phase 18 — B4). Describe a Studio object in plain language → get a
// PROPOSED config JSON for a human to review and apply through the normal Studio screen (it never
// auto-applies). With an Anthropic key Claude drafts it; with NO key a deterministic starter template is
// returned (so CI passes). No GL, no writes — pure suggestion.
const TARGETS = ['custom_object', 'alert', 'automation', 'document_template'] as const;

const slug = (s: string) => {
  const r = (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_');
  let i = 0, j = r.length;
  while (i < j && r.charCodeAt(i) === 95) i++;
  while (j > i && r.charCodeAt(j - 1) === 95) j--;
  return r.slice(i, j).slice(0, 40) || 'item';
};

@Injectable()
export class AiConfigService {
  constructor(@Optional() @Inject(DRIZZLE) private readonly db?: DrizzleDb) {} // per-tenant AI opt-out lookup
  private get apiKey() { return aiDpaBlocked() ? '' : (process.env.ANTHROPIC_API_KEY || ''); } // gated → template
  private get model() { return modelFor('config_suggest'); } // JSON config → REASONING tier (was Opus)

  targets() { return { targets: [...TARGETS] }; }

  private template(target: string, description: string): any {
    const d = (description || '').trim();
    switch (target) {
      case 'custom_object': return { label: d.slice(0, 40) || 'My object', object_key: slug(d), fields: [{ label: 'Name', data_type: 'text', required: true }, { label: 'Notes', data_type: 'text' }] };
      case 'alert': return { name: d.slice(0, 40) || 'New alert', metric: /stock|สต๊อก|คงคลัง/.test(d.toLowerCase()) ? 'low_stock_count' : 'approvals_overdue', operator: 'gte', threshold: 1, channel: 'notification', severity: 'warning' };
      case 'automation': return { name: d.slice(0, 40) || 'New rule', event_type: 'alert.fired', condition: { field: 'severity', op: 'eq', value: 'critical' }, action: { type: 'notification', message: d.slice(0, 120) || 'Automated notification' } };
      case 'document_template': return { doc_type: 'receipt', name: d.slice(0, 40) || 'Custom receipt', config: { header: { header_note: d.slice(0, 80) }, footer: { thanks_text: 'ขอบคุณที่ใช้บริการ' } } };
      default: return {};
    }
  }

  async suggest(target: string, description: string, _user: JwtUser) {
    if (!(TARGETS as readonly string[]).includes(target)) throw new BadRequestException({ code: 'BAD_TARGET', message: `target must be one of ${TARGETS.join(', ')}`, messageTh: 'ประเภทคอนฟิกไม่ถูกต้อง' });
    if (!this.apiKey || (await aiTenantOptedOut(this.db, _user?.tenantId)))
      return { target, proposal: this.template(target, description), source: 'template', note: 'ตรวจทานก่อนนำไปใช้งานจริง' };
    try {
      const client = llmClient(this.apiKey); // provider seam (docs/27 R4-4) — retries/backoff live inside
      const res: any = await client.create({
        model: this.model, max_tokens: 700,
        system: `You propose a JSON configuration for a "${target}" in an ERP customization studio. Return ONLY JSON, no prose.`,
        messages: [{ role: 'user', content: description }],
      });
      const out = (res.content as Array<{ type: string; text?: string }>).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      try { return { target, proposal: JSON.parse(out), source: 'ai', note: 'ตรวจทานก่อนนำไปใช้งานจริง' }; } catch { return { target, proposal: this.template(target, description), source: 'template-fallback', note: 'ตรวจทานก่อนนำไปใช้งานจริง' }; }
    } catch {
      return { target, proposal: this.template(target, description), source: 'template-fallback', note: 'ตรวจทานก่อนนำไปใช้งานจริง' };
    }
  }
}
