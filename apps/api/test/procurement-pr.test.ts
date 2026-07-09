import { describe, expect, it } from 'vitest';

import { ProcurementPrService } from '../src/modules/procurement/procurement-pr.service';

// Unit tests for the requisition/conversion guards (workstream 2.4 slice 2 — docs/38 procurement PR-4).
// convertPrToPo's line-validation layer runs BEFORE any item/PO write; the PR head lookup is the only
// read these paths need.
// Slice 6 adds the WRITE paths: createPr (header+lines one tx + workflow routing), the legacy Admin
// approve fallback, the 0228 own-doc withdraw (with the workflow-instance cleanup), one-tap reorderPr,
// the listPrs item-name backfill/scoping, and BOTH convertPrToPo shapes (legacy blanket-stamp full
// close vs split per-line linking that leaves the PR PartiallyConverted while lines remain).

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

// ───────────────────── write paths (slice 6) ─────────────────────
// A routed env: select() answers reads in call order; the tx captures the PR header+lines; db-level
// insert/update capture item opening and line/status stamps; the createPo PORT records each PO the
// conversion raises (returning sequential PO numbers) so the fan-out is observable end to end.

type PrCap = {
  headers: any[]; lines: any[][]; inserts: any[]; updates: any[]; logs: any[][];
  starts: any[]; acts: any[][]; cancels: any[][]; pos: any[]; preferred: any[][]; lineMsgs: any[][]; low: any[];
};

function prEnv(routes: any[][], opts: { lowItems?: any[]; inst?: any; cleared?: boolean } = {}) {
  const cap: PrCap = { headers: [], lines: [], inserts: [], updates: [], logs: [], starts: [], acts: [], cancels: [], pos: [], preferred: [], lineMsgs: [], low: opts.lowItems ?? [] };
  let call = 0;
  const chain = (rows: any[]) => {
    const p: any = { from: () => p, where: () => p, limit: () => p, orderBy: () => p, then: (r: any, j: any) => Promise.resolve(rows).then(r, j) };
    return p;
  };
  const tx = {
    insert: () => ({
      values: (v: any) => {
        if (Array.isArray(v)) { cap.lines.push(v); return Promise.resolve(); }
        cap.headers.push(v);
        return { returning: () => Promise.resolve([{ id: 21 }]) };
      },
    }),
  };
  const db = {
    // STRICT routing: an unexpected extra read throws instead of silently reusing the last route — e.g. a
    // split-convert regression that ignores pr_line_id and falls back to the item_id candidate lookup
    // performs one extra select and FAILS here, instead of producing byte-identical captures.
    select: () => { if (call >= routes.length) throw new Error(`unexpected select #${call + 1} — add a route`); return chain(routes[call++] ?? []); },
    transaction: async (cb: any) => cb(tx),
    insert: () => ({ values: (v: any) => { cap.inserts.push(v); return { onConflictDoNothing: () => Promise.resolve() }; } }),
    update: () => ({ set: (v: any) => ({ where: () => { cap.updates.push(v); return Promise.resolve(); } }) }),
  };
  const svc = new ProcurementPrService(
    db as any, docNo,
    { log: async (...a: any[]) => { cap.logs.push(a); } } as any,
    async () => null,
    async () => ({ items: cap.low }),
    async (itemId: string, dto: any) => { cap.preferred.push([itemId, dto]); },
    async (dto: any) => { cap.pos.push(dto); return { po_no: `PO-${cap.pos.length}`, status: 'Pending', total_amount: dto.items.reduce((a: number, it: any) => a + it.order_qty * it.unit_price, 0) }; },
    {
      start: async (d: any) => { cap.starts.push(d); },
      pendingInstanceFor: async () => opts.inst ?? null,
      act: async (id: number, d: any) => { cap.acts.push([id, d]); },
      canTransition: async () => opts.cleared ?? true,
      cancel: async (t: string, no: string) => { cap.cancels.push([t, no]); },
    } as any,
    { notifyUser: async (to: string, _g: any, msg: string) => { cap.lineMsgs.push([to, msg]); } } as any,
  );
  return { svc, cap };
}

