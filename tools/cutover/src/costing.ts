/**
 * Phase 17A — Inventory costing (FIFO / Moving-Average / Standard) + valuation GL + ATP over PGlite.
 * Configured items capitalize on GR (Dr 1200 / Cr 2000, STD adds PPV 5500) and post method-correct COGS
 * (Dr 5000 / Cr 1200) on retail sale; valuation ties to GL 1200. Recipe COGS (5300) untouched.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover costing
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cost-secret';
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
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.01;

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง', vatRegistered: true }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'plan1', passwordHash: await pw.hash('pw'), role: 'Planner', tenantId: t1 },       // config/PO/GR/valuation/ATP
    { username: 'shop1', passwordHash: await pw.hash('pw'), role: 'Customer', tenantId: t1, customerName: 'T1' }, // portal sale
    { username: 'shop2', passwordHash: await pw.hash('pw'), role: 'Customer', tenantId: t2, customerName: 'T2' }, // RLS
  ]).onConflictDoNothing();
  for (const it of ['WIDGET', 'GADGET', 'STDPART']) await db.insert(s.items).values({ itemId: it, itemDescription: it, uom: 'EA', unitPrice: '10' }).onConflictDoNothing();
  const [v1] = await db.insert(s.vendors).values({ name: 'V1', isSupplier: true, approvalStatus: 'approved' }).returning({ id: s.vendors.id });
  const V1 = Number(v1.id);
  // customer_inventory for the sale decrement + ATP (plenty of stock)
  for (const it of ['WIDGET', 'GADGET', 'STDPART']) await db.insert(s.customerInventory).values({ tenantId: t1, itemId: it, itemDescription: it, uom: 'EA', currentStock: '500', reorderPoint: '10' });

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
  const admin = await login('admin', 'admin123');
  const plan1 = await login('plan1', 'pw');
  const shop1 = await login('shop1', 'pw');
  const shop2 = await login('shop2', 'pw');
  // receive: create a PO then GR it (the GR capitalizes configured items)
  const receive = async (item: string, qty: number, cost: number) => {
    const po = await inj('POST', '/api/procurement/pos', plan1, { vendor_id: V1, items: [{ item_id: item, order_qty: qty, unit_price: cost }] });
    return inj('POST', '/api/procurement/grs', plan1, { po_no: po.json.po_no, items: [{ item_id: item, received_qty: qty, unit_cost: cost }] });
  };
  const sell = (item: string, qty: number) => inj('POST', '/api/portal/pos/sales', shop1, { items: [{ item_id: item, qty, unit_price: 30 }] });
  const glOf = async (src: string, ref: string) => (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source='${src}' AND je.source_ref='${ref}'`)).rows as any[];
  const leg = (gl: any[], c: string, side: string) => Number(gl.filter((l) => l.account_code === c).reduce((a, l) => a + Number(l[side] || 0), 0));
  const saleNoOf = async (item: string) => ((await pg.query(`SELECT ref_doc FROM cost_movements WHERE item_id='${item}' AND kind='ISSUE' ORDER BY id DESC LIMIT 1`)).rows as any[])[0]?.ref_doc;

  // ── A. FIFO — two layers consumed in order ──
  await inj('PUT', '/api/costing/config', plan1, { item_id: 'WIDGET', method: 'FIFO' });
  const grW1 = await receive('WIDGET', 100, 10);
  const grW2 = await receive('WIDGET', 100, 12);
  const glW1 = await glOf('GRV', grW1.json.gr_no);
  const layers = (await pg.query(`SELECT count(*)::int n FROM cost_layers WHERE tenant_id=${t1} AND item_id='WIDGET'`)).rows as any[];
  ok('FIFO: 2 cost layers + GR capitalizes Dr1200=1000/Cr2000=1000', layers[0].n === 2 && near(leg(glW1, '1200', 'debit'), 1000) && near(leg(glW1, '2000', 'credit'), 1000), `layers=${layers[0].n}`);
  const sellW = await sell('WIDGET', 150);
  const wSale = await saleNoOf('WIDGET');
  const glWcogs = await glOf('POS-COGS-V', wSale);
  const rem = (await pg.query(`SELECT remaining_qty FROM cost_layers WHERE tenant_id=${t1} AND item_id='WIDGET' ORDER BY id`)).rows as any[];
  ok('FIFO sell 150 → COGS 1600 (100×10 + 50×12), L1=0 L2=50', near(leg(glWcogs, '5000', 'debit'), 1600) && near(leg(glWcogs, '1200', 'credit'), 1600) && near(rem[0]?.remaining_qty, 0) && near(rem[1]?.remaining_qty, 50), `${JSON.stringify(rem.map((r) => Number(r.remaining_qty)))}`);

  // ── B. AVG — running cost ──
  await inj('PUT', '/api/costing/config', plan1, { item_id: 'GADGET', method: 'AVG' });
  await receive('GADGET', 100, 10);
  await receive('GADGET', 100, 20);
  const avgRow = (await pg.query(`SELECT avg_cost, on_hand FROM item_costing WHERE tenant_id=${t1} AND item_id='GADGET'`)).rows as any[];
  const sellG = await sell('GADGET', 50);
  const gSale = await saleNoOf('GADGET');
  const glGcogs = await glOf('POS-COGS-V', gSale);
  ok('AVG: avg_cost 15 after 100@10+100@20; sell 50 → COGS 750', near(avgRow[0]?.avg_cost, 15) && near(leg(glGcogs, '5000', 'debit'), 750), `avg=${avgRow[0]?.avg_cost}`);

  // ── C. STD + PPV ──
  await inj('PUT', '/api/costing/config', plan1, { item_id: 'STDPART', method: 'STD', standard_cost: 10 });
  const grS1 = await receive('STDPART', 100, 12); // unfavorable
  const grS2 = await receive('STDPART', 100, 9);  // favorable
  const glS1 = await glOf('GRV', grS1.json.gr_no);
  const glS2 = await glOf('GRV', grS2.json.gr_no);
  ok('STD: unfavorable GR Dr1200=1000/Dr5500=200/Cr2000=1200; favorable Cr5500=100', near(leg(glS1, '1200', 'debit'), 1000) && near(leg(glS1, '5500', 'debit'), 200) && near(leg(glS1, '2000', 'credit'), 1200) && near(leg(glS2, '5500', 'credit'), 100), JSON.stringify({ s1: glS1.map((l) => `${l.account_code}:${Number(l.debit) || -Number(l.credit)}`) }));
  const sellS = await sell('STDPART', 50);
  const sSale = await saleNoOf('STDPART');
  const glScogs = await glOf('POS-COGS-V', sSale);
  ok('STD sell 50 → COGS at standard = 500', near(leg(glScogs, '5000', 'debit'), 500) && near(leg(glScogs, '1200', 'credit'), 500), `cogs=${leg(glScogs, '5000', 'debit')}`);

  // ── D. valuation ties to GL 1200 ──
  const val = await inj('GET', '/api/costing/valuation', plan1);
  ok('Valuation ties to GL 1200 (600+2250+1500=4350)', near(val.json.total_value, 4350) && near(val.json.gl_1200, 4350) && val.json.ties === true, JSON.stringify({ total: val.json.total_value, gl: val.json.gl_1200 }));

  // ── E. ATP with open-PO scheduled receipt ──
  await db.update(s.customerInventory).set({ currentStock: '50', reorderPoint: '10' }).where(and(eq(s.customerInventory.tenantId, t1), eq(s.customerInventory.itemId, 'WIDGET')));
  await db.insert(s.stockAllocations).values({ tenantId: t1, itemId: 'WIDGET', refDoc: 'SO-1', qty: '20', status: 'Open' });
  const apo = await inj('POST', '/api/procurement/pos', plan1, { vendor_id: V1, expected_date: '2026-07-01', items: [{ item_id: 'WIDGET', order_qty: 80, unit_price: 10 }] });
  await db.update(s.purchaseOrders).set({ status: 'Approved' }).where(eq(s.purchaseOrders.poNo, apo.json.po_no));
  const atp = await inj('GET', '/api/costing/atp?item_id=WIDGET&need_by=2026-12-31', plan1);
  ok('ATP = on_hand 50 − allocated 20 − safety 10 + scheduled 80 = 100', near(atp.json.on_hand, 50) && near(atp.json.allocated, 20) && near(atp.json.safety, 10) && near(atp.json.atp_qty, 100), JSON.stringify({ oh: atp.json.on_hand, al: atp.json.allocated, atp: atp.json.atp_qty }));
  const c1 = await inj('POST', '/api/costing/atp/check', plan1, { item_id: 'WIDGET', qty: 90, date: '2026-12-31' });
  const c2 = await inj('POST', '/api/costing/atp/check', plan1, { item_id: 'WIDGET', qty: 120, date: '2026-12-31' });
  ok('canPromise: 90 → true; 120 → false, shortfall 20', c1.json.can_promise === true && c2.json.can_promise === false && near(c2.json.shortfall, 20), JSON.stringify({ q90: c1.json.can_promise, q120: c2.json.can_promise, sh: c2.json.shortfall }));

  // ── F. idempotency + RLS + recipe-COGS regression ──
  const grvCnt = (await pg.query(`SELECT count(*)::int n FROM journal_entries WHERE source='GRV' AND source_ref='${grW1.json.gr_no}'`)).rows as any[];
  ok('GR valuation idempotent (one GRV JE per GR)', grvCnt[0].n === 1, `n=${grvCnt[0].n}`);
  const t2val = await inj('GET', '/api/costing/valuation', shop2);
  ok('RLS: T2 valuation does not see T1 cost layers (empty/0)', (t2val.json.items ?? []).length === 0 && near(t2val.json.total_value ?? 0, 0), JSON.stringify({ n: (t2val.json.items ?? []).length }));
  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  ok('Trial balance balanced after all costing activity', tb.totals?.balanced === true, JSON.stringify(tb.totals ?? {}));

  console.log('\n── Phase 17A — Inventory costing (FIFO/AVG/STD) + valuation + ATP ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} costing checks failed` : `\n✅ All ${checks.length} costing checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
