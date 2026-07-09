import { describe, expect, it } from 'vitest';
import { UnprocessableEntityException } from '@nestjs/common';

import { ProcurementPoService } from '../src/modules/procurement/procurement-po.service';

// Unit tests for the PO lifecycle guards (workstream 2.4 — the docs/38 procurement PR-3 sub-service is a
// plain class with callback ports, so the Phase-16 screening contract is provable without PGlite).

const docNo = { nextDaily: async () => 'PO-TEST-001' } as any;
const statusLog = { log: async () => undefined } as any;
const user = { username: 'buyer1' } as any;
const noDb = { select: () => { throw new Error('unexpected db read'); } } as any;
const allow = async () => undefined;
const noProject = async () => null;
const noNotify = async () => undefined;

async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); } catch (e: any) { return e?.response?.code ?? e?.code ?? String(e); }
  return 'NO_THROW';
}

describe('ProcurementPoService — createPo guards (Phase 16 supplier screening port)', () => {
  it('rejects an empty PO before touching the db (BAD_REQUEST)', async () => {
    const svc = new ProcurementPoService(noDb, docNo, statusLog, allow, noProject, noNotify);
    expect(await code(() => svc.createPo({ items: [] } as any, user))).toBe('BAD_REQUEST');
  });

  it('calls assertSupplierAllowed with the resolved vendor BEFORE any insert, and its 422 propagates', async () => {
    const seen: any[] = [];
    const screen = async (vendorId: number | null, vendorName: string | null) => {
      seen.push([vendorId, vendorName]);
      throw new UnprocessableEntityException({ code: 'SUPPLIER_BLOCKED', message: 'blocked' });
    };
    // vendor_id + vendor_name both provided → no vendor lookup needed → noDb proves no read happens either
    const svc = new ProcurementPoService(noDb, docNo, statusLog, screen, noProject, noNotify);
    expect(await code(() => svc.createPo({
      vendor_id: 9, vendor_name: 'Blocked Co', items: [{ item_id: 'A', order_qty: 1, unit_price: 10 }],
    } as any, user))).toBe('SUPPLIER_BLOCKED');
    expect(seen).toEqual([[9, 'Blocked Co']]);
  });
});

describe('ProcurementPoService — approvePo / cancelPo lookups', () => {
  const emptySelect = () => {
    const p: any = { from: () => p, where: () => p, limit: () => p, then: (r: any, j: any) => Promise.resolve([]).then(r, j) };
    return p;
  };

  it('approving an unknown PO is NOT_FOUND', async () => {
    const svc = new ProcurementPoService({ select: emptySelect } as any, docNo, statusLog, allow, noProject, noNotify);
    expect(await code(() => svc.approvePo('PO-404', true, undefined, user))).toBe('NOT_FOUND');
  });

  it('cancelling an unknown PO is NOT_FOUND', async () => {
    const svc = new ProcurementPoService({ select: emptySelect } as any, docNo, statusLog, allow, noProject, noNotify);
    expect(await code(() => svc.cancelPo('PO-404', 'dup', user))).toBe('NOT_FOUND');
  });
});
