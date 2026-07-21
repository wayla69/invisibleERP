import { afterEach, describe, expect, it } from 'vitest';

import { DocAiService, normalizeSlipFields } from '../src/modules/doc-ai/doc-ai.service';
import { setLlmClientForTests, type LlmClient } from '../src/common/llm-client';
import { parseTlv, slipTransferRef } from '@ierp/shared';

// Slip pre-fill (wave-C claim form): the shared mini-QR TLV parser (client-side exact ref) + the
// DocAiService slip extractor's honesty ladder (AI when keyed → deterministic rules for text →
// EMPTY, never a guess). Same construction pattern as doc-ai-service.test.ts.

const USER = { username: 'ba', role: 'Admin', tenantId: 1 } as any;

const tlv = (tag: string, value: string) => `${tag}${String(value.length).padStart(2, '0')}${value}`;

describe('slip mini-QR parsing (@ierp/shared slip-qr)', () => {
  it('parses well-formed TLV and rejects truncated/non-TLV strings', () => {
    expect(parseTlv(tlv('00', '01') + tlv('01', 'ABC'))).toEqual([
      { tag: '00', value: '01' },
      { tag: '01', value: 'ABC' },
    ]);
    expect(parseTlv('not a tlv payload')).toEqual([]);
    expect(parseTlv(tlv('00', '01') + '0130TRUNCATED')).toEqual([]);
  });

  it('picks the reference-shaped value from a slip-verify payload (top level)', () => {
    const payload = tlv('00', '000001') + tlv('01', '014000601034578KTB901') + tlv('51', 'TH');
    expect(slipTransferRef(payload)).toBe('014000601034578KTB901');
  });

  it('finds a NESTED reference (bank apps that wrap one TLV level down)', () => {
    const inner = tlv('00', '01') + tlv('01', '2026072199KBANK7734A');
    const payload = tlv('00', '000001') + tlv('30', inner);
    expect(slipTransferRef(payload)).toBe('2026072199KBANK7734A');
  });

  it('mixed alphanumeric outranks digits-only; bare reference-shaped payload passes through', () => {
    const payload = tlv('01', '0123456789012') + tlv('02', 'AB12CD34EF56');
    expect(slipTransferRef(payload)).toBe('AB12CD34EF56');
    expect(slipTransferRef('TXN2026KBANK001')).toBe('TXN2026KBANK001');
    expect(slipTransferRef('สวัสดี')).toBeNull();
    expect(slipTransferRef('')).toBeNull();
  });
});

describe('normalizeSlipFields', () => {
  it('keeps sane values, nulls garbage', () => {
    expect(normalizeSlipFields({ amount: 4900.005, transfer_ref: ' TXN-1234-ABC ', date: '2026-07-21' }))
      .toEqual({ amount: 4900.01, transfer_ref: 'TXN-1234-ABC', date: '2026-07-21' });
    expect(normalizeSlipFields({ amount: -5, transfer_ref: 'has space bad', date: '21/07/2026' }))
      .toEqual({ amount: null, transfer_ref: null, date: null });
    expect(normalizeSlipFields(null)).toEqual({ amount: null, transfer_ref: null, date: null });
  });
});

describe('DocAiService.extractSlip', () => {
  afterEach(() => { setLlmClientForTests(null); delete process.env.ANTHROPIC_API_KEY; });

  it('no key + pasted text → deterministic rules (Thai slip vocabulary)', async () => {
    const svc = new DocAiService();
    const r = await svc.extractSlip({ text: 'โอนเงินสำเร็จ\nจำนวนเงิน 4,900.00 บาท\nเลขที่รายการ: 014000601034578\n2026-07-21 14:02' }, USER);
    expect(r.source).toBe('rules');
    expect(r.fields.amount).toBe(4900);
    expect(r.fields.transfer_ref).toBe('014000601034578');
    expect(r.fields.date).toBe('2026-07-21');
  });

  it('no key + image → honestly EMPTY (source none), never a guess', async () => {
    const svc = new DocAiService();
    const onePx = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const r = await svc.extractSlip({ data_url: onePx }, USER);
    expect(r.source).toBe('none');
    expect(r.fields).toEqual({ amount: null, transfer_ref: null, date: null });
  });

  it('keyed + scripted model → normalized AI fields; malformed model output falls back to rules', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const good: LlmClient = { async create() { return { content: [{ type: 'text', text: '{"amount": 1234.5, "transfer_ref": "KB2026X99", "date": "2026-07-20"}' }] } as any; }, stream() { throw new Error('x'); } };
    setLlmClientForTests(good);
    const svc = new DocAiService();
    const r = await svc.extractSlip({ text: 'slip text' }, USER);
    expect(r.source).toBe('ai');
    expect(r.fields).toEqual({ amount: 1234.5, transfer_ref: 'KB2026X99', date: '2026-07-20' });

    const bad: LlmClient = { async create() { return { content: [{ type: 'text', text: 'not json at all' }] } as any; }, stream() { throw new Error('x'); } };
    setLlmClientForTests(bad);
    const r2 = await svc.extractSlip({ text: 'จำนวนเงิน 900.00 บาท อ้างอิง REF99887766' }, USER);
    expect(r2.source).toBe('rules-fallback');
    expect(r2.fields.amount).toBe(900);
    expect(r2.fields.transfer_ref).toBe('REF99887766');
  });
});
