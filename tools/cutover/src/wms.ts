/**
 * Phase 17B — WMS (bins → putaway → wave → pick → pack → ship) + min-max replenishment + RMA over PGlite.
 * Proves the boundary: WMS posts ZERO GL (COGS booked at sale-issue); RMA money flows through ReturnsService.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover wms
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wms-secret';
process.env.NODE_ENV = 'test';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, and } from 'drizzle-orm';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import * as s from '../../../apps/api/dist/database/schema/index';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { LedgerService } from '../../../apps/api/dist/modules/ledger/ledger.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง', vatRegistered: true }, { code: 'T2', name: 'ร้านสอง' }, { code: 'T3', name: 'ร้านสามสาขา' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2, t3] = [await tid('HQ'), await tid('T1'), await tid('T2'), await tid('T3')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'wh1', passwordHash: await pw.hash('pw'), role: 'Warehouse', tenantId: t1 },
    { username: 'plan1', passwordHash: await pw.hash('pw'), role: 'Planner', tenantId: t1 },
    { username: 'plan2', passwordHash: await pw.hash('pw'), role: 'Planner', tenantId: t2 },
    { username: 'shop1', passwordHash: await pw.hash('pw'), role: 'Customer', tenantId: t1, customerName: 'T1' },
    { username: 'plan3', passwordHash: await pw.hash('pw'), role: 'Planner', tenantId: t3 },
    { username: 'wh3', passwordHash: await pw.hash('pw'), role: 'Warehouse', tenantId: t3 },
  ]).onConflictDoNothing();
  // Planner role is now SoD-clean; plan1/plan2/plan3 keep the old bundled perms (warehouse/procurement)
  // via per-user override so replenishment, WMS bins, and inter-branch transfer tests continue to pass.
  for (const un of ['plan1', 'plan2', 'plan3']) {
    const uid = Number((await db.select().from(s.users).where(eq(s.users.username, un)))[0].id);
    await db.insert(s.userPermissions).values(
      ['dashboard', 'exec', 'warehouse', 'procurement', 'planner', 'masterdata', 'approvals'].map((perm) => ({ userId: uid, perm })),
    ).onConflictDoNothing();
  }
  for (const it of ['A', 'B', 'R1', 'X1']) await db.insert(s.items).values({ itemId: it, itemDescription: it, uom: 'EA', unitPrice: '10' }).onConflictDoNothing();
  await db.insert(s.vendors).values({ name: 'V1', isSupplier: true, approvalStatus: 'approved' }).onConflictDoNothing();
  // customer_inventory: A high (portal sale), R1 below reorder (replenishment fires)
  await db.insert(s.customerInventory).values([
    { tenantId: t1, itemId: 'A', itemDescription: 'A', uom: 'EA', currentStock: '100', reorderPoint: '0', reorderQty: '0' },
    { tenantId: t1, itemId: 'R1', itemDescription: 'R1', uom: 'EA', currentStock: '3', reorderPoint: '10', reorderQty: '50' },
  ]);
  // T3 branch-aware fixture: two branches; X1 low at BB while BA holds a PARTIAL surplus → transfer 20 + buy 30
  await db.insert(s.branches).values([
    { tenantId: t3, code: 'BA', name: 'Flagship', isHq: true, active: true },
    { tenantId: t3, code: 'BB', name: 'Mall', isHq: false, active: true },
  ]).onConflictDoNothing();
  const brId = async (c: string) => Number((await db.select().from(s.branches).where(and(eq(s.branches.tenantId, t3), eq(s.branches.code, c))))[0].id);
  const [ba, bb] = [await brId('BA'), await brId('BB')];
  await db.insert(s.branchStock).values([
    { tenantId: t3, branchId: ba, itemId: 'X1', itemDescription: 'X1', uom: 'EA', onHand: '30', reorderPoint: '10', reorderQty: '50' },
    { tenantId: t3, branchId: bb, itemId: 'X1', itemDescription: 'X1', uom: 'EA', onHand: '2', reorderPoint: '10', reorderQty: '50' },
  ]);
  // two POS sales to batch into a wave (raw — wave just needs the order + its items)
  const mkSale = async (no: string, item: string, qty: number) => {
    const [h] = await db.insert(s.custPosSales).values({ saleNo: no, saleDate: '2026-06-22', tenantId: t1, subtotal: '100', discount: '0', taxAmount: '0', total: '100', paymentMethod: 'Cash', status: 'Completed', createdBy: 'shop1' }).returning({ id: s.custPosSales.id });
    await db.insert(s.custPosItems).values({ saleId: Number(h.id), itemId: item, itemDescription: item, qty: String(qty), uom: 'EA', unitPrice: '20', amount: String(qty * 20), discountPct: '0', isCustom: false });
  };
  await mkSale('SALE-W1', 'A', 5);
  await mkSale('SALE-W2', 'B', 3);

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const [admin, wh1, plan1, plan2, shop1] = [await login('admin', 'admin123'), await login('wh1', 'pw'), await login('plan1', 'pw'), await login('plan2', 'pw'), await login('shop1', 'pw')];
  const [plan3, wh3] = [await login('plan3', 'pw'), await login('wh3', 'pw')];
  const binQty = async (bin: string, item: string) => Number(((await pg.query(`SELECT bs.qty FROM bin_stock bs JOIN bins b ON bs.bin_id=b.id WHERE b.bin_code='${bin}' AND bs.item_id='${item}'`)).rows as any[])[0]?.qty ?? -1);

  // bins
  await inj('POST', '/api/wms/bins', wh1, { bin_code: 'A-01-01', bin_type: 'storage' });
  await inj('POST', '/api/wms/bins', wh1, { bin_code: 'QUAR-01', bin_type: 'quarantine' });

  // 1. putaway
  const pa1 = await inj('POST', '/api/wms/putaway', wh1, { gr_no: 'GR-T1', bin_code: 'A-01-01', item_id: 'A', qty: 10 });
  const mv = (await pg.query(`SELECT count(*)::int n FROM stock_movements WHERE doc_no='GR-T1' AND move_type='Transfer'`)).rows as any[];
  ok('Putaway A×10 → bin_stock 10 + Transfer movement', pa1.status < 300 && (await binQty('A-01-01', 'A')) === 10 && mv[0].n === 1, `qty=${await binQty('A-01-01', 'A')} status=${pa1.status}`);
  // 2. putaway idempotent
  await inj('POST', '/api/wms/putaway', wh1, { gr_no: 'GR-T1', bin_code: 'A-01-01', item_id: 'A', qty: 10 });
  ok('Putaway idempotent (same gr_no → stays 10, not 20)', (await binQty('A-01-01', 'A')) === 10, `qty=${await binQty('A-01-01', 'A')}`);

  // 2b. wave-candidates pending list (doc-reference dropdown feed): both sales appear before waving
  const candBefore = await inj('GET', '/api/wms/wave-candidates', wh1);
  const candRefs = (candBefore.json.candidates ?? []).map((c: any) => c.source_ref);
  ok('Wave-candidates lists un-waved sales (SALE-W1 + SALE-W2)', candBefore.status === 200 && candRefs.includes('SALE-W1') && candRefs.includes('SALE-W2'), JSON.stringify(candRefs));

  // 3. wave 2 orders
  const wave = await inj('POST', '/api/wms/waves', wh1, { orders: [{ source_type: 'POS', source_ref: 'SALE-W1' }, { source_type: 'POS', source_ref: 'SALE-W2' }] });
  const picks = (await pg.query(`SELECT pick_no, source_ref FROM pick_lists WHERE tenant_id=${t1} ORDER BY pick_no`)).rows as any[];
  const linesW1 = (await pg.query(`SELECT pll.* FROM pick_list_lines pll JOIN pick_lists pl ON pll.pick_id=pl.id WHERE pl.source_ref='SALE-W1'`)).rows as any[];
  ok('Wave batches 2 orders → 2 pick lists, A line binId resolved to A-01-01', wave.json.pick_count === 2 && picks.length === 2 && linesW1.length === 1 && linesW1[0].bin_id != null, JSON.stringify({ pc: wave.json.pick_count, lines: linesW1.length }));
  // 4. re-wave idempotent
  const wave2 = await inj('POST', '/api/wms/waves', wh1, { orders: [{ source_type: 'POS', source_ref: 'SALE-W1' }, { source_type: 'POS', source_ref: 'SALE-W2' }] });
  const picks2 = (await pg.query(`SELECT count(*)::int n FROM pick_lists WHERE tenant_id=${t1}`)).rows as any[];
  ok('Re-wave idempotent (pick_source_uq → 0 new pick lists)', wave2.json.pick_count === 0 && picks2[0].n === 2, `new=${wave2.json.pick_count} total=${picks2[0].n}`);

  // 4b. waved sales drop out of the candidates; picks pending list shows both Open picks
  const candAfter = await inj('GET', '/api/wms/wave-candidates', wh1);
  const candAfterRefs = (candAfter.json.candidates ?? []).map((c: any) => c.source_ref);
  const openPicks = await inj('GET', '/api/wms/picks?status=Open', wh1);
  ok('Waved sales leave wave-candidates; GET picks?status=Open lists both picks', !candAfterRefs.includes('SALE-W1') && !candAfterRefs.includes('SALE-W2') && (openPicks.json.picks ?? []).length === 2, JSON.stringify({ cand: candAfterRefs, picks: (openPicks.json.picks ?? []).length }));

  const pickW1 = picks.find((p) => p.source_ref === 'SALE-W1').pick_no;
  const pickW2 = picks.find((p) => p.source_ref === 'SALE-W2').pick_no;
  const lineW1 = Number(linesW1[0].id);
  const lineW2 = Number(((await pg.query(`SELECT pll.id FROM pick_list_lines pll JOIN pick_lists pl ON pll.pick_id=pl.id WHERE pl.source_ref='SALE-W2'`)).rows as any[])[0].id);
  // 4c. the /wms Pick screen path: list Open+Picking in one call, then read the pick's lines via the API
  const toPick = await inj('GET', '/api/wms/picks?status=Open,Picking', wh1);
  ok('GET picks?status=Open,Picking lists both un-picked picks (multi-status filter)', (toPick.json.picks ?? []).length === 2, `n=${(toPick.json.picks ?? []).length}`);
  const pickDetail = await inj('GET', `/api/wms/picks/${pickW1}`, wh1);
  const dLine = (pickDetail.json.lines ?? [])[0];
  ok('GET picks/:pickNo returns lines (pick_line_id + requested_qty + suggested bin) for the Pick screen', pickDetail.status === 200 && pickDetail.json.lines?.length === 1 && dLine?.pick_line_id === lineW1 && dLine?.item_id === 'A' && dLine?.requested_qty === 5 && dLine?.bin_code === 'A-01-01', JSON.stringify(dLine));
  const missPick = await inj('GET', '/api/wms/picks/NOPE-1', wh1);
  ok('GET picks/:pickNo unknown → 404 PICK_NOT_FOUND', missPick.status === 404 && missPick.json.error?.code === 'PICK_NOT_FOUND', `${missPick.status} ${missPick.json.error?.code}`);
  // 5. pick decrements bin stock (driven by the pick_line_id the Pick screen just read back)
  ok('Pick screen: the API-read pick_line_id is the same id pick() accepts', dLine?.pick_line_id === lineW1);
  const pick1 = await inj('POST', `/api/wms/picks/${pickW1}/pick`, wh1, { lines: [{ pick_line_id: lineW1, picked_qty: 4 }] });
  const issue = (await pg.query(`SELECT count(*)::int n FROM stock_movements WHERE doc_no='${pickW1}' AND move_type='Issue'`)).rows as any[];
  ok('Pick 4×A → bin_stock 10→6 + Issue movement + pick Picked', pick1.json.status === 'Picked' && (await binQty('A-01-01', 'A')) === 6 && issue[0].n === 1, `qty=${await binQty('A-01-01', 'A')}`);
  // 6. over-pick guard (B has no bin stock)
  const over = await inj('POST', `/api/wms/picks/${pickW2}/pick`, wh1, { lines: [{ pick_line_id: lineW2, picked_qty: 1 }] });
  ok('Over-pick guard (B no bin stock) → 422 PICK_SHORT, no negative', over.status === 422 && (await binQty('A-01-01', 'A')) === 6, `${over.status}`);

  // 7. pack
  const pack = await inj('POST', `/api/wms/picks/${pickW1}/pack`, wh1);
  ok('Pack → shipment shell (Packed)', pack.status < 300 && !!pack.json.shipment_no && pack.json.status === 'Packed', JSON.stringify(pack.json));
  // 7b. shipments pending list feeds the ship-tab dropdown (Packed only)
  const packedList = await inj('GET', '/api/wms/shipments?status=Packed', wh1);
  ok('GET shipments?status=Packed lists the packed shipment', packedList.status === 200 && (packedList.json.shipments ?? []).some((x: any) => x.shipment_no === pack.json.shipment_no), JSON.stringify(packedList.json.shipments ?? []));

  // 8. ship
  const ship = await inj('POST', `/api/wms/shipments/${pack.json.shipment_no}/ship`, wh1, { carrier: 'Kerry', tracking_no: 'KX123' });
  const shRow = (await pg.query(`SELECT tracking_no, status, shipped_at FROM shipments WHERE shipment_no='${pack.json.shipment_no}'`)).rows as any[];
  ok('Ship → Shipped + tracking + shipped_at', ship.json.status === 'Shipped' && shRow[0].tracking_no === 'KX123' && !!shRow[0].shipped_at, JSON.stringify({ st: ship.json.status, tk: shRow[0].tracking_no }));
  // 9. boundary — WMS posts NO GL
  const wmsGl = (await pg.query(`SELECT count(*)::int n FROM journal_entries WHERE source IN ('WMS','PICK','SHIP','PUTAWAY')`)).rows as any[];
  ok('Boundary: WMS execution posts ZERO journal entries', wmsGl[0].n === 0, `n=${wmsGl[0].n}`);

  // 10. replenishment min-max
  const sug = await inj('POST', '/api/replenishment/suggest', plan1);
  const r1 = (sug.json.suggestions ?? []).find((x: any) => x.item_id === 'R1');
  ok('Replenishment: R1 on_hand 3 ≤ reorder 10 → suggested_qty 50, urgency warning', !!r1 && r1.suggested_qty === 50 && r1.urgency === 'warning', JSON.stringify(r1 ?? {}));
  // 11. auto-PR
  const autopr = await inj('POST', '/api/replenishment/auto-pr', plan1, {});
  const sugAfter = (await inj('GET', '/api/replenishment/suggestions', plan1)).json.suggestions.find((x: any) => x.item_id === 'R1');
  ok('Auto-PR consolidates suggestions → PR + status PR_Created', !!autopr.json.pr_no && autopr.json.lines >= 1 && sugAfter?.status === 'PR_Created' && sugAfter?.pr_no === autopr.json.pr_no, JSON.stringify({ pr: autopr.json.pr_no, st: sugAfter?.status }));

  // 11b. Branch-aware replenishment (T3): transfer-before-buy split
  const bsug = await inj('POST', '/api/replenishment/suggest', plan3);
  const bsugs = bsug.json.suggestions ?? [];
  const xfer = bsugs.find((x: any) => x.item_id === 'X1' && x.route === 'transfer');
  const buy = bsugs.find((x: any) => x.item_id === 'X1' && x.route === 'buy');
  ok('Branch replen: X1 low at BB → transfer 20 (from BA) + buy 30 residual', !!xfer && xfer.transfer_qty === 20 && xfer.from_branch_id === ba && xfer.branch_id === bb && !!buy && buy.buy_qty === 30, JSON.stringify({ xfer, buy }));
  // 11c. auto-transfer moves branch_stock BA→BB + logs both legs
  const bsOnHand = async (br: number, it: string) => Number(((await pg.query(`SELECT on_hand FROM branch_stock WHERE tenant_id=${t3} AND branch_id=${br} AND item_id='${it}'`)).rows as any[])[0]?.on_hand ?? -1);
  const at = await inj('POST', '/api/replenishment/auto-transfer', wh3, {});
  const baAfter = await bsOnHand(ba, 'X1'), bbAfter = await bsOnHand(bb, 'X1');
  const xlog = (await pg.query(`SELECT log_type FROM cust_stock_log WHERE tenant_id=${t3} AND item_id='X1' AND log_type IN ('Transfer-Out','Transfer-In')`)).rows as any[];
  ok('Auto-transfer: branch_stock BA 30→10, BB 2→22 + Transfer-Out/In for both branches', !!at.json.doc_no && at.json.transfers === 1 && baAfter === 10 && bbAfter === 22 && xlog.length === 2, JSON.stringify({ doc: at.json.doc_no, baAfter, bbAfter, logs: xlog.length }));
  // 11d. transfer row terminal; auto-PR raises only the residual buy leg
  const apr3 = await inj('POST', '/api/replenishment/auto-pr', plan3, {});
  const after3 = (await inj('GET', '/api/replenishment/suggestions', plan3)).json.suggestions ?? [];
  const xferDone = after3.find((x: any) => x.item_id === 'X1' && x.route === 'transfer');
  const buyDone = after3.find((x: any) => x.item_id === 'X1' && x.route === 'buy');
  ok('Branch replen: transfer row Transfer_Done; buy residual → PR_Created (1 line)', xferDone?.status === 'Transfer_Done' && !!apr3.json.pr_no && apr3.json.lines === 1 && buyDone?.status === 'PR_Created' && buyDone?.pr_no === apr3.json.pr_no, JSON.stringify({ xs: xferDone?.status, bs: buyDone?.status, pr: apr3.json.pr_no, lines: apr3.json.lines }));
  // 11d-bis. Step 5 — demand-driven par recommendation for X1@BB (avg 10/day × lead 3 × 1.25 safety → ROP 38)
  await db.insert(s.custStockLog).values([
    { tenantId: t3, branchId: bb, itemId: 'X1', itemDescription: 'X1', logDate: new Date(), logType: 'Consume', qtyChange: '-150', balanceAfter: '0', refDoc: 'SALE-PAR1' },
    { tenantId: t3, branchId: bb, itemId: 'X1', itemDescription: 'X1', logDate: new Date(), logType: 'Sale', qtyChange: '-150', balanceAfter: '0', refDoc: 'SALE-PAR2' },
  ]);
  const par = await inj('GET', `/api/replenishment/par-recommendations?branch_id=${bb}&window_days=30`, plan3);
  const xpar = (par.json.recommendations ?? []).find((r: any) => r.item_id === 'X1');
  ok('Par: X1@BB avg 10/day × lead 3 × 1.25 → recommend ROP 38, under-buffered vs static', !!xpar && xpar.avg_daily_usage === 10 && xpar.recommended_reorder_point === 38 && xpar.under_buffered === true, JSON.stringify(xpar ?? {}));
  const applyPar = await inj('POST', '/api/replenishment/par-recommendations/apply', plan3, { branch_id: bb, item_id: 'X1', window_days: 30 });
  const ropAfter = Number(((await pg.query(`SELECT reorder_point FROM branch_stock WHERE tenant_id=${t3} AND branch_id=${bb} AND item_id='X1'`)).rows as any[])[0]?.reorder_point);
  ok('Par: apply writes recommended ROP 38 onto branch_stock', applyPar.json.applied === true && ropAfter === 38, JSON.stringify({ applied: applyPar.json.applied, ropAfter }));

  // 11e. RLS — T1 planner sees none of T3's branch suggestions
  const t1seeT3 = (await inj('GET', '/api/replenishment/suggestions', plan1)).json.suggestions ?? [];
  ok('RLS: T1 planner sees 0 of T3 branch suggestions', !t1seeT3.some((x: any) => x.item_id === 'X1'), `t1 X1 rows=${t1seeT3.filter((x: any) => x.item_id === 'X1').length}`);
  // 11f. Authorization — a user with neither warehouse nor wh_custody cannot execute inter-branch transfers
  const noCustody = await inj('POST', '/api/replenishment/auto-transfer', shop1, {});
  ok('Authz: no warehouse/wh_custody → auto-transfer 403 (transfer is a gated custody duty)', noCustody.status === 403, `status=${noCustody.status}`);

  // 12. RMA — real portal sale (captured payment) → authorize → receive → restock to bin + ReturnsService credit
  const sale = await inj('POST', '/api/portal/pos/sales', shop1, { items: [{ item_id: 'A', qty: 2, unit_price: 50 }] });
  const saleNo = sale.json.sale_no;
  const rma = await inj('POST', '/api/rma', wh1, { sale_no: saleNo, reason: 'damaged', lines: [{ item_id: 'A', qty: 1 }] });
  const rmaLineId = Number(((await pg.query(`SELECT l.id FROM rma_lines l JOIN rmas r ON l.rma_id=r.id WHERE r.rma_no='${rma.json.rma_no}'`)).rows as any[])[0].id);
  await inj('POST', `/api/rma/${rma.json.rma_no}/receive`, wh1, { lines: [{ rma_line_id: rmaLineId, disposition: 'restock', restock_bin_code: 'A-01-01' }] });
  const before = await binQty('A-01-01', 'A');
  const restock = await inj('POST', `/api/rma/${rma.json.rma_no}/restock`, wh1, { refund_method: 'Cash' });
  const after = await binQty('A-01-01', 'A');
  ok('RMA: restock +1 to bin (6→7) + ReturnsService credit (return_no) + Credited', restock.json.status === 'Credited' && !!restock.json.return_no && after === before + 1, JSON.stringify({ rn: restock.json.return_no, before, after }));
  // RMA restock idempotent
  const restock2 = await inj('POST', `/api/rma/${rma.json.rma_no}/restock`, wh1, { refund_method: 'Cash' });
  ok('RMA restock idempotent (Credited → no double restock)', (restock2.json.duplicate === true || restock2.status === 400) && (await binQty('A-01-01', 'A')) === after, `qty=${await binQty('A-01-01', 'A')}`);

  // 13. RLS — T2 planner sees no T1 bins / suggestions
  const t2bins = await inj('GET', '/api/wms/bins', plan2);
  const t2sug = await inj('GET', '/api/replenishment/suggestions', plan2);
  ok('RLS: T2 sees 0 T1 bins + 0 T1 suggestions', (t2bins.json.bins ?? []).length === 0 && (t2sug.json.suggestions ?? []).length === 0, JSON.stringify({ b: (t2bins.json.bins ?? []).length, s: (t2sug.json.suggestions ?? []).length }));
  // 13b. Storage layout (2D/3D map) + locate item + bin-capacity integrity (INV-08)
  await inj('PATCH', '/api/wms/bins/A-01-01/layout', wh1, { pos_x: 0, pos_y: 0, pos_z: 0, dim_w: 1.2, dim_d: 1, dim_h: 2, capacity: 1000 });
  await inj('POST', '/api/wms/bins', wh1, { bin_code: 'CAP-01', bin_type: 'storage', capacity: 5, pos_x: 2, pos_y: 0, pos_z: 0 });
  const lay = (await inj('GET', '/api/wms/layout', wh1)).json;
  const aBin = (lay.bins ?? []).find((b: any) => b.bin_code === 'A-01-01');
  ok('Layout: bins carry geometry + live utilisation (on-hand ÷ capacity)', !!aBin && aBin.pos?.x === 0 && aBin.dim?.h === 2 && aBin.capacity === 1000 && aBin.on_hand > 0 && aBin.utilization !== null, JSON.stringify({ pos: aBin?.pos, oh: aBin?.on_hand, u: aBin?.utilization }));
  const loc = (await inj('GET', '/api/wms/locate?item_id=A', wh1)).json;
  ok('Locate item A → bin(s) with qty + position', (loc.locations ?? []).some((l: any) => l.bin_code === 'A-01-01' && l.qty > 0) && loc.total_qty > 0, `n=${loc.count} total=${loc.total_qty}`);
  const cap1 = await inj('POST', '/api/wms/putaway', wh1, { gr_no: 'GR-CAP-1', bin_code: 'CAP-01', item_id: 'A', qty: 4 });
  ok('INV-08: putaway within capacity ok (4 ≤ 5)', cap1.status < 300 && (await binQty('CAP-01', 'A')) === 4, `st=${cap1.status}`);
  const cap2 = await inj('POST', '/api/wms/putaway', wh1, { gr_no: 'GR-CAP-2', bin_code: 'CAP-01', item_id: 'A', qty: 3 });
  ok('INV-08: putaway beyond capacity rejected (4+3 > 5) → 422 BIN_CAPACITY_EXCEEDED', cap2.status === 422 && cap2.json?.error?.code === 'BIN_CAPACITY_EXCEEDED', `st=${cap2.status} code=${cap2.json?.error?.code}`);
  ok('INV-08: rejected putaway left bin stock unchanged (stays 4)', (await binQty('CAP-01', 'A')) === 4, `qty=${await binQty('CAP-01', 'A')}`);

  // 14. trial balance still balanced (only the portal sale + RMA return touched GL)
  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  ok('Trial balance balanced (WMS no GL; RMA via returns)', tb.totals?.balanced === true, JSON.stringify(tb.totals ?? {}));

  console.log('\n── Phase 17B — WMS (bins/pick/pack/ship/wave) + replenishment + RMA ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} WMS checks failed` : `\n✅ All ${checks.length} WMS checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
