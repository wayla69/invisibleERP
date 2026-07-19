/**
 * Inventory — Waste / spoilage logging (ของเสีย/ทิ้ง) over PGlite (W1):
 * reason-coded ingredient waste decrements customer_inventory and (when costed) posts Dr 5810 / Cr 1200;
 * by-reason analytics; perpetual-tracked items are pushed to the INV-07 write-off (no double-handling).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover waste
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'waste-secret';
process.env.NODE_ENV = 'test';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'wh1', passwordHash: await pw.hash('pw1'), role: 'Warehouse', tenantId: t1 },
    { username: 'wh2', passwordHash: await pw.hash('pw2'), role: 'Warehouse', tenantId: t2 },
    { username: 'arc1', passwordHash: await pw.hash('pw'), role: 'ArClerk', tenantId: t1 }, // PE-10: order_mgt (sales) but no wh_adjust/exec
  ]).onConflictDoNothing();
  // seed ingredient stock for T1: 100 units of PORK on hand
  await db.insert(s.customerInventory).values({ tenantId: t1, itemId: 'PORK', itemDescription: 'หมูสับ', uom: 'kg', currentStock: '100' });
  // POS-5a — seed a recipe + ingredient stock for the void-fired-item capture: FRIEDRICE = 0.2kg RICE (30/kg) + 1 EGG (5/ea)
  await db.insert(s.customerInventory).values([
    { tenantId: t1, itemId: 'RICE', itemDescription: 'ข้าวสาร', uom: 'kg', currentStock: '50' },
    { tenantId: t1, itemId: 'EGG', itemDescription: 'ไข่ไก่', uom: 'ea', currentStock: '200' },
  ]);
  const [frItem] = await db.insert(s.menuItems).values({ tenantId: t1, sku: 'FRIEDRICE', name: 'ข้าวผัด', type: 'food', price: '60', active: true }).returning();
  const [fr] = await db.insert(s.menuRecipes).values({ tenantId: t1, menuItemId: Number(frItem.id), sku: 'FRIEDRICE', yieldQty: '1', active: true }).returning();
  await db.insert(s.menuRecipeLines).values([
    { tenantId: t1, recipeId: Number(fr.id), ingredientItemId: 'RICE', ingredientDescription: 'ข้าวสาร', qtyPer: '0.2', uom: 'kg', unitCost: '30' },
    { tenantId: t1, recipeId: Number(fr.id), ingredientItemId: 'EGG', ingredientDescription: 'ไข่ไก่', qtyPer: '1', uom: 'ea', unitCost: '5' },
  ]);
  // POS-5a — seed recipe-COGS 'Consume' depletion for RICE (theoretical usage baseline for the usage-variance report):
  // 50 servings sold × 0.2kg = 10kg theoretical use.
  await db.insert(s.custStockLog).values({ tenantId: t1, itemId: 'RICE', itemDescription: 'ข้าวสาร', logDate: new Date(), logType: 'Consume', qtyChange: '-10', balanceAfter: '40', refDoc: 'SALE-1', createdBy: 'pos' });

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
  const wh1 = await login('wh1', 'pw1');
  const wh2 = await login('wh2', 'pw2');
  const admin = await login('admin', 'admin123');
  const gl = async (code: string) => Number(((await pg.query(`SELECT coalesce(sum(jl.debit)-sum(jl.credit),0) v FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.account_code='${code}' AND je.status='Posted' AND je.tenant_id=${t1}`)).rows as any[])[0].v);
  const stock = async () => Number(((await pg.query(`SELECT current_stock v FROM customer_inventory WHERE tenant_id=${t1} AND item_id='PORK'`)).rows as any[])[0].v);

  // ── 1. costed waste → Dr 5810 / Cr 1200, stock down, waste_no ──
  // PE-10 — a sales-duty user (order_mgt, no wh_adjust/exec) must NOT post an inventory write-off.
  const arc1 = await login('arc1', 'pw');
  const wSales = await inj('POST', '/api/inventory/waste', arc1, { item_id: 'PORK', qty: 1, reason_code: 'spoilage', unit_cost: 80 });
  ok('PE-10: a sales role (order_mgt, no wh_adjust) cannot post a waste write-off (403)', wSales.status === 403, `${wSales.status} ${wSales.json?.error?.code}`);
  const w1 = await inj('POST', '/api/inventory/waste', wh1, { item_id: 'PORK', qty: 5, reason_code: 'spoilage', unit_cost: 80 });
  ok('Waste: spoilage 5×80 → total 400, WASTE- + JE-', /^WASTE-/.test(w1.json.waste_no ?? '') && near(w1.json.total_cost, 400) && /^JE-/.test(w1.json.journal_no ?? ''), JSON.stringify(w1.json).slice(0, 110));
  ok('Waste: GL Dr 5810 Waste 400 / Cr 1200 Inventory 400', near(await gl('5810'), 400) && near(await gl('1200'), -400), `5810=${await gl('5810')} 1200=${await gl('1200')}`);
  ok('Waste: ingredient stock 100 → 95', near(await stock(), 95), `stock=${await stock()}`);

  // ── 2. uncosted waste (no unit_cost) → logged, stock down, NO GL ──
  const w2 = await inj('POST', '/api/inventory/waste', wh1, { item_id: 'PORK', qty: 3, reason_code: 'prep_error' });
  ok('Waste: uncosted prep_error logged, no JE, stock → 92', w2.json.journal_no == null && near(w2.json.total_cost, 0) && near(await stock(), 92), `je=${w2.json.journal_no} stock=${await stock()}`);

  // ── 3. validation: bad reason / non-positive qty ──
  const badR = await inj('POST', '/api/inventory/waste', wh1, { item_id: 'PORK', qty: 1, reason_code: 'nonsense' });
  const badQ = await inj('POST', '/api/inventory/waste', wh1, { item_id: 'PORK', qty: 0, reason_code: 'damage' });
  ok('Waste: invalid reason + non-positive qty rejected (400)', badR.status === 400 && badQ.status === 400, `${badR.status}/${badQ.status}`);

  // ── 4. perpetual-tracked item is pushed to the INV-07 write-off (no waste-log double-handling) ──
  await db.insert(s.invBalances).values({ tenantId: t1, itemId: 'WIDGET', locationId: 'WH-MAIN', qty: '10', avgCost: '50', totalValue: '500', costingMethod: 'moving_avg' });
  const perp = await inj('POST', '/api/inventory/waste', wh1, { item_id: 'WIDGET', qty: 1, reason_code: 'damage', unit_cost: 50 });
  ok('Waste: perpetual item rejected → USE_WRITEOFF (400)', perp.status === 400 && perp.json.error?.code === 'USE_WRITEOFF', `${perp.status} ${perp.json.error?.code}`);

  // ── 5. analytics: by-reason totals ──
  const list = await inj('GET', '/api/inventory/waste', wh1);
  const spoil = (list.json.by_reason ?? []).find((r: any) => r.reason === 'spoilage');
  ok('Waste analytics: total cost 400, by-reason spoilage cost 400 / prep_error cost 0', near(list.json.total_cost, 400) && near(spoil?.cost, 400) && list.json.count === 2, JSON.stringify(list.json.by_reason));

  // ── 6. RLS: T2 sees none of T1's waste ──
  const t2list = await inj('GET', '/api/inventory/waste', wh2);
  ok('RLS: T2 sees 0 of T1 waste', t2list.json.count === 0, `t2count=${t2list.json.count}`);

  // ── 7. trial balance balanced ──
  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  ok('Trial balance balanced after waste postings', tb.totals?.balanced === true, JSON.stringify(tb.totals ?? {}));

  // ── 8. POS-5a: disposition taxonomy — costed waste with a disposition + invalid disposition rejected ──
  const disp = await inj('POST', '/api/inventory/waste', wh1, { item_id: 'PORK', qty: 2, reason_code: 'expiry', unit_cost: 80, disposition: 'donate' });
  ok('Waste: disposition=donate accepted, echoed back', disp.status === 201 && disp.json.disposition === 'donate' && near(disp.json.total_cost, 160), `${disp.status} ${disp.json.disposition}`);
  const badD = await inj('POST', '/api/inventory/waste', wh1, { item_id: 'PORK', qty: 1, reason_code: 'damage', disposition: 'nonsense' });
  ok('Waste: invalid disposition rejected (400 BAD_DISPOSITION)', badD.status === 400, `${badD.status}`);

  // ── 9. POS-5a: void-fired-item capture — a voided FRIEDRICE explodes its recipe to ingredient waste + one JE ──
  //   1 dish × (0.2kg RICE @30 = 6.00) + (1 EGG @5 = 5.00) = 11.00; reason void_fire, source void_fire.
  const vf = await inj('POST', '/api/inventory/waste/void-fire', wh1, { sku: 'FRIEDRICE', qty: 1, ref_doc: 'TCKT-9', disposition: 'discard' });
  ok('VoidFire: FRIEDRICE explodes to 2 ingredient waste lines, total 11.00, one JE', vf.status === 201 && vf.json.lines === 2 && near(vf.json.total_cost, 11) && /^WASTE-/.test(vf.json.waste_no ?? '') && /^JE-/.test(vf.json.journal_no ?? ''), JSON.stringify(vf.json).slice(0, 140));
  const riceStock = async () => Number(((await pg.query(`SELECT current_stock v FROM customer_inventory WHERE tenant_id=${t1} AND item_id='RICE'`)).rows as any[])[0].v);
  ok('VoidFire: RICE stock 50 → 49.8 (0.2kg written off)', near(await riceStock(), 49.8), `rice=${await riceStock()}`);
  const vfBad = await inj('POST', '/api/inventory/waste/void-fire', wh1, { sku: 'NOPE', qty: 1 });
  ok('VoidFire: unknown sku → NO_RECIPE (400)', vfBad.status === 400 && vfBad.json.error?.code === 'NO_RECIPE', `${vfBad.status} ${vfBad.json.error?.code}`);

  // ── 10. POS-5a: by_disposition analytics + void_fire reason surface in the list ──
  const list2 = await inj('GET', '/api/inventory/waste', wh1);
  const donateD = (list2.json.by_disposition ?? []).find((d: any) => d.disposition === 'donate');
  const voidR = (list2.json.by_reason ?? []).find((r: any) => r.reason === 'void_fire');
  ok('Waste: by_disposition rolls up donate cost 160; void_fire reason present', near(donateD?.cost, 160) && voidR != null && voidR.count === 2, JSON.stringify(list2.json.by_disposition));
  const dispFilter = await inj('GET', '/api/inventory/waste?disposition=donate', wh1);
  ok('Waste: ?disposition=donate filter returns only the donate row', dispFilter.json.count === 1 && dispFilter.json.waste[0]?.disposition === 'donate', `count=${dispFilter.json.count}`);

  // ── 11. POS-5a: theoretical-vs-actual USAGE variance — RICE theoretical 10kg (Consume), waste 0.2kg (void_fire) ──
  const varr = await inj('GET', '/api/inventory/waste/variance', wh1);
  const riceVar = (varr.json.items ?? []).find((i: any) => i.item_id === 'RICE');
  ok('UsageVariance: RICE theoretical 10, waste 0.2, actual 10.2, variance_cost 6 (0.2×30), pct 2%',
    riceVar != null && near(riceVar.theoretical_use, 10) && near(riceVar.waste_use, 0.2) && near(riceVar.actual_use, 10.2) && near(riceVar.variance_cost, 6) && near(riceVar.variance_pct, 2),
    JSON.stringify(riceVar));
  ok('UsageVariance: summary variance_cost > 0 (waste-explained usage above recipe theoretical)', varr.json.summary?.variance_cost > 0, JSON.stringify(varr.json.summary));

  // ── 12. trial balance still balanced after disposition + void-fire postings ──
  const tb2 = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  ok('Trial balance balanced after POS-5a postings', tb2.totals?.balanced === true, JSON.stringify(tb2.totals ?? {}));

  await app.close();
  await pg.close();
  console.log('\n── Inventory Waste / spoilage logging (ของเสีย/ทิ้ง) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} waste checks failed` : `\n✅ All ${checks.length} waste checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