describe('ProcurementPrService — createPr / approvePr / cancelPr write paths', () => {
  it('createPr inserts header+lines in one tx, logs Pending and routes into the approval engine', async () => {
    const { svc, cap } = prEnv([]);
    const r = await svc.createPr({ priority: 'Urgent', items: [
      { item_id: 'A', request_qty: 2, uom: 'ea', reason: 'ของหมด' },
      { item_id: 'B', request_qty: 1 },
    ] } as any, user);
    expect(r).toEqual({ pr_no: 'PR-TEST-001', status: 'Pending', lines: 2 });
    expect(cap.headers[0]).toMatchObject({ prNo: 'PR-TEST-001', requestedBy: 'buyer1', status: 'Pending', priority: 'Urgent' });
    expect(cap.lines[0]).toHaveLength(2);
    expect(cap.lines[0][0]).toMatchObject({ prId: 21, itemId: 'A', requestQty: '2', reason: 'ของหมด', status: 'Open' });
    expect(cap.logs[0]).toEqual(['PR', 'PR-TEST-001', '', 'Pending', 'buyer1']);
    expect(cap.starts[0]).toMatchObject({ docType: 'PR', docNo: 'PR-TEST-001' });
  });

  it('approvePr legacy fallback: Admin approves (no live workflow instance) → Approved update + log', async () => {
    const { svc, cap } = prEnv([[{ id: 1, prNo: 'PR-1', status: 'Pending' }]]);
    const r = await svc.approvePr('PR-1', true, { username: 'boss', role: 'Admin' } as any);
    expect(r).toEqual({ pr_no: 'PR-1', status: 'Approved' });
    expect(cap.updates[0]).toMatchObject({ status: 'Approved', approvedBy: 'boss' });
    expect(cap.logs[0]).toEqual(['PR', 'PR-1', 'Pending', 'Approved', 'boss']);
  });

  it('approvePr engine path: the decision routes through workflow.act; a non-final approval stays Pending', async () => {
    const { svc, cap } = prEnv([[{ id: 1, prNo: 'PR-1', status: 'Pending' }]], { inst: { id: 5 }, cleared: false });
    const r = await svc.approvePr('PR-1', true, { username: 'lvl1', role: 'Purchasing' } as any);
    expect(cap.acts[0]).toEqual([5, { decision: 'approve' }]);
    expect(r.status).toBe('Pending');   // more steps remain
    expect(cap.logs).toHaveLength(0);   // status unchanged → no log
  });

  it('cancelPr (0228): the requester withdraws their own Pending PR and the workflow instance is closed too', async () => {
    const { svc, cap } = prEnv([[{ id: 1, prNo: 'PR-1', status: 'Pending', requestedBy: 'buyer1' }]]);
    const r = await svc.cancelPr('PR-1', user);
    expect(r).toEqual({ pr_no: 'PR-1', status: 'Cancelled' });
    expect(cap.updates[0]).toEqual({ status: 'Cancelled' });
    expect(cap.cancels[0]).toEqual(['PR', 'PR-1']); // no orphan in the approval queue
  });

  it('reorderPr raises ONE PR covering every low-stock item at its suggested qty via the ordinary createPr path', async () => {
    const { svc, cap } = prEnv([], { lowItems: [
      { item_id: 'A', item_description: 'ปลากระป๋อง', suggested_qty: 5, uom: 'ea' },
      { item_id: 'B', suggested_qty: 2 },
    ] });
    const r = await svc.reorderPr(user);
    expect(r).toMatchObject({ pr_no: 'PR-TEST-001', lines: 2, items: [{ item_id: 'A', qty: 5 }, { item_id: 'B', qty: 2 }] });
    expect(cap.headers).toHaveLength(1);
    expect(cap.lines[0][0]).toMatchObject({ itemId: 'A', requestQty: '5', reason: 'ต่ำกว่าจุดสั่งซื้อ' });
  });
});

