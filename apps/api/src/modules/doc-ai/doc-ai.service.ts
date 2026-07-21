import { Injectable, Optional, Inject } from '@nestjs/common';
import { llmClient } from '../../common/llm-client';
import type { JwtUser } from '../../common/decorators';
import { modelFor, aiDpaBlocked } from '../../common/ai-models';
import { aiTenantOptedOut } from '../../common/ai-consent';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { pdfExtractText, usableTextLayer } from '../../common/pdf-text';
import { parseInvoiceDataUrl } from '../../common/invoice-doc';
import { parseModelJson, normalizeExtractedFields, detectCurrency, type ExtractedFields } from './doc-ai.extract';

const EXTRACT_SYSTEM =
  'You extract vendor-invoice fields. Return ONLY JSON: {vendor_name, vendor_tax_id (13-digit Thai tax id when present), ' +
  'invoice_no, invoice_date (YYYY-MM-DD in the Common Era — Thai invoices often print Buddhist-era พ.ศ. years, subtract 543), ' +
  'amount (number — the grand total including VAT), currency (ISO-4217 code; ฿/บาท means THB), ' +
  'po_no (the referenced purchase-order number, null if absent), ' +
  'lines (array of {description, qty, unit_price, amount} for each legible line item; [] when the lines are not legible)}. No prose.';

