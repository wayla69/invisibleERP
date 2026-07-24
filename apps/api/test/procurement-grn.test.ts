import { describe, expect, it } from 'vitest';

import { ProcurementGrnService, isWeightUom } from '../src/modules/procurement/procurement-grn.service';

// Unit tests for EXP-12 blind-count goods receiving (2.4 slice 8 — the docs/38 procurement PR-2
// sub-service is a plain class with callback ports). The control spine pinned here: the EXP-03
// PO-approval gate, the OVER_RECEIPT gate (aggregate per item; ONLY a weight UoM may exceed the order,
// within the configured tolerance), the binding PO_LINE_CLOSED close-short decision, the blind-count
// receiveLines shape (counted qty NEVER pre-filled), and the GR summary + claim deadline (part of the
// pinned golden master — a conscious change to createGr's return re-pins it).
// STRICT routed env (same convention as the sibling suites): select() answers db AND tx reads in one
// call-order sequence; an unexpected extra read throws instead of reusing a route.

type GrnCap = { inserts: any[]; updates: any[]; logs: any[][]; notifies: any[][]; consumes: any[][]; releases: any[][] };

function grnEnv(routes: any[][], opts: { withCommitments?: boolean } = {}) {
  const cap: GrnCap = { inserts: [], updates: [], logs: [], notifies: [], consumes: [], releases: [] };
  let call = 0;
  const chain = (rows: any[]) => {
    const p: any = { from: () => p, where: () => p, limit: () => p, orderBy: () => p, for: () => p, then: (r: any, j: any) => Promise.resolve(rows).then(r, j) };
    return p;
  };
  const select = () => { if (call >= routes.length) throw new Error(`unexpected select #${call + 1} — add a route`); return chain(routes[call++] ?? []); };
  const insert = () => ({
    values: (v: any) => {
      cap.inserts.push(v);
      return Object.assign(Promise.resolve(), { returning: () => Promise.resolve([{ id: 42 }]) });
    },
  });
  const update = () => ({ set: (v: any) => ({ where: () => { cap.updates.push(v); return Promise.resolve(); } }) });
  const tx = { select, insert, update };
  const db = { select, insert, update, transaction: async (cb: any) => cb(tx) };
  const svc = new ProcurementGrnService(
    db as any,
    { nextDaily: async () => 'GR-TEST-001' } as any,
    { log: async (...a: any[]) => { cap.logs.push(a); } } as any,
    async (poNo: string, msg: string) => { cap.notifies.push([poNo, msg]); },
    undefined, // costing — Phase 17A path stays harness-tested
    opts.withCommitments ? {
      consume: async (_db: any, t: string, no: string) => { cap.consumes.push([t, no]); },
      release: async (_db: any, t: string, no: string) => { cap.releases.push([t, no]); },
      // FIN-3 (BUD-02) GL-budget commitment release/consume on receipt (mirrors the project reserve/release).
      glConsume: async (_db: any, t: string, no: string) => { cap.consumes.push(['gl', t, no]); },
      glRelease: async (_db: any, t: string, no: string) => { cap.releases.push(['gl', t, no]); },
    } as any : undefined,
  );
  return { svc, cap };
}

const user = { username: 'whrecv', tenantId: null } as any; // tenantId null → costing/tenant settings paths off
const code = async (fn: () => Promise<unknown>) => {
  try { await fn(); } catch (e: any) { return e?.response?.code ?? String(e); }
  return 'NO_THROW';
};

describe('isWeightUom (EXP-12 weight-basis whitelist)', () => {
  it.each([
    ['kg', true], ['KG', true], [' กก. ', true], ['ตัน', true], ['gram', true], ['lb', true],
    ['ea', false], ['box', false], ['ชิ้น', false], [null, false], [undefined, false], ['', false],
  ] as const)('%s → %s', (uom, want) => {
    expect(isWeightUom(uom as any)).toBe(want);
  });
});

