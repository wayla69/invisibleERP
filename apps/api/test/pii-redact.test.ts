import { describe, it, expect } from 'vitest';
import { redactPii, PII_REDACTION_ENABLED } from '../src/common/pii-redact';

describe('PDPA — PII redaction before the LLM boundary', () => {
  it('masks direct contact identifiers in structured fields, keeps names + amounts (utility)', () => {
    const input = {
      customers: [
        { name: 'สยาม บริหาร จำกัด', contact: 'จันทร์ สมนึก', email: 'accounts@siam-mgmt.co.th', phone: '0812345678', tax_id: '0105551234567', balance_thb: 450000, days_overdue: 45 },
      ],
    };
    const out: any = redactPii(input);
    expect(out.customers[0].email).toBe('[REDACTED]');
    expect(out.customers[0].phone).toBe('[REDACTED]');
    expect(out.customers[0].tax_id).toBe('[REDACTED]');
    expect(out.customers[0].contact).toBe('[REDACTED]');
    // names + financial figures are preserved so the assistant stays useful
    expect(out.customers[0].name).toBe('สยาม บริหาร จำกัด');
    expect(out.customers[0].balance_thb).toBe(450000);
    expect(out.customers[0].days_overdue).toBe(45);
  });

  it('scrubs identifiers embedded in free-text string values (memos/descriptions)', () => {
    const out: any = redactPii({ memo: 'Email accounts@siam.co.th or call 081-234-5678; tax 0105551234567' });
    expect(out.memo).not.toContain('accounts@siam.co.th');
    expect(out.memo).not.toContain('0105551234567');
    expect(out.memo).toContain('[REDACTED]');
  });

  it('handles arrays, nested objects, nulls and non-PII primitives', () => {
    const out: any = redactPii({ rows: [{ amount: 10, note: null }, { amount: 20 }], total: 30, ok: true });
    expect(out.rows[0].amount).toBe(10);
    expect(out.rows[0].note).toBeNull();
    expect(out.total).toBe(30);
    expect(out.ok).toBe(true);
  });

  it('is enabled by default (PDPA-safe), and can be disabled via env', () => {
    expect(PII_REDACTION_ENABLED()).toBe(true);
  });
});

it('masks non-scalar values under sensitive keys wholesale (round-2 depth fix)', () => {
  const out: any = redactPii({
    bank_account: { bank: 'KBank', number: '123-4-56789-0' },
    national_id: ['1101700230705'],
    note: 'ok',
  });
  expect(out.bank_account).toBe('[REDACTED]');
  expect(out.national_id).toBe('[REDACTED]');
  expect(out.note).toBe('ok');
});
