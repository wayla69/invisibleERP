// Pure extraction helpers for DocAiService — model-output parsing + field normalization, kept out of the
// service so they are unit-testable without an app/db (apps/api/test/doc-ai-extract.test.ts).

export interface ExtractedLine {
  description: string | null;
  qty: number | null;
  unit_price: number | null;
  amount: number | null;
}

export interface ExtractedFields {
  vendor_name: string | null;
  vendor_tax_id: string | null;
  invoice_no: string | null;
  invoice_date: string | null;
  amount: number | null;
  currency: string;
  po_no: string | null;
  lines: ExtractedLine[];
}

const MAX_LINES = 100;
const MAX_DESC = 200;

/** Parse the model's JSON output tolerantly: strip ``` fences and any prose around the outermost object.
 *  Throws when no parseable object remains (caller falls back to rules / honest-empty). */
export function parseModelJson(out: string): Record<string, unknown> {
  let s = String(out ?? '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('NO_JSON_OBJECT');
  const parsed = JSON.parse(s.slice(first, last + 1));
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('NOT_AN_OBJECT');
  return parsed as Record<string, unknown>;
}

function str(v: unknown, max = 300): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function nonNegNum(v: unknown): number | null {
  const n = num(v);
  return n != null && n >= 0 ? n : null;
}

/** Normalize an extracted invoice date to Common-Era `YYYY-MM-DD`. Thai tax invoices routinely print
 *  Buddhist-era years (พ.ศ. = ค.ศ. + 543) — a year > 2400 is unambiguously BE and gets converted. */
export function normalizeInvoiceDate(v: unknown): string | null {
  const s = str(v, 40);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const year = Number(m[1]);
  return (year > 2400 ? year - 543 : year) + `-${m[2]}-${m[3]}`;
}

function normalizeCurrency(v: unknown): string {
  const s = str(v, 10)?.toUpperCase() ?? '';
  return /^[A-Z]{3}$/.test(s) ? s : 'THB';
}

function normalizeTaxId(v: unknown): string | null {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits.length === 13 ? digits : null;
}

function normalizeLines(v: unknown): ExtractedLine[] {
  if (!Array.isArray(v)) return [];
  const out: ExtractedLine[] = [];
  for (const raw of v.slice(0, MAX_LINES)) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const line: ExtractedLine = {
      description: str(r.description, MAX_DESC),
      qty: nonNegNum(r.qty),
      unit_price: nonNegNum(r.unit_price),
      amount: nonNegNum(r.amount),
    };
    if (line.description == null && line.qty == null && line.unit_price == null && line.amount == null) continue;
    out.push(line);
  }
  return out;
}

/** Coerce whatever the model (or rules) produced into the exact draft-field shape every consumer sees:
 *  finite numbers, CE dates, uppercase ISO-4217 currency (default THB), 13-digit tax id, bounded lines. */
export function normalizeExtractedFields(raw: Record<string, unknown>): ExtractedFields {
  return {
    vendor_name: str(raw.vendor_name, 200),
    vendor_tax_id: normalizeTaxId(raw.vendor_tax_id),
    invoice_no: str(raw.invoice_no, 60),
    invoice_date: normalizeInvoiceDate(raw.invoice_date),
    amount: num(raw.amount),
    currency: normalizeCurrency(raw.currency),
    po_no: str(raw.po_no, 60),
    lines: normalizeLines(raw.lines),
  };
}

/** Detect the invoice currency from document text (deterministic rules path). Explicit ISO codes win
 *  over symbols; default THB — this is a Thai-localized system and ฿ (U+0E3F) sits inside the Thai
 *  Unicode block, so a Thai-language invoice with no marker is THB. */
export function detectCurrency(text: string): string {
  const t = text ?? '';
  for (const code of ['USD', 'EUR', 'JPY', 'GBP', 'SGD', 'CNY', 'AUD', 'HKD', 'MYR', 'THB'] as const) {
    if (new RegExp(`(?<![A-Z])${code}(?![A-Z])`).test(t)) return code;
  }
  if (/\$/.test(t)) return 'USD';
  if (/€/.test(t)) return 'EUR';
  if (/£/.test(t)) return 'GBP';
  if (/¥/.test(t)) return 'JPY';
  return 'THB';
}