describe('ProcurementGrnService — receiving settings (EXP-12 tolerances)', () => {
  it('defaults apply when no row exists: 5% weight tolerance, 24h claim window', async () => {
    const { svc } = grnEnv([[]]);
    expect(await svc.getReceivingSettings(null)).toEqual({ overReceiptWeightPct: 5, claimWindowHours: 24 });
  });

  it('setReceivingSettings validates BEFORE any read: pct 0–100, hours a positive integer', async () => {
    const { svc } = grnEnv([]); // strict: any read would throw
    expect(await code(() => svc.setReceivingSettings({ over_receipt_weight_pct: 101 }, user))).toBe('BAD_PCT');
    expect(await code(() => svc.setReceivingSettings({ over_receipt_weight_pct: -1 }, user))).toBe('BAD_PCT');
    expect(await code(() => svc.setReceivingSettings({ claim_window_hours: 0 }, user))).toBe('BAD_HOURS');
    expect(await code(() => svc.setReceivingSettings({ claim_window_hours: 2.5 }, user))).toBe('BAD_HOURS');
  });

  it('updates the existing row (merging unset fields from current) and returns the fresh values', async () => {
    const ROW = { id: 9, overReceiptWeightPct: '5', claimWindowHours: 24 };
    // routes: existing lookup → getReceivingSettings(cur) → getReceivingSettings(out, post-update)
    const { svc, cap } = grnEnv([[ROW], [ROW], [{ ...ROW, overReceiptWeightPct: '10' }]]);
    const r = await svc.setReceivingSettings({ over_receipt_weight_pct: 10 }, user);
    expect(cap.updates[0]).toMatchObject({ overReceiptWeightPct: '10', claimWindowHours: 24, updatedBy: 'whrecv' });
    expect(r).toEqual({ over_receipt_weight_pct: 10, claim_window_hours: 24 });
  });
});

describe('ProcurementGrnService — receiveLines (blind count by design)', () => {
  it('exposes ordered/received/remaining but NO pre-filled count; a closed-short line is dead', async () => {
    const PO = { id: 1, poNo: 'PO-9', status: 'Approved', vendorName: 'V', poDate: '2026-07-01' };
    const LINES = [
      { itemId: 'A', itemDescription: 'ปลา', uom: 'kg', orderQty: '100', receivedQty: '40', status: 'Open' },
      { itemId: 'B', itemDescription: 'กล่อง', uom: 'box', orderQty: '10', receivedQty: '2', status: 'Closed' },
    ];
    const { svc } = grnEnv([[PO], LINES, []]); // po → lines → settings (defaults)
    const r = await svc.receiveLines('PO-9', user);
    expect(r.over_receipt_weight_pct).toBe(5);
    expect(r.lines[0]).toEqual({
      item_id: 'A', item_description: 'ปลา', uom: 'kg',
      order_qty: 100, received_qty: 40, remaining_qty: 60, is_weight: true, closed: false,
    });
    // the closed-short decision is binding: nothing further receivable, weight flag off
    expect(r.lines[1]).toMatchObject({ item_id: 'B', remaining_qty: 0, is_weight: false, closed: true });
    // blind count: no field carries a suggested/pre-filled counted qty
    expect(Object.keys(r.lines[0])).not.toContain('counted_qty');
  });
});

