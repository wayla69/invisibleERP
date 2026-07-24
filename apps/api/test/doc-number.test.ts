import { describe, expect, it } from 'vitest';

import { DocNumberService } from '../src/common/doc-number.service';
import { bizHourMin, bizStamp, bizYmdCompact } from '../src/common/bizdate';

// Unit tests for the atomic document-number service (2.4 slice 8 — R1-3 numbering). The db fake answers
// the upsert-returning chain with scripted sequence values, so the FORMAT contract (prefix, business-TZ
// day, zero padding) and the per-type tenant-code slicing are pinned; the actual race-safety rides the
// ux doc_counters upsert and stays harness-tested.

function seqDb(seqs: number[]): any {
  let i = 0;
  return {
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({ returning: () => Promise.resolve([{ n: seqs[i++] ?? 1 }]) }),
      }),
    }),
  };
}

const D = new Date('2026-07-09T10:30:05+07:00'); // deterministic instant (business TZ = Asia/Bangkok)

describe('DocNumberService — daily/monthly counters (atomic upsert-returning)', () => {
  it('nextDaily formats {PFX}-YYYYMMDD-NNN on the BUSINESS day with 3-digit padding', async () => {
    const svc = new DocNumberService(seqDb([1, 12, 345]));
    expect(await svc.nextDaily('PO')).toBe(`PO-${bizYmdCompact()}-001`);
    expect(await svc.nextDaily('GR')).toBe(`GR-${bizYmdCompact()}-012`);
    expect(await svc.nextDaily('JE')).toBe(`JE-${bizYmdCompact()}-345`);
  });

  it('nextMonthlyTenant formats {PFX}-YYYYMM-NNNN (legally sequential per seller, 4-digit padding)', async () => {
    const svc = new DocNumberService(seqDb([42]));
    expect(await svc.nextMonthlyTenant('TIV', 1)).toBe(`TIV-${bizYmdCompact().slice(0, 6)}-0042`);
  });
});

describe('DocNumberService — stamped formats (pure)', () => {
  const svc = new DocNumberService(seqDb([]));

  it('nextSalesOrder keeps the legacy SO-YYYYMMDD-HHMM shape', () => {
    expect(svc.nextSalesOrder(D)).toBe(`SO-${bizYmdCompact(D)}-${bizHourMin(D)}`);
  });

  it('nextTenantStamped slices the tenant code per type (MPO 3 / PND 6 / else 4), strips spaces, uppercases', () => {
    expect(svc.nextTenantStamped('MPO', 'my co ltd', D)).toBe(`MPO-MYC-${bizStamp(D)}`);
    expect(svc.nextTenantStamped('PND', 'invisible', D)).toBe(`PND-INVISI-${bizStamp(D)}`);
    expect(svc.nextTenantStamped('SALE', 'invisible', D)).toBe(`SALE-INVI-${bizStamp(D)}`);
    expect(svc.nextTenantStamped('PRD', '', D)).toBe(`PRD--${bizStamp(D)}`); // empty code degrades, no crash
  });

  it('nextStamped + invoiceFromOrder', () => {
    expect(svc.nextStamped('TRF', D)).toBe(`TRF-${bizStamp(D)}`);
    expect(svc.invoiceFromOrder('SO-20260709-1030')).toBe('INV-SO-20260709-1030');
  });
});
