import { describe, expect, it } from 'vitest';
import { UnprocessableEntityException } from '@nestjs/common';

import { ProcurementPoService } from '../src/modules/procurement/procurement-po.service';

// Unit tests for the PO lifecycle guards (workstream 2.4 — the docs/38 procurement PR-3 sub-service is a
// plain class with callback ports, so the Phase-16 screening contract is provable without PGlite).
// Slice 6 adds the WRITE paths: the createPo transaction (header+lines in one tx, Draft-vs-Pending
// workflow routing, the M1/PROJ-12 BoQ-line encumbrance port), approvePo through the engine AND the
// legacy Admin fallback (webhook fan-out + D2 requester notify), cancelPo (GR guard, commitment
// release) and the printable-PO assembly (VAT shown only for a VAT-registered buyer).

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

// ───────────────────── write paths (slice 6) ─────────────────────
// A routed env: select() answers reads in call order, the tx captures the header/lines inserts, and every
// port (status log, workflow, webhooks, requester notify, commitments) records what the service hands it.

type PoCap = {
  headers: any[]; items: any[][]; updates: any[]; logs: any[][];
  starts: any[]; acts: any[][]; emits: any[][]; notifies: any[][]; reserves: any[]; releases: any[][];
};

function poEnv(routes: any[][], opts: { inst?: any; cleared?: boolean; noWorkflow?: boolean } = {}) {
  const cap: PoCap = { headers: [], items: [], updates: [], logs: [], starts: [], acts: [], emits: [], notifies: [], reserves: [], releases: [] };
  let call = 0;
  const chain = (rows: any[]) => {
    const p: any = { from: () => p, where: () => p, limit: () => p, orderBy: () => p, then: (r: any, j: any) => Promise.resolve(rows).then(r, j) };
    return p;
  };
  const tx = {
    insert: () => ({
      values: (v: any) => {
        if (Array.isArray(v)) { cap.items.push(v); return Promise.resolve(); }
        cap.headers.push(v);
        return { returning: () => Promise.resolve([{ id: 42 }]) };
      },
    }),
  };
  const db = {
    // STRICT routing: an unexpected extra read throws instead of silently reusing the last route, so a
    // service refactor that adds/reorders a lookup FAILS the test rather than passing vacuously.
    select: () => { if (call >= routes.length) throw new Error(`unexpected select #${call + 1} — add a route`); return chain(routes[call++] ?? []); },
    transaction: async (cb: any) => cb(tx),
    update: () => ({ set: (v: any) => ({ where: () => { cap.updates.push(v); return Promise.resolve(); } }) }),
  };
  const svc = new ProcurementPoService(
    db as any, docNo,
    { log: async (...a: any[]) => { cap.logs.push(a); } } as any,
    allow, noProject,
    async (poNo: string, msg: string) => { cap.notifies.push([poNo, msg]); },
    opts.noWorkflow ? undefined : {
      start: async (d: any) => { cap.starts.push(d); },
      pendingInstanceFor: async () => opts.inst ?? null,
      act: async (id: number, d: any) => { cap.acts.push([id, d]); },
      canTransition: async () => opts.cleared ?? true,
    } as any,
    { emit: async (e: string, p: any) => { cap.emits.push([e, p]); } } as any,
    {
      reserve: async (_tx: any, d: any) => { cap.reserves.push(d); },
      release: async (_db: any, t: string, no: string) => { cap.releases.push([t, no]); },
      // FIN-3 (BUD-02) GL-budget gate: null gate = policy off (these unit tests don't exercise budget control).
      glGateForDoc: async () => null,
      glReserve: async () => {},
      glConsume: async () => {},
      glRelease: async (_db: any, t: string, no: string) => { cap.releases.push(['gl', t, no]); },
    } as any,
  );
  return { svc, cap };
}