describe('ProcurementGrnService — createGr gates (EXP-03 + EXP-12 OVER_RECEIPT)', () => {
  const PO = { id: 1, poNo: 'PO-9', status: 'Approved', vendorId: 4, vendorName: 'V', currency: 'THB', fxRate: '1.000000', projectId: null };

  it('receiving against an unapproved/dead PO is PO_NOT_APPROVED (EXP-03 — no GR before approval)', async () => {
    for (const status of ['Pending', 'Draft', 'Rejected', 'Cancelled']) {
      const { svc } = grnEnv([[{ ...PO, status }]]);
      expect(await code(() => svc.createGr({ po_no: 'PO-9', items: [{ item_id: 'A', received_qty: 1 }] } as any, user))).toBe('PO_NOT_APPROVED');
    }
  });

  it('a GR with no positive quantity is BAD_REQUEST', async () => {
    const { svc } = grnEnv([[PO]]);
    expect(await code(() => svc.createGr({ po_no: 'PO-9', items: [{ item_id: 'A', received_qty: 0 }] } as any, user))).toBe('BAD_REQUEST');
  });

  it('a piece-count line is hard-capped at the ordered qty (OVER_RECEIPT) — nothing written', async () => {
    const POI = { id: 11, itemId: 'A', uom: 'ea', orderQty: '10', receivedQty: '0', status: 'Open' };
    const { svc, cap } = grnEnv([[PO], [], [POI]]); // po → settings(defaults) → poi scan
    expect(await code(() => svc.createGr({ po_no: 'PO-9', items: [{ item_id: 'A', received_qty: 11 }] } as any, user))).toBe('OVER_RECEIPT');
    expect(cap.inserts).toHaveLength(0);
  });

  it('two lots of one item cannot sneak past the gate — the check runs on the AGGREGATE', async () => {
    const POI = { id: 11, itemId: 'A', uom: 'ea', orderQty: '10', receivedQty: '0', status: 'Open' };
    const { svc } = grnEnv([[PO], [], [POI]]);
    expect(await code(() => svc.createGr({ po_no: 'PO-9', items: [
      { item_id: 'A', received_qty: 6, lot_no: 'L1' }, { item_id: 'A', received_qty: 5, lot_no: 'L2' },
    ] } as any, user))).toBe('OVER_RECEIPT');
  });

  it('a weight line may run over ONLY within the tolerance: 106kg on a 100kg order (5%) is blocked', async () => {
    const POI = { id: 11, itemId: 'A', uom: 'kg', orderQty: '100', receivedQty: '0', status: 'Open' };
    const { svc } = grnEnv([[PO], [], [POI]]);
    expect(await code(() => svc.createGr({ po_no: 'PO-9', items: [{ item_id: 'A', received_qty: 106 }] } as any, user))).toBe('OVER_RECEIPT');
  });

  it('a closed-short line takes no further stock (PO_LINE_CLOSED) — the close decision is binding', async () => {
    const POI = { id: 11, itemId: 'A', uom: 'ea', orderQty: '10', receivedQty: '4', status: 'Closed' };
    const { svc } = grnEnv([[PO], [], [POI]]);
    expect(await code(() => svc.createGr({ po_no: 'PO-9', items: [{ item_id: 'A', received_qty: 1 }] } as any, user))).toBe('PO_LINE_CLOSED');
  });
});

describe('ProcurementGrnService — createGr write path (partial + full receipt)', () => {
  const PO = { id: 1, poNo: 'PO-9', status: 'Approved', vendorId: 4, vendorName: 'V', currency: 'THB', fxRate: '1.000000', projectId: null };
  const POI = { id: 11, itemId: 'A', itemDescription: 'ปลา', uom: 'kg', orderQty: '100', receivedQty: '0', unitPrice: '25', isCapital: false, status: 'Open' };

  // route order: po → settings → poi (gate scan) → [tx] poi → item fixed-asset flag → [post-tx] all lines
  const routesFor = (allItemsAfter: any[]) => [[PO], [], [POI], [POI], [{ f: false }], allItemsAfter];

  it('a partial receipt: GR header+line+stock movement in one tx, PO → Received, summary shows the shortage + claim deadline', async () => {
    const before = Date.now();
    const { svc, cap } = grnEnv(routesFor([{ ...POI, receivedQty: '40' }]), { withCommitments: true });
    const r = await svc.createGr({ po_no: 'PO-9', items: [{ item_id: 'A', received_qty: 40, lot_no: 'L1' }] } as any, user);

    expect(r).toMatchObject({ gr_no: 'GR-TEST-001', po_no: 'PO-9', po_status: 'Received', lines: 1, costed: false });
    // one GR header + one GR line + one stock movement + one lot row (lot_no given)
    expect(cap.inserts[0]).toMatchObject({ grNo: 'GR-TEST-001', poNo: 'PO-9', vendorName: 'V', receivedBy: 'whrecv' });
    expect(cap.inserts[1]).toMatchObject({ grId: 42, itemId: 'A', receivedQty: '40', uom: 'kg', lotNo: 'L1', unitCost: '25', isCapital: false });
    expect(cap.inserts[2]).toMatchObject({ moveType: 'GR', docNo: 'GR-TEST-001', qty: '40', fromLocation: 'Supplier', toLocation: 'Warehouse' });
    expect(cap.inserts[3]).toMatchObject({ lotNo: 'L1', grNo: 'GR-TEST-001', qtyIn: '40', balance: '40', status: 'Active' });
    expect(cap.updates[1]).toEqual({ status: 'Received' }); // updates[0] is the poItems received_qty bump
    expect(cap.consumes).toHaveLength(0);                    // not fully received → commitments stay open
    expect(cap.notifies[0][1]).toContain('รับบางส่วน');

    // EXP-12 summary (golden-master shape): shortage surfaced + claim deadline = now + 24h (default window)
    expect(r.summary.claim_window_hours).toBe(24);
    const deadline = Date.parse(r.summary.claim_deadline);
    expect(deadline).toBeGreaterThanOrEqual(before + 24 * 3600_000 - 5000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 24 * 3600_000 + 5000);
    expect(r.summary.lines[0]).toEqual({
      item_id: 'A', item_description: 'ปลา', uom: 'kg',
      order_qty: 100, received_now: 40, received_total: 40, shortage_qty: 60, over_qty: 0, is_weight: true,
    });
  });

  it('a full receipt closes the PO and CONSUMES the project commitments (PROJ-12 open → consumed)', async () => {
    const { svc, cap } = grnEnv(routesFor([{ ...POI, receivedQty: '100' }]), { withCommitments: true });
    const r = await svc.createGr({ po_no: 'PO-9', items: [{ item_id: 'A', received_qty: 100 }] } as any, user);
    expect(r.po_status).toBe('Closed');
    expect(cap.consumes[0]).toEqual(['PO', 'PO-9']);
    expect(cap.notifies[0][1]).toContain('รับครบ');
    expect(r.summary.lines[0]).toMatchObject({ shortage_qty: 0, over_qty: 0 });
  });
});

