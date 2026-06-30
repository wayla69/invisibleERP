/**
 * Phase 18 depth — routings + shop-floor + QA (scrap GL) + MRP. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover mfg-depth
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'mfgd-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }]).onConflictDoNothing();
  const hq = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0].id);
  await db.insert(s.users).values([{ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }]).onConflictDoNothing();

  // BOM yields 10; flour 5×20 + sugar 2×15 = material 130; labor 50, oh 30 (per yield).
  const [bom] = await db.insert(s.bomMaster).values({ bomCode: 'BOM-CAKE', productName: 'เค้ก', yieldQty: '10', yieldUom: 'ชิ้น', laborCost: '50', overheadCost: '30' }).returning({ id: s.bomMaster.id });
  await db.insert(s.bomMasterLines).values([
    { bomId: Number(bom.id), itemId: 'FLOUR', itemDescription: 'แป้ง', useUom: 'kg', qtyUseUom: '5', unitCost: '20', lineCost: '100' },
    { bomId: Number(bom.id), itemId: 'SUGAR', itemDescription: 'น้ำตาล', useUom: 'kg', qtyUseUom: '2', unitCost: '15', lineCost: '30' },
  ]);

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
  const admin = (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' })).json.token;

  // ── 1. ROUTINGS: create with 2 operations ──
  const rt = await inj('POST', '/api/routings', admin, { routing_code: 'RT-CAKE', product_item_id: 'CAKE', name: 'ผลิตเค้ก', operations: [
    { op_no: 10, work_center: 'MIXER', description: 'ผสม', setup_min: 10, run_min_per_unit: 2, labor_rate: 300 },
    { op_no: 20, work_center: 'OVEN', description: 'อบ', setup_min: 20, run_min_per_unit: 3, labor_rate: 240 },
  ] });
  ok('Routing created with 2 operations', rt.status < 300 && rt.json.operations?.length === 2, JSON.stringify({ s: rt.status, ops: rt.json.operations?.length }));

  // ── 2. work order (qty 20) ──
  const wo = await inj('POST', '/api/manufacturing/work-orders', admin, { bom_code: 'BOM-CAKE', qty_planned: 20, product_item_id: 'CAKE', product_name: 'เค้ก' });
  const woNo = wo.json.wo_no;

  // ── 3. SHOP-FLOOR: generate ops from routing → op10 labor 250, op20 labor 320 ──
  const gen = await inj('POST', `/api/manufacturing/work-orders/${woNo}/routing/RT-CAKE`, admin);
  const op10 = (gen.json.operations ?? []).find((o: any) => o.op_no === 10);
  const op20 = (gen.json.operations ?? []).find((o: any) => o.op_no === 20);
  ok('Generate WO ops: op10 labor 250, op20 labor 320, planned 20',
    gen.json.operations?.length === 2 && near(op10?.labor_cost, 250) && near(op20?.labor_cost, 320) && near(op10?.planned_qty, 20),
    JSON.stringify({ o10: op10?.labor_cost, o20: op20?.labor_cost }));

  // ── 4. report op10: 18 good + 2 scrap → Done ──
  const rep = await inj('POST', `/api/manufacturing/work-orders/${woNo}/operations/10/report`, admin, { completed_qty: 18, scrap_qty: 2 });
  ok('Report op10 (18 + 2 scrap) → Done', rep.json.status === 'Done' && near(rep.json.completed_qty, 18) && near(rep.json.scrap_qty, 2), JSON.stringify({ st: rep.json.status }));
  const ops = await inj('GET', `/api/manufacturing/work-orders/${woNo}/operations`, admin);
  ok('Op list: 1/2 done, all_done false', ops.json.done_count === 1 && ops.json.all_done === false, JSON.stringify({ d: ops.json.done_count }));

  // ── 5. issue WO → WIP 420, then QA scrap 2 units @ 21 = 42 → Dr 5810 / Cr 1250 ──
  await inj('POST', `/api/manufacturing/work-orders/${woNo}/issue`, admin);
  const qa = await inj('POST', '/api/quality/inspect', admin, { ref_type: 'WO', ref_doc: woNo, item_id: 'CAKE', qty_inspected: 20, qty_passed: 18, qty_failed: 2, disposition: 'Scrap', unit_cost: 21 });
  ok('QA Scrap: value 42, GL JE posted', near(qa.json.scrap_value, 42) && /^JE-/.test(qa.json.entry_no ?? ''), JSON.stringify({ v: qa.json.scrap_value, e: qa.json.entry_no }));

  const tb = await inj('GET', '/api/ledger/trial-balance', admin);
  const row = (c: string) => (tb.json.rows ?? []).find((r: any) => r.account_code === c);
  ok('Scrap GL: 5810 dr 42, 1250 WIP 420−42=378, TB balanced',
    tb.json.totals?.balanced === true && near(row('5810')?.debit, 42) && near(row('1250')?.balance, 378),
    JSON.stringify({ bal: tb.json.totals?.balanced, scrap: row('5810')?.debit, wip: row('1250')?.balance }));

  // ── 6. MRP: demand 10 cakes (on-hand 0) → make 1, buy flour 5 + sugar 2 ──
  const mrp = await inj('POST', '/api/mrp/run', admin, { demand: [{ item_id: 'BOM-CAKE', qty: 10 }] });
  const flour = (mrp.json.planned_buy ?? []).find((b: any) => b.item_id === 'FLOUR');
  const sugar = (mrp.json.planned_buy ?? []).find((b: any) => b.item_id === 'SUGAR');
  ok('MRP: 1 make order + buy flour 5 & sugar 2 (BOM exploded, netted)',
    mrp.json.planned_make?.length === 1 && near(mrp.json.planned_make[0].qty, 10) && near(flour?.qty, 5) && near(sugar?.qty, 2),
    JSON.stringify({ make: mrp.json.planned_make?.length, flour: flour?.qty, sugar: sugar?.qty }));

  // ── 7. APS: work-centre master + finite-capacity scheduling (docs/22 Phase A) ──
  await inj('POST', '/api/work-centers', admin, { code: 'MIXER', name: 'เครื่องผสม', minutes_per_day: 480 });
  const wcList = await inj('POST', '/api/work-centers', admin, { code: 'OVEN', name: 'เตาอบ', minutes_per_day: 480 });
  ok('Work-centre master: MIXER + OVEN created (480 min/day)', (wcList.json.work_centers ?? []).length === 2 && wcList.json.work_centers.every((w: any) => near(w.minutes_per_day, 480)), JSON.stringify({ n: wcList.json.count }));
  // Two WOs (qty 20, product CAKE → RT-CAKE): op10 MIXER 10+2·20=50, op20 OVEN 20+3·20=80.
  const woA = (await inj('POST', '/api/manufacturing/work-orders', admin, { bom_code: 'BOM-CAKE', qty_planned: 20, product_item_id: 'CAKE', product_name: 'เค้ก A' })).json.wo_no;
  const woB = (await inj('POST', '/api/manufacturing/work-orders', admin, { bom_code: 'BOM-CAKE', qty_planned: 20, product_item_id: 'CAKE', product_name: 'เค้ก B' })).json.wo_no;
  // B is past-due → EDD dispatches B before A. horizon 2026-07-01.
  const sch = await inj('POST', '/api/aps/schedule', admin, { horizon_start: '2026-07-01', work_orders: [{ wo_no: woA, due_by: '2026-12-31' }, { wo_no: woB, due_by: '2026-06-30' }] });
  ok('APS schedule: 4 ops scheduled, no missing routings, makespan 210 min (1 day)',
    sch.json.summary?.scheduled === 4 && sch.json.summary?.unscheduled_no_routing === 0 && near(sch.json.makespan_minutes, 210) && sch.json.makespan_days === 1,
    JSON.stringify({ sc: sch.json.summary?.scheduled, ms: sch.json.makespan_minutes }));
  const mixer = (sch.json.work_centers ?? []).find((w: any) => w.work_center === 'MIXER');
  ok('APS finite capacity: MIXER runs one op at a time → dispatch starts [0, 50] (second op waits), load 100',
    mixer && near(mixer.load_minutes, 100) && (mixer.dispatch ?? []).length === 2 && near(mixer.dispatch[0].start_min, 0) && near(mixer.dispatch[1].start_min, 50),
    JSON.stringify({ load: mixer?.load_minutes, starts: (mixer?.dispatch ?? []).map((d: any) => d.start_min) }));
  ok('APS lateness: past-due WO flagged late, the far-due WO is not',
    sch.json.summary?.late === 1 && (sch.json.late ?? []).some((l: any) => l.wo_no === woB) && !(sch.json.late ?? []).some((l: any) => l.wo_no === woA),
    JSON.stringify({ late: (sch.json.late ?? []).map((l: any) => l.wo_no) }));

  console.log('\n── Phase 18 depth — routings/shop-floor/QA/MRP (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} mfg-depth checks failed` : `\n✅ All ${checks.length} mfg-depth checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