describe('ProcurementPoService — createPo write path (header+lines one tx, workflow routing)', () => {
  const ITEMS = [
    { item_id: 'A', order_qty: 2, unit_price: 10 },
    { item_id: 'B', order_qty: 1, unit_price: 10, is_capital: true },
  ];

  it('a normal PO opens Pending, inserts header+lines in one tx, logs and routes into the approval engine', async () => {
    const { svc, cap } = poEnv([]);
    const r = await svc.createPo({ vendor_id: 9, vendor_name: 'V Co', items: ITEMS } as any, user);
    expect(r).toEqual({ po_no: 'PO-TEST-001', status: 'Pending', total_amount: 30 });
    expect(cap.headers[0]).toMatchObject({ poNo: 'PO-TEST-001', vendorId: 9, vendorName: 'V Co', status: 'Pending', totalAmount: '30', createdBy: 'buyer1' });
    expect(cap.items[0]).toHaveLength(2);
    expect(cap.items[0][0]).toMatchObject({ poId: 42, itemId: 'A', orderQty: '2', unitPrice: '10', amount: '20', isCapital: false, status: 'Open' });
    expect(cap.items[0][1]).toMatchObject({ itemId: 'B', isCapital: true });
    expect(cap.logs[0]).toEqual(['PO', 'PO-TEST-001', '', 'Pending', 'buyer1']);
    expect(cap.starts[0]).toMatchObject({ docType: 'PO', docNo: 'PO-TEST-001', amount: 30 });
  });

  it('a PMR auto-draft (draft:true) opens Draft and does NOT enter the approval workflow', async () => {
    const { svc, cap } = poEnv([]);
    const r = await svc.createPo({ vendor_id: 9, vendor_name: 'V Co', draft: true, items: ITEMS } as any, user);
    expect(r.status).toBe('Draft');
    expect(cap.headers[0]).toMatchObject({ status: 'Draft' });
    expect(cap.starts).toHaveLength(0);
    expect(cap.logs[0]).toEqual(['PO', 'PO-TEST-001', '', 'Draft', 'buyer1']);
  });

  it('resolves the missing half of the vendor pair from the master (name→id and id→name)', async () => {
    const byName = poEnv([[{ id: 9, name: 'V Co' }]]);
    await byName.svc.createPo({ vendor_name: 'V Co', items: ITEMS } as any, user);
    expect(byName.cap.headers[0]).toMatchObject({ vendorId: 9, vendorName: 'V Co' });

    const byId = poEnv([[{ id: 9, name: 'V Co' }]]);
    await byId.svc.createPo({ vendor_id: 9, items: ITEMS } as any, user);
    expect(byId.cap.headers[0]).toMatchObject({ vendorId: 9, vendorName: 'V Co' });
  });

  it('a BoQ-tagged project line encumbers its budget INSIDE the tx (M1/PROJ-12), honouring authorized_over_budget', async () => {
    const { svc, cap } = poEnv([]);
    await svc.createPo({
      vendor_id: 9, vendor_name: 'V Co', project_id: 5, authorized_over_budget: true,
      items: [{ item_id: 'A', order_qty: 2, unit_price: 10, boq_line_id: 7 }, { item_id: 'B', order_qty: 1, unit_price: 5 }],
    } as any, user);
    expect(cap.reserves).toHaveLength(1); // only the BoQ-tagged line reserves
    expect(cap.reserves[0]).toMatchObject({ projectId: 5, boqLineId: 7, amount: 20, qty: 2, sourceDocType: 'PO', sourceDocNo: 'PO-TEST-001', allowOver: true });
    expect(cap.headers[0]).toMatchObject({ projectId: 5 });
  });
});

describe('ProcurementPoService — approvePo (engine-first, legacy Admin fallback)', () => {
  const PO = { id: 1, poNo: 'PO-9', status: 'Pending', vendorName: 'V Co', remarks: null };

  it('legacy fallback: Admin approves → Approved update, po.approved webhook, ✅ requester notify', async () => {
    const { svc, cap } = poEnv([[PO]], { noWorkflow: true });
    const r = await svc.approvePo('PO-9', true, undefined, { username: 'boss', role: 'Admin' } as any);
    expect(r).toEqual({ po_no: 'PO-9', status: 'Approved' });
    expect(cap.updates[0]).toMatchObject({ status: 'Approved', approvedBy: 'boss' });
    expect(cap.emits[0][0]).toBe('po.approved');
    expect(cap.notifies[0][0]).toBe('PO-9');
    expect(cap.notifies[0][1]).toContain('✅');
  });

  it('legacy fallback: a non-Admin cannot decide (FORBIDDEN)', async () => {
    const { svc } = poEnv([[PO]], { noWorkflow: true });
    expect(await code(() => svc.approvePo('PO-9', true, undefined, { username: 'u', role: 'Purchasing' } as any))).toBe('FORBIDDEN');
  });

  it('engine path: the decision routes through workflow.act; a non-final approval stays Pending with no webhook', async () => {
    const { svc, cap } = poEnv([[PO]], { inst: { id: 3 }, cleared: false });
    const r = await svc.approvePo('PO-9', true, undefined, { username: 'lvl1', role: 'Purchasing' } as any);
    expect(cap.acts[0]).toEqual([3, { decision: 'approve' }]);
    expect(r.status).toBe('Pending');         // more steps remain
    expect(cap.emits).toHaveLength(0);        // no terminal event yet
    expect(cap.logs).toHaveLength(0);         // status unchanged → no log
  });

  it('engine path: a rejection lands Cancelled with the reason in remarks, po.rejected webhook, ❌ notify', async () => {
    const { svc, cap } = poEnv([[PO]], { inst: { id: 3 } });
    const r = await svc.approvePo('PO-9', false, 'too pricey', { username: 'lvl1', role: 'Purchasing' } as any);
    expect(r.status).toBe('Cancelled');
    expect(cap.updates[0]).toMatchObject({ status: 'Cancelled', remarks: 'Rejected: too pricey' });
    expect(cap.emits[0][0]).toBe('po.rejected');
    expect(cap.notifies[0][1]).toContain('❌');
  });
});