describe('ProcurementGrnService — closePoShort (EXP-12: the shortage is never coming)', () => {
  const PO = { id: 1, poNo: 'PO-9', status: 'Received' };

  it('closes the PO + every line, RELEASES the remaining commitments (not consumed) and reports the short lines', async () => {
    const LINES = [
      { itemId: 'A', orderQty: '10', receivedQty: '4', uom: 'ea' },
      { itemId: 'B', orderQty: '5', receivedQty: '5', uom: 'ea' },
    ];
    const { svc, cap } = grnEnv([[PO], LINES], { withCommitments: true });
    const r = await svc.closePoShort('PO-9', 'ผู้ขายยกเลิก', user);
    expect(r).toEqual({ po_no: 'PO-9', po_status: 'Closed', short_lines: [{ item_id: 'A', short_qty: 6, uom: 'ea' }] });
    expect(cap.updates[0]).toEqual({ status: 'Closed' }); // PO header
    expect(cap.updates[1]).toEqual({ status: 'Closed' }); // every PO line — binds the PO_LINE_CLOSED gate
    expect(cap.releases[0]).toEqual(['PO', 'PO-9']);      // money never spent → released, NOT consumed
    expect(cap.logs[1]?.[5] ?? cap.logs[0]?.[5]).toContain('ปิดรับ (ของขาดส่ง): ผู้ขายยกเลิก');
  });

  it('only an Approved/Received PO can close short (BAD_STATUS)', async () => {
    const { svc } = grnEnv([[{ ...PO, status: 'Pending' }]]);
    expect(await code(() => svc.closePoShort('PO-9', undefined, user))).toBe('BAD_STATUS');
  });

  it('a fully-received PO has nothing outstanding (NOTHING_OUTSTANDING) — nothing written', async () => {
    const { svc, cap } = grnEnv([[PO], [{ itemId: 'A', orderQty: '10', receivedQty: '10' }]]);
    expect(await code(() => svc.closePoShort('PO-9', undefined, user))).toBe('NOTHING_OUTSTANDING');
    expect(cap.updates).toHaveLength(0);
  });
});