// Document-AI intake (Platform Phase 16 — B2). Extracts a structured AP-invoice draft from pasted text.
// With an Anthropic key it uses Claude; with NO key it falls back to deterministic regex heuristics (so CI
// passes). EXTRACT ONLY — it returns a draft for a human to review and post through the normal AP flow; it
// never creates an AP bill or touches the GL itself.
@Injectable()
export class DocAiService {
  constructor(@Optional() @Inject(DRIZZLE) private readonly db?: DrizzleDb) {} // per-tenant AI opt-out lookup
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
    // The deterministic path never invents line items (lines: []) — only vision reads them.
    return {
      vendor_name: firstLine || null, vendor_tax_id: taxId, invoice_no, invoice_date, amount,
      currency: detectCurrency(text), po_no, lines: [],
    } satisfies ExtractedFields;
  }

  private emptyFields(): ExtractedFields {
    return { vendor_name: null, vendor_tax_id: null, invoice_no: null, invoice_date: null, amount: null, currency: 'THB', po_no: null, lines: [] };
  }

  async extractInvoice(text: string, _user: JwtUser) {
    const t = (text ?? '').trim();
    if (!t) return { fields: this.emptyFields(), source: 'none' };
    if (!this.apiKey || (await aiTenantOptedOut(this.db, _user?.tenantId))) return { fields: this.ruleExtract(t), source: 'rules' };
    try {
      const client = llmClient(this.apiKey); // provider seam (docs/27 R4-4) — retries/backoff live inside
      const res: any = await client.create({
        model: this.model, max_tokens: 1024,
        system: EXTRACT_SYSTEM,
        messages: [{ role: 'user', content: `Extract from this invoice:\n${t}` }],
      });
      const out = (res.content as Array<{ type: string; text?: string }>).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      // Tolerant parse (fenced/prose-wrapped JSON) + normalization (finite numbers, BE→CE dates,
      // ISO currency, bounded lines) — malformed output still falls back to the deterministic rules.
      try { return { fields: normalizeExtractedFields(parseModelJson(out)), source: 'ai' }; } catch { return { fields: this.ruleExtract(t), source: 'rules-fallback' }; }
    } catch {
      return { fields: this.ruleExtract(t), source: 'rules-fallback' };
    }
  }

  // Binary document intake (AP-intake upload channel, EXP-10): a PDF with a USABLE text layer routes
  // through the normal text path (AI when keyed, else deterministic rules — CI relies on this); a
  // scanned PDF or an image goes to Claude vision when a key is set. `usableTextLayer` (not a bare
  // length check) gates the text path so CID/UTF-16 mojibake — common for Thai fonts — routes to
  // vision / review instead of mis-extracting junk. With NO key and no usable text layer the result is
  // honestly EMPTY (source 'none') so the intake queues for human review — never a guess.
  async extractInvoiceDocument(input: { media_type: string; data: string }, user: JwtUser) {
    const isPdf = input.media_type === 'application/pdf';
    let textLayer = '';
    if (isPdf) { try { textLayer = pdfExtractText(Buffer.from(input.data, 'base64')); } catch { textLayer = ''; } }
    if (usableTextLayer(textLayer)) {
      const r = await this.extractInvoice(textLayer, user);
      return { ...r, text: textLayer };
    }
    if (!this.apiKey || (await aiTenantOptedOut(this.db, user?.tenantId))) return { fields: this.emptyFields(), source: 'none', text: '' };
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
      try { return { fields: normalizeExtractedFields(parseModelJson(out)), source: 'ai', text: '' }; } catch { return { fields: this.emptyFields(), source: 'none', text: '' }; }
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

  // ── Bank-transfer SLIP extraction (wave-C claim pre-fill) ─────────────────────────────────────────
  // Same honesty contract as the invoice extractors: Claude vision when keyed (and the tenant hasn't
  // opted out), deterministic regex for pasted text, EMPTY fields otherwise — the result only PRE-FILLS
  // the /billing claim form; the human confirms and the platform owner still verifies against the real
  // bank statement, so a misread can never move money. (The slip QR's exact transfer ref is decoded
  // CLIENT-side — @ierp/shared slipTransferRef — before this is even called.)
  private slipRuleExtract(text: string): SlipFields {
    const amtM = text.match(/(?:จำนวนเงิน|จำนวน|amount)[^\d]{0,12}([\d,]+(?:\.\d{2})?)/i)
      ?? text.match(/([\d,]+\.\d{2})\s*(?:บาท|THB|฿)/i)
      ?? text.match(/(?:บาท|THB|฿)\s*([\d,]+(?:\.\d{2})?)/i);
    const amount = amtM ? Number(amtM[1]!.replace(/,/g, '')) : null;
    const ref = text.match(/(?:เลขที่รายการ|รหัสอ้างอิง|หมายเลขอ้างอิง|อ้างอิง|reference(?:\s*no\.?)?|ref(?:erence)?)[\s#:.\-]*([A-Za-z0-9]{8,40})/i)?.[1] ?? null;
    const dateM = text.match(/(\d{4}-\d{2}-\d{2})/)?.[1]
      ?? text.match(/(\d{1,2}\s*(?:ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.)\s*\d{2,4})/)?.[1]
      ?? text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/)?.[1] ?? null;
    return { amount: Number.isFinite(amount as number) && (amount as number) > 0 ? amount : null, transfer_ref: ref, date: dateM };
  }

  private emptySlip(): SlipFields { return { amount: null, transfer_ref: null, date: null }; }

  async extractSlip(input: { data_url?: string; text?: string }, user: JwtUser): Promise<{ fields: SlipFields; source: string }> {
    const text = (input.text ?? '').trim();
    if (text) {
      if (!this.apiKey || (await aiTenantOptedOut(this.db, user?.tenantId))) return { fields: this.slipRuleExtract(text), source: 'rules' };
      try {
        const client = llmClient(this.apiKey);
        const res: any = await client.create({
          model: this.model, max_tokens: 512, system: SLIP_SYSTEM,
          messages: [{ role: 'user', content: `Extract from this transfer slip:\n${text}` }],
        });
        const out = (res.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
        try { return { fields: normalizeSlipFields(parseModelJson(out)), source: 'ai' }; } catch { return { fields: this.slipRuleExtract(text), source: 'rules-fallback' }; }
      } catch { return { fields: this.slipRuleExtract(text), source: 'rules-fallback' }; }
    }
    if (!input.data_url) return { fields: this.emptySlip(), source: 'none' };
    const doc = parseInvoiceDataUrl(input.data_url); // shared mime allow-list + size caps
    if (!this.apiKey || (await aiTenantOptedOut(this.db, user?.tenantId))) return { fields: this.emptySlip(), source: 'none' };
    try {
      const client = llmClient(this.apiKey);
      const block = doc.mime === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: doc.base64 } }
        : { type: 'image', source: { type: 'base64', media_type: doc.mime, data: doc.base64 } };
      const res: any = await client.create({
        model: this.model, max_tokens: 512, system: SLIP_SYSTEM,
        messages: [{ role: 'user', content: [block, { type: 'text', text: 'Extract the transfer-slip fields from this image.' }] }],
      });
      const out = (res.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      try { return { fields: normalizeSlipFields(parseModelJson(out)), source: 'ai' }; } catch { return { fields: this.emptySlip(), source: 'none' }; }
    } catch { return { fields: this.emptySlip(), source: 'none' }; }
  }
}

export interface SlipFields { amount: number | null; transfer_ref: string | null; date: string | null }

const SLIP_SYSTEM =
  'You extract fields from a Thai bank money-transfer slip (สลิปโอนเงิน). Return ONLY JSON: ' +
  '{amount (number — THB transferred), transfer_ref (the transaction/reference code, e.g. เลขที่รายการ/รหัสอ้างอิง), ' +
  'date (YYYY-MM-DD in the Common Era — Thai slips print Buddhist-era พ.ศ. years, subtract 543)}. ' +
  'Use null for anything not legible. No prose.';

// Normalize a model slip response defensively (finite positive amount, bounded ref, BE→CE date passthrough
// left to the model per the system prompt — an unparseable value degrades to null, never garbage).
export function normalizeSlipFields(raw: unknown): SlipFields {
  const o = (raw ?? {}) as Record<string, unknown>;
  const amt = Number(o.amount);
  const ref = typeof o.transfer_ref === 'string' && /^[A-Za-z0-9\-]{4,60}$/.test(o.transfer_ref.trim()) ? o.transfer_ref.trim() : null;
  const date = typeof o.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : null;
  return { amount: Number.isFinite(amt) && amt > 0 ? Math.round(amt * 100) / 100 : null, transfer_ref: ref, date };
}
