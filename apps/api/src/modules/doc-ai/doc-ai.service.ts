import { Injectable } from '@nestjs/common';
import { llmClient } from '../../common/llm-client';
import type { JwtUser } from '../../common/decorators';
import { modelFor, aiDpaBlocked } from '../../common/ai-models';

// Document-AI intake (Platform Phase 16 — B2). Extracts a structured AP-invoice draft from pasted text.
// With an Anthropic key it uses Claude; with NO key it falls back to deterministic regex heuristics (so CI
// passes). EXTRACT ONLY — it returns a draft for a human to review and post through the normal AP flow; it
// never creates an AP bill or touches the GL itself.
@Injectable()
export class DocAiService {
  private get apiKey() { return aiDpaBlocked() ? '' : (process.env.ANTHROPIC_API_KEY || ''); } // gated → deterministic
  private get model() { return modelFor('doc_extract'); } // structured extraction → CHEAP tier (was Opus)

  private ruleExtract(text: string) {
    const invoice_no = text.match(/(?:invoice|inv|ใบกำกับ(?:ภาษี)?|เลขที่)[\s#:.\-]*([A-Za-z0-9][A-Za-z0-9/\-]{2,})/i)?.[1] ?? null;
    const invoice_date = text.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? text.match(/(\d{1,2}\/\d{1,2}\/\d{4})/)?.[1] ?? null;
    let amount: number | null = null;
    // Prefer an explicit total. The negative lookbehind keeps "Subtotal" from matching the bare "total".
    const totalM = text.match(/(?:(?<![a-z])(?:grand\s+)?total|amount\s+due|รวมทั้งสิ้น|รวมสุทธิ|ยอดรวมสุทธิ)[^\d]{0,16}([\d,]+(?:\.\d{2})?)/i);
    if (totalM) amount = Number(totalM[1].replace(/,/g, ''));
    if (amount == null) {
      const nums = [...text.matchAll(/([\d,]+\.\d{2})/g)].map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => Number.isFinite(n));
      if (nums.length) amount = Math.max(...nums);
    }
    const taxId = text.match(/(\d{13})/)?.[1] ?? null;
    const firstLine = (text.split(/\n/).map((s) => s.trim()).filter(Boolean)[0] ?? '').slice(0, 80);
    return { vendor_name: firstLine || null, vendor_tax_id: taxId, invoice_no, invoice_date, amount, currency: 'THB' };
  }

  async extractInvoice(text: string, _user: JwtUser) {
    const t = (text ?? '').trim();
    if (!t) return { fields: { vendor_name: null, vendor_tax_id: null, invoice_no: null, invoice_date: null, amount: null, currency: 'THB' }, source: 'none' };
    if (!this.apiKey) return { fields: this.ruleExtract(t), source: 'rules' };
    try {
      const client = llmClient(this.apiKey); // provider seam (docs/27 R4-4) — retries/backoff live inside
      const res: any = await client.create({
        model: this.model, max_tokens: 1024,
        system: 'You extract vendor-invoice fields. Return ONLY JSON: {vendor_name, vendor_tax_id, invoice_no, invoice_date (YYYY-MM-DD), amount (number), currency}. No prose.',
        messages: [{ role: 'user', content: `Extract from this invoice:\n${t}` }],
      });
      const out = (res.content as any[]).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      try { return { fields: JSON.parse(out), source: 'ai' }; } catch { return { fields: this.ruleExtract(t), source: 'rules-fallback' }; }
    } catch {
      return { fields: this.ruleExtract(t), source: 'rules-fallback' };
    }
  }
}