describe('ProcurementPoService — cancelPo (GR guard + commitment release)', () => {
  const PO = { id: 1, poNo: 'PO-9', status: 'Pending' };

  it('cancels with a reason: Cancelled update, reasoned status log, BoQ commitments released (PROJ-12)', async () => {
    const { svc, cap } = poEnv([[PO], []]); // po → no GR
    const r = await svc.cancelPo('PO-9', 'duplicate order', user);
    expect(r).toEqual({ po_no: 'PO-9', status: 'Cancelled' });
    expect(cap.updates[0]).toMatchObject({ status: 'Cancelled', remarks: 'duplicate order' });
    expect(cap.logs[0]).toEqual(['PO', 'PO-9', 'Pending', 'Cancelled', 'buyer1', 'duplicate order']);
    expect(cap.releases[0]).toEqual(['PO', 'PO-9']);
  });

  it('a received PO (GR exists) cannot be cancelled by a non-Admin (FORBIDDEN)', async () => {
    const { svc } = poEnv([[PO], [{ id: 7 }]]);
    expect(await code(() => svc.cancelPo('PO-9', 'x', { username: 'u', role: 'Purchasing' } as any))).toBe('FORBIDDEN');
  });

  it('a cancel without a reason is BAD_REQUEST', async () => {
    const { svc } = poEnv([[PO], []]);
    expect(await code(() => svc.cancelPo('PO-9', '', user))).toBe('BAD_REQUEST');
  });
});

describe('ProcurementPoService — getPoForPrint (VAT estimate only for a VAT-registered buyer)', () => {
  const PO = { id: 1, poNo: 'PO-9', poDate: '2026-07-01', status: 'Approved', vendorId: 4, vendorName: 'V Co', currency: 'THB' };
  const LINES = [
    { itemId: 'A', itemDescription: 'Item A', orderQty: '2', unitPrice: '10', amount: '20', uom: 'ea' },
    { itemId: 'B', itemDescription: 'Item B', orderQty: '1', unitPrice: '5', amount: '5', uom: 'ea' },
  ];
  const VENDOR = { vendorCode: 'V004', name: 'V Co Ltd', address: '99 หมู่ 9', taxId: '0105500000001' };

  it('assembles buyer/vendor/lines and estimates VAT at the registered buyer tenant rate', async () => {
    const tenant = { legalName: 'บริษัท ทดสอบ จำกัด', vatRegistered: true, vatRate: '0.07', addressLine1: '123 ถ.ทดสอบ', province: 'กรุงเทพฯ', taxId: '0105500009999' };
    const { svc } = poEnv([[PO], LINES, [VENDOR], [tenant]]);
    const r = await svc.getPoForPrint('PO-9', { username: 'buyer1', tenantId: 1 } as any);
    expect(r.lines).toEqual([
      { item_id: 'A', description: 'Item A', qty: 2, uom: 'ea', unit_price: 10, amount: 20 },
      { item_id: 'B', description: 'Item B', qty: 1, uom: 'ea', unit_price: 5, amount: 5 },
    ]);
    expect(r.subtotal).toBe(25);
    expect(r.vat_rate).toBe(0.07);
    expect(r.vat_amount).toBe(1.75);
    expect(r.grand_total).toBe(26.75);
    expect(r.buyer).toMatchObject({ name: 'บริษัท ทดสอบ จำกัด', tax_id: '0105500009999' });
    expect(r.buyer.address).toContain('123 ถ.ทดสอบ');
    expect(r.vendor).toMatchObject({ code: 'V004', name: 'V Co Ltd', tax_id: '0105500000001' });
    expect(r.template).toBeTruthy(); // presentation default when no template service is wired
  });

  it('suppresses the VAT row entirely for a non-VAT-registered buyer (a PO is not a tax document)', async () => {
    const tenant = { name: 'ร้านเล็ก', vatRegistered: false };
    const { svc } = poEnv([[PO], LINES, [VENDOR], [tenant]]);
    const r = await svc.getPoForPrint('PO-9', { username: 'buyer1', tenantId: 1 } as any);
    expect(r.vat_rate).toBe(0);
    expect(r.vat_amount).toBe(0);
    expect(r.grand_total).toBe(25);
  });

  it('null-side mapping: an HQ caller (no tenant) with a name-only vendor gets the generic buyer block', async () => {
    const bare = { id: 1, poNo: 'PO-9', poDate: null, status: null, vendorId: null, vendorName: 'ร้านค้าปากซอย', currency: null, remarks: null, createdBy: null, approvedBy: null, approvedAt: null, expectedDate: null };
    const line = { itemId: null, itemDescription: null, orderQty: '2', unitPrice: '10', amount: null, uom: null }; // amount null → qty×price fallback
    // strict routes: po → lines only — NO vendor select (vendorId null), NO tenant select (tenantId null)
    const { svc } = poEnv([[bare], [line]]);
    const r = await svc.getPoForPrint('PO-9', { username: 'hq', tenantId: null } as any);
    expect(r.buyer).toMatchObject({ name: 'บริษัทของฉัน', address: '-', tax_id: null, branch_label: 'สำนักงานใหญ่' });
    expect(r.vendor.name).toBe('ร้านค้าปากซอย'); // falls back to the PO header's captured name
    expect(r.lines[0].amount).toBe(20);
    expect(r.vat_rate).toBe(0); // no tenant → never fabricate VAT
    expect(r.currency).toBe('THB');
  });
});