describe('ProcurementPrService — listPrs scoping + item-name backfill', () => {
  const HEAD = { id: 1, prNo: 'PR-1', prDate: '2026-07-01', requestedBy: 'req1', status: 'Pending', priority: 'Normal', approvedBy: null };
  const LINE = { id: 11, prId: 1, itemId: 'A', itemDescription: null, requestQty: '2', uom: 'ea', reason: null, poNo: null, status: 'Open' };

  it('an approver sees all PRs (can_approve) and a code-only line gets its name from the item master', async () => {
    const { svc } = prEnv([[HEAD], [LINE], [{ itemId: 'A', desc: 'ชื่อสินค้า เอ' }]]);
    const r = await svc.listPrs({ username: 'plan1', permissions: ['planner'] } as any);
    expect(r.can_approve).toBe(true);
    expect(r.prs[0].lines[0]).toMatchObject({ item_id: 'A', item_description: 'ชื่อสินค้า เอ', request_qty: 2 });
  });

  it('a plain pr_raise holder defaults to mine-only scoping (can_approve false)', async () => {
    // NB the fake ignores WHERE, so this pins the can_approve/scopeMine DECISION, not the SQL row filter —
    // the actual requested_by filtering is exercised end-to-end by the e2e/writeflow harnesses.
    const { svc } = prEnv([[HEAD], [LINE], []]);
    const r = await svc.listPrs({ username: 'req1', permissions: ['pr_raise'] } as any);
    expect(r.can_approve).toBe(false);
    expect(r.prs).toHaveLength(1);
  });

  it('a line that already carries its raise-time description keeps it (no master backfill) and maps its PO link', async () => {
    const head = { ...HEAD, approvedBy: 'boss' };
    const line = { ...LINE, itemDescription: 'ชื่อตอนเปิดใบ', poNo: 'PO-5', status: 'Converted', reason: 'ของหมด' };
    const { svc } = prEnv([[head], [line], [[]].flat()]); // items lookup still runs (itemId present) but finds nothing
    const r = await svc.listPrs({ username: 'plan1', permissions: ['planner'] } as any);
    expect(r.prs[0].approved_by).toBe('boss');
    expect(r.prs[0].lines[0]).toMatchObject({ item_description: 'ชื่อตอนเปิดใบ', po_no: 'PO-5', line_status: 'Converted', reason: 'ของหมด' });
  });
});

describe('ProcurementPrService — convertPrToPo write paths (legacy + split)', () => {
  const APPROVED = { id: 1, prNo: 'PR-1', status: 'Approved', requestedBy: 'req1' };

  it('legacy shape: one PO for all lines, PR lines blanket-stamped, PR fully Converted, requester notified', async () => {
    // routes: head lookup → create_item existence check (not found → open the code)
    const { svc, cap } = prEnv([[APPROVED], []]);
    const r = await svc.convertPrToPo('pr-1', {
      vendor_id: 4, vendor_name: 'V Co',
      lines: [
        { item_id: 'A', order_qty: 2, unit_price: 10 },
        { item_id: 'NEW1', item_description: 'ของใหม่', order_qty: 1, unit_price: 5, create_item: true },
      ],
    } as any, user);
    expect(r).toMatchObject({ pr_no: 'PR-1', pr_status: 'Converted', po_no: 'PO-1', total_amount: 25, created_items: ['NEW1'] });
    expect(cap.inserts[0]).toMatchObject({ itemId: 'NEW1', itemDescription: 'ของใหม่' }); // brand-new code opened first
    expect(cap.pos[0]).toMatchObject({ vendor_id: 4, remarks: 'จาก PR-1' });
    expect(cap.pos[0].items).toHaveLength(2);
    expect(cap.updates[0]).toEqual({ poNo: 'PO-1' });                    // blanket line stamp (WHERE breadth rides the harnesses)
    expect(cap.updates[1]).toEqual({ status: 'Converted' });             // PR closes fully
    expect(cap.lineMsgs[0][0]).toBe('req1');                             // D2: requester told, not the converter
    expect(cap.lineMsgs[0][1]).toContain('PO-1');
  });

  it('split shape: each line links to ITS po; unlinked lines leave the PR PartiallyConverted; set_preferred learns the vendor', async () => {
    // routes: head lookup → remaining-unlinked scan (one line still open)
    const { svc, cap } = prEnv([[APPROVED], [{ id: 99 }]]);
    const r = await svc.convertPrToPo('PR-1', { pos: [
      { vendor_id: 4, lines: [{ item_id: 'A', order_qty: 1, unit_price: 10, pr_line_id: 11, set_preferred: true }] },
    ] } as any, user);
    expect(r.pr_status).toBe('PartiallyConverted');
    expect(cap.updates[0]).toEqual({ poNo: 'PO-1', status: 'Converted' }); // precise pr_line_id link
    expect(cap.updates[1]).toEqual({ status: 'PartiallyConverted' });
    expect(cap.preferred[0]).toEqual(['A', { vendor_id: 4, unit_price: 10, uom: undefined }]);
    expect(cap.lineMsgs[0][1]).toContain('ยังมีรายการค้างรอสั่งเพิ่ม');
  });
});
