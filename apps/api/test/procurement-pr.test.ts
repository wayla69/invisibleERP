import { describe, expect, it } from 'vitest';

import { ProcurementPrService } from '../src/modules/procurement/procurement-pr.service';

// Unit tests for the requisition/conversion guards (workstream 2.4 slice 2 — docs/38 procurement PR-4).
// convertPrToPo's line-validation layer runs BEFORE any item/PO write; the PR head lookup is the only
// read these paths need.

const docNo = { nextDaily: async () => 'PR-TEST-001' } as any;
const statusLog = { log: async () => undefined } as any;
const user = { username: 'buyer1' } as any;
const ports = {
  resolveProjectId: async () => null,
  lowStock: async () => ({ items: [] }),
  setPreferredVendor: async () => undefined,
  createPo: async () => ({ po_no: 'PO-1', status: 'Pending', total_amount: 0 }),
};

function dbWithPrHead(head: any): any {
  const chain = (rows: any[]) => {
    const p: any = { from: () => p, where: () => p, limit: () => p, then: (r: any, j: any) => Promise.resolve(rows).then(r, j) };
    return p;
  };
  return {
    select: () => chain(head ? [head] : []),
    insert: () => { throw new Error('unexpected write in a guard-path unit test'); },
    update: () => { throw new Error('unexpected write in a guard-path unit test'); },
    transaction: () => { throw new Error('unexpected transaction in a guard-path unit test'); },
  };
}

function svcWith(head: any) {
  return new ProcurementPrService(dbWithPrHead(head), docNo, statusLog,
    ports.resolveProjectId, ports.lowStock, ports.setPreferredVendor, ports.createPo);
}

async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); } catch (e: any) { return e?.response?.code ?? e?.code ?? String(e); }
  return 'NO_THROW';
}

describe('ProcurementPrService — convertPrToPo guards', () => {
  const approved = { id: 1, prNo: 'PR-1', status: 'Approved', requestedBy: 'req1' };

  it('an unknown PR is NOT_FOUND', async () => {
    expect(await code(() => svcWith(null).convertPrToPo('pr-404', { lines: [] } as any, user))).toBe('NOT_FOUND');
  });

  it('a Pending PR cannot convert (PR_NOT_APPROVED)', async () => {
    expect(await code(() => svcWith({ ...approved, status: 'Pending' })
      .convertPrToPo('pr-1', { lines: [{ item_id: 'A', order_qty: 1, unit_price: 1 }] } as any, user))).toBe('PR_NOT_APPROVED');
  });

  it('a convert with no lines at all is BAD_REQUEST', async () => {
    expect(await code(() => svcWith(approved).convertPrToPo('pr-1', { lines: [] } as any, user))).toBe('BAD_REQUEST');
  });

  it('a split group with an empty line list is EMPTY_PO', async () => {
    expect(await code(() => svcWith(approved).convertPrToPo('pr-1', { pos: [
      { vendor_id: 1, lines: [{ item_id: 'A', order_qty: 1, unit_price: 1 }] },
      { vendor_id: 2, lines: [] },
    ] } as any, user))).toBe('EMPTY_PO');
  });

  it('a line without a resolved item id is ITEM_REQUIRED', async () => {
    expect(await code(() => svcWith(approved).convertPrToPo('pr-1', { lines: [
      { item_id: '  ', order_qty: 1, unit_price: 1 },
    ] } as any, user))).toBe('ITEM_REQUIRED');
  });

  it('a non-positive quantity is BAD_QTY', async () => {
    expect(await code(() => svcWith(approved).convertPrToPo('pr-1', { lines: [
      { item_id: 'A', order_qty: 0, unit_price: 1 },
    ] } as any, user))).toBe('BAD_QTY');
  });
});

describe('ProcurementPrService — cancelPr ownership + state guards (0228)', () => {
  it('someone else\'s Pending PR cannot be cancelled by a non-Admin (PR_NOT_YOURS)', async () => {
    const svc = svcWith({ id: 1, prNo: 'PR-1', status: 'Pending', requestedBy: 'someone-else' });
    expect(await code(() => svc.cancelPr('PR-1', { username: 'buyer1', role: 'Purchasing' } as any))).toBe('PR_NOT_YOURS');
  });

  it('a decided PR cannot be cancelled (PR_NOT_PENDING)', async () => {
    const svc = svcWith({ id: 1, prNo: 'PR-1', status: 'Approved', requestedBy: 'buyer1' });
    expect(await code(() => svc.cancelPr('PR-1', { username: 'buyer1', role: 'Purchasing' } as any))).toBe('PR_NOT_PENDING');
  });
});

describe('ProcurementPrService — reorderPr', () => {
  it('nothing at/below reorder point → 422 NOTHING_LOW (rides the lowStock port)', async () => {
    const svc = svcWith(null);
    expect(await code(() => svc.reorderPr(user))).toBe('NOTHING_LOW');
  });
});
