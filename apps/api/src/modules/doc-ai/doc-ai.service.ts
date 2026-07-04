import { Injectable } from '@nestjs/common';
import { llmClient } from '../../common/llm-client';
import type { JwtUser } from '../../common/decorators';
import { modelFor, aiDpaBlocked } from '../../common/ai-models';
import { pdfExtractText } from '../../common/pdf-text';
import { parseInvoiceDataUrl } from '../../common/invoice-doc';

const EXTRACT_SYSTEM = 'You extract vendor-invoice fields. Return ONLY JSON: {vendor_name, vendor_tax_id, invoice_no, invoice_date (YYYY-MM-DD), amount (number), currency, po_no (the referenced purchase-order number, null if absent)}. No prose.';

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
    if (totalM) amount = Number(totalM[1]!.replace(/,/g, ''));
    if (amount == null) {
      const nums = [...text.matchAll(/([\d,]+\.\d{2})/g)].map((m) => Number(m[1]!.replace(/,/g, ''))).filter((n) => Number.isFinite(n));
      if (nums.length) amount = Math.max(...nums);
    }
    const taxId = text.match(/(\d{13})/)?.[1] ?? null;
    // PO reference (feeds the AP-intake auto-mapper): prefer the canonical PO-YYYYMMDD-NNN shape anywhere
    // in the document, else a labelled reference ("PO no", "Purchase Order", "ใบสั่งซื้อเลขที่", …).
    const po_no = text.match(/\b(PO-\d{8}-\d{1,4})\b/i)?.[1]?.toUpperCase()
      ?? text.match(/(?:P\.?O\.?|purchase\s*order|ใบสั่งซื้อ)[\s#:.]*(?:no\.?|number|เลขที่)?[\s#:.]*([A-Za-z]{2,4}-[A-Za-z0-9/\-]{3,})/i)?.[1]?.toUpperCase()
      ?? null;
    const firstLine = (text.split(/\n/).map((s) => s.trim()).filter(Boolean)[0] ?? '').slice(0, 80);
    return { vendor_name: firstLine || null, vendor_tax_id: taxId, invoice_no, invoice_date, amount, currency: 'THB', po_no };
  }

  private emptyFields() {
    return { vendor_name: null, vendor_tax_id: null, invoice_no: null, invoice_date: null, amount: null, currency: 'THB', po_no: null };
  }

  async extractInvoice(text: string, _user: JwtUser) {
    const t = (text ?? '').trim();
    if (!t) return { fields: this.emptyFields(), source: 'none' };
    if (!this.apiKey) return { fields: this.ruleExtract(t), source: 'rules' };
    try {
      const client = llmClient(this.apiKey); // provider seam (docs/27 R4-4) — retries/backoff live inside
      const res: any = await client.create({
        model: this.model, max_tokens: 1024,
        system: EXTRACT_SYSTEM,
        messages: [{ role: 'user', content: `Extract from this invoice:\n${t}` }],
      });
      const out = (res.content as any[]).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      try { return { fields: JSON.parse(out), source: 'ai' }; } catch { return { fields: this.ruleExtract(t), source: 'rules-fallback' }; }
    } catch {
      return { fields: this.ruleExtract(t), source: 'rules-fallback' };
    }
  }

  // Binary document intake (AP-intake upload channel, EXP-10): a PDF with a usable TEXT LAYER routes
  // through the normal text path (AI when keyed, else deterministic rules — CI relies on this); a
  // scanned PDF or an image goes to Claude vision when a key is set. With NO key and no text layer the
  // result is honestly EMPTY (source 'none') so the intake queues for human review — never a guess.
  async extractInvoiceDocument(input: { media_type: string; data: string }, user: JwtUser) {
    const isPdf = input.media_type === 'application/pdf';
    let textLayer = '';
    if (isPdf) { try { textLayer = pdfExtractText(Buffer.from(input.data, 'base64')); } catch { textLayer = ''; } }
    if (textLayer.trim().length >= 20) {
      const r = await this.extractInvoice(textLayer, user);
      return { ...r, text: textLayer };
    }
    if (!this.apiKey) return { fields: this.emptyFields(), source: 'none', text: '' };
    try {
      const client = llmClient(this.apiKey);
      const block = isPdf
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.data } }
        : { type: 'image', source: { type: 'base64', media_type: input.media_type, data: input.data } };
      const res: any = await client.create({
        model: this.model, max_tokens: 1024,
        system: EXTRACT_SYSTEM,
        messages: [{ role: 'user', content: [block, { type: 'text', text: 'Extract the invoice fields from this document.' }] }],
      });
      const out = (res.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      try { return { fields: JSON.parse(out), source: 'ai', text: '' }; } catch { return { fields: this.emptyFields(), source: 'none', text: '' }; }
    } catch {
      return { fields: this.emptyFields(), source: 'none', text: '' };
    }
  }

  // Public extract-only entry for an uploaded image/PDF (base64 `data:` URL). Parses + validates the data
  // URL (shared allow-list) then runs the same text/vision extractor the AP-intake upload channel uses.
  // Returns a draft for a human to review — never persists, never touches the GL. Reused by the Quick
  // Capture preview and the LINE capture channel (docs/34).
  async extractFromDataUrl(dataUrl: string, user: JwtUser) {
    const doc = parseInvoiceDataUrl(dataUrl);
    const r = await this.extractInvoiceDocument({ media_type: doc.mime, data: doc.base64 }, user);
    return { fields: r.fields, source: r.source };
  }
}