describe('ProcurementGrnService — GR note surfaces (print/list/email wiring)', () => {
  it('getGrForPrint assembles header + received lines + vendor + seller blocks', async () => {
    const GR = { id: 5, grNo: 'GR-7', grDate: '2026-07-01', poNo: 'PO-9', vendorId: 4, vendorName: 'V', receivedBy: 'whrecv', currency: 'THB', remarks: null };
    const LINES = [{ itemId: 'A', itemDescription: 'ปลา', receivedQty: '40', uom: 'kg', unitCost: '25', lotNo: 'L1' }];
    const VENDOR = { name: 'V Co Ltd', address: '99 หมู่ 9', taxId: '0105500000001', phone: null, email: 'v@example.com' };
    const { svc } = grnEnv([[GR], LINES, [VENDOR]]);
    const r = await svc.getGrForPrint('GR-7', { username: 'whrecv', tenantId: null } as any); // no tenant → generic seller
    expect(r.gr_no).toBe('GR-7');
    expect(r.vendor).toMatchObject({ name: 'V Co Ltd', tax_id: '0105500000001', email: 'v@example.com' });
    expect(r.lines).toEqual([{ item_id: 'A', description: 'ปลา', received_qty: 40, uom: 'kg', unit_cost: 25, lot_no: 'L1' }]);
  });

  it('null-side mapping: a GR with no vendor id skips the vendor lookup and every optional falls back', async () => {
    const GR = { id: 6, grNo: 'GR-8', grDate: null, poNo: null, vendorId: null, vendorName: null, receivedBy: null, currency: null, remarks: null };
    const LINE = { itemId: null, itemDescription: null, receivedQty: '5', uom: null, unitCost: null, lotNo: null };
    // strict routes: gr → lines → tenant (tenantId 1) — NO vendor select (vendorId null)
    const { svc } = grnEnv([[GR], [LINE], [{ legalName: 'บริษัท ทดสอบ' }]]);
    const r = await svc.getGrForPrint('GR-8', { username: 'whrecv', tenantId: 1 } as any);
    expect(r).toMatchObject({ gr_date: null, po_no: null, currency: 'THB' });
    expect(r.vendor.name).toBe('-');
    expect(r.lines[0]).toEqual({ item_id: null, description: null, received_qty: 5, uom: null, unit_cost: 0, lot_no: null });
  });

  it('listGrs maps the register rows; the unwired renderer/email paths fail explicitly', async () => {
    const { svc } = grnEnv([[{ grNo: 'GR-7', grDate: '2026-07-01', poNo: 'PO-9', vendorName: 'V', currency: 'THB', receivedBy: 'whrecv' }]]);
    const r = await svc.listGrs(user, 10);
    expect(r.count).toBe(1);
    expect(r.grs[0]).toEqual({ gr_no: 'GR-7', gr_date: '2026-07-01', po_no: 'PO-9', vendor_name: 'V', currency: 'THB', received_by: 'whrecv' });
    // grPdf/docEmail ports not wired in this env → explicit NOT_FOUND codes, not silent nulls
    expect(() => svc.goodsReceiptHtml({} as any)).toThrowError(/renderer/i);
    expect(await code(() => svc.emailGr('GR-7', undefined, user))).toBe('EMAIL_UNAVAILABLE');
  });
});

describe('ProcurementGrnService — receive conveniences (guards)', () => {
  const PO = { id: 1, poNo: 'PO-9', status: 'Approved' };

  it('receiveAllRemaining skips closed-short lines and 422s when nothing is outstanding', async () => {
    const { svc } = grnEnv([[PO], [
      { itemId: 'A', orderQty: '10', receivedQty: '10', status: 'Open' },   // fully received
      { itemId: 'B', orderQty: '5', receivedQty: '1', status: 'Closed' },   // closed short — skipped
    ]]);
    expect(await code(() => svc.receiveAllRemaining('PO-9', user))).toBe('NOTHING_TO_RECEIVE');
  });

  it('receiveItem: not on the PO → ITEM_NOT_ON_PO; closed short → PO_LINE_CLOSED; fully received → NOTHING_TO_RECEIVE', async () => {
    const a = grnEnv([[PO], []]);
    expect(await code(() => a.svc.receiveItem('PO-9', 'X', 1, user))).toBe('ITEM_NOT_ON_PO');
    const b = grnEnv([[PO], [{ itemId: 'A', orderQty: '10', receivedQty: '2', status: 'Closed' }]]);
    expect(await code(() => b.svc.receiveItem('PO-9', 'A', 1, user))).toBe('PO_LINE_CLOSED');
    const c = grnEnv([[PO], [{ itemId: 'A', orderQty: '10', receivedQty: '10', status: 'Open' }]]);
    expect(await code(() => c.svc.receiveItem('PO-9', 'A', 1, user))).toBe('NOTHING_TO_RECEIVE');
  });
});
