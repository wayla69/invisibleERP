import { describe, expect, it } from 'vitest';

import { usableTextLayer } from '../src/common/pdf-text';
import { parseModelJson, normalizeExtractedFields, normalizeInvoiceDate, detectCurrency } from '../src/modules/doc-ai/doc-ai.extract';

// Pure helpers behind the doc-ai extraction pipeline (EXP-10 upload channel). The routing heuristic is
// the control-relevant piece: a Thai CID-font PDF inflating to >20 chars of mojibake used to slip down
// the deterministic text path and mis-extract junk instead of routing to vision / human review.

describe('usableTextLayer (PDF text-layer routing gate)', () => {
  it('accepts a clean English invoice text layer', () => {
    expect(usableTextLayer('ACME Supplies Co., Ltd.\nInvoice INV-2026-001\nGrand Total 1,500.00')).toBe(true);
  });

  it('accepts a clean Thai invoice text layer', () => {
    expect(usableTextLayer('บริษัท ตัวอย่าง จำกัด\nใบกำกับภาษี เลขที่ INV-001\nรวมทั้งสิ้น 1,605.00 บาท')).toBe(true);
  });

  it('rejects CID/UTF-16 mojibake even when it is long', () => {
    // Simulated CID-font garbage: mostly punctuation/symbols with no contiguous word runs.
    const mojibake = ' (!) <#> "$%" &\'()* +,-. /:;<=>? @[\\]^_` {|}~  (!) <#> "$%" &\'()*';
    expect(mojibake.trim().length).toBeGreaterThanOrEqual(20); // would have passed the old length>=20 gate
    expect(usableTextLayer(mojibake)).toBe(false);
  });

  it('rejects replacement-character dominated output', () => {
    expect(usableTextLayer('��� ab ��� cd ��� ef ��� gh ��')).toBe(false);
  });

  it('rejects short or empty layers', () => {
    expect(usableTextLayer('')).toBe(false);
    expect(usableTextLayer('   ')).toBe(false);
    expect(usableTextLayer('INV-001 total 99')).toBe(false); // < 20 chars
  });
});

describe('parseModelJson (tolerant model-output parsing)', () => {
  it('parses a plain JSON object', () => {
    expect(parseModelJson('{"invoice_no":"INV-1"}')).toEqual({ invoice_no: 'INV-1' });
  });

  it('strips ``` fences', () => {
    expect(parseModelJson('```json\n{"invoice_no":"INV-1"}\n```')).toEqual({ invoice_no: 'INV-1' });
  });

  it('slices the object out of surrounding prose', () => {
    expect(parseModelJson('Here are the fields:\n{"amount": 12.5}\nHope that helps!')).toEqual({ amount: 12.5 });
  });

  it('throws on non-JSON output (caller falls back to rules / honest-empty)', () => {
    expect(() => parseModelJson('I could not read this document.')).toThrow();
    expect(() => parseModelJson('[1,2,3]')).toThrow();
    expect(() => parseModelJson('')).toThrow();
  });
});

describe('normalizeExtractedFields', () => {
  it('converts a Buddhist-era invoice date to Common Era', () => {
    expect(normalizeInvoiceDate('2569-07-18')).toBe('2026-07-18');
    expect(normalizeInvoiceDate('2026-07-18')).toBe('2026-07-18');
    expect(normalizeInvoiceDate(null)).toBeNull();
  });

  it('uppercases valid ISO currency and defaults junk to THB', () => {
    const base = { vendor_name: 'x', currency: 'usd' };
    expect(normalizeExtractedFields(base).currency).toBe('USD');
    expect(normalizeExtractedFields({ currency: 'dollars' }).currency).toBe('THB');
    expect(normalizeExtractedFields({}).currency).toBe('THB');
  });

  it('coerces amounts (comma strings) and keeps only a 13-digit tax id', () => {
    const f = normalizeExtractedFields({ amount: '1,605.00', vendor_tax_id: '0-1055-43001-23-1' });
    expect(f.amount).toBe(1605);
    expect(f.vendor_tax_id).toBe('0105543001231');
    expect(normalizeExtractedFields({ vendor_tax_id: '12345' }).vendor_tax_id).toBeNull();
    expect(normalizeExtractedFields({ amount: 'abc' }).amount).toBeNull();
  });

  it('sanitizes lines: drops junk entries, bounds count and description length, rejects negatives', () => {
    const f = normalizeExtractedFields({
      lines: [
        { description: 'Rice 5kg', qty: 2, unit_price: '60.00', amount: 120 },
        { description: null, qty: null, unit_price: null, amount: null }, // fully empty → dropped
        'not-an-object',
        { description: 'x'.repeat(500), qty: -3, amount: 10 },
      ],
    });
    expect(f.lines).toHaveLength(2);
    expect(f.lines[0]).toEqual({ description: 'Rice 5kg', qty: 2, unit_price: 60, amount: 120 });
    expect(f.lines[1]!.description).toHaveLength(200);
    expect(f.lines[1]!.qty).toBeNull(); // negative rejected
    expect(normalizeExtractedFields({ lines: Array.from({ length: 250 }, (_, i) => ({ qty: i + 1 })) }).lines).toHaveLength(100);
    expect(normalizeExtractedFields({ lines: 'none' }).lines).toEqual([]);
  });
});

describe('detectCurrency (deterministic rules path)', () => {
  it('prefers explicit ISO codes, then symbols, defaulting to THB', () => {
    expect(detectCurrency('Total USD 1,500.00')).toBe('USD');
    expect(detectCurrency('Montant: € 90,00 EUR')).toBe('EUR');
    expect(detectCurrency('Amount due: $250.00')).toBe('USD');
    expect(detectCurrency('รวมทั้งสิ้น ฿1,605.00')).toBe('THB');
    expect(detectCurrency('รวมทั้งสิ้น 1,605.00 บาท')).toBe('THB');
    expect(detectCurrency('no currency markers at all')).toBe('THB');
  });
});
