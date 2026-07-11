/**
 * Phase 18 — Manufacturing. Create a work order from a BOM → issue (materials+labor+oh → WIP) →
 * complete (WIP → finished goods), with balanced GL at every step. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover manufacturing
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'mfg-secret';
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
  await db.insert(s.users).values([{ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }, { username: 'mgr', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }]).onConflictDoNothing();

  // BOM: yields 10 cakes; materials 130 (flour 5×20 + sugar 2×15), labor 50, overhead 30 — per yield.
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
  const mgr = (await inj('POST', '/api/login', undefined, { username: 'mgr', password: 'admin123' })).json.token;

  // ── 1. create WO for 20 (factor 2) → material 260, labor 100, oh 60, total 420, unit 21 ──
  const wo = await inj('POST', '/api/manufacturing/work-orders', admin, { bom_code: 'BOM-CAKE', qty_planned: 20, product_item_id: 'CAKE', product_name: 'เค้ก' });
  const woNo = wo.json.wo_no;
  ok('Create WO scales BOM ×2 (material 260, labor 100, oh 60, total 420, unit 21, 2 comps)',
    near(wo.json.material_cost, 260) && near(wo.json.labor_cost, 100) && near(wo.json.overhead_cost, 60) &&
    near(wo.json.total_cost, 420) && near(wo.json.unit_cost, 21) && wo.json.components?.length === 2 && wo.json.status === 'Open',
    JSON.stringify({ m: wo.json.material_cost, t: wo.json.total_cost, u: wo.json.unit_cost }));

  // ── 2. issue → Released, WIP 420 ──
  const iss = await inj('POST', `/api/manufacturing/work-orders/${woNo}/issue`, admin);
  ok('Issue → Released, WIP cost 420, JE posted', iss.json.status === 'Released' && near(iss.json.wip_cost, 420) && /^JE-/.test(iss.json.entry_no ?? ''), JSON.stringify({ s: iss.json.status, w: iss.json.wip_cost }));

  // ── 3. GL after issue: Dr 1250 WIP 420; Cr 1200 material 260; Cr 2380 labor+oh 160; TB balanced ──
  const tb1 = await inj('GET', '/api/ledger/trial-balance', admin);
  const row1 = (c: string) => (tb1.json.rows ?? []).find((r: any) => r.account_code === c);
  ok('Issue GL: 1250 WIP dr 420, 1200 cr 260, 2380 cr 160, TB balanced',
    tb1.json.totals?.balanced === true && near(row1('1250')?.debit, 420) && near(row1('1200')?.credit, 260) && near(row1('2380')?.credit, 160),
    JSON.stringify({ bal: tb1.json.totals?.balanced, wip: row1('1250')?.debit, applied: row1('2380')?.credit }));

  // ── 4. double-issue blocked (state machine) ──
  const reissue = await inj('POST', `/api/manufacturing/work-orders/${woNo}/issue`, admin);
  ok('Re-issue blocked (400 BAD_STATUS)', reissue.status === 400 && reissue.json.error?.code === 'BAD_STATUS', `status=${reissue.status}`);

  // ── 5. complete → Completed, FG 420 ──
  const done = await inj('POST', `/api/manufacturing/work-orders/${woNo}/complete`, admin, { qty_produced: 20 });
  ok('Complete → Completed, FG value 420, qty 20', done.json.status === 'Completed' && near(done.json.fg_value, 420) && near(done.json.qty_produced, 20), JSON.stringify({ s: done.json.status, fg: done.json.fg_value }));

  // ── 6. GL after complete: 1210 FG dr 420; WIP 1250 nets to 0; TB balanced ──
  const tb2 = await inj('GET', '/api/ledger/trial-balance', admin);
  const row2 = (c: string) => (tb2.json.rows ?? []).find((r: any) => r.account_code === c);
  ok('Complete GL: 1210 FG dr 420, 1250 WIP balance 0, TB balanced',
    tb2.json.totals?.balanced === true && near(row2('1210')?.debit, 420) && near(row2('1250')?.balance, 0),
    JSON.stringify({ bal: tb2.json.totals?.balanced, fg: row2('1210')?.debit, wip: row2('1250')?.balance }));

  // ── 7. Yield variance: a 2nd WO produces 15 of 20 planned → FG at standard cost of 15, loss to 5810 ──
  const wo2 = await inj('POST', '/api/manufacturing/work-orders', admin, { bom_code: 'BOM-CAKE', qty_planned: 20, product_item_id: 'CAKE', product_name: 'เค้ก' });
  const wo2No = wo2.json.wo_no;
  await inj('POST', `/api/manufacturing/work-orders/${wo2No}/issue`, admin);
  // std unit = total 420 / 20 = 21; produce 15 → FG = 21×15 = 315; yield loss = 420 − 315 = 105 → 5810.
  const done2 = await inj('POST', `/api/manufacturing/work-orders/${wo2No}/complete`, admin, { qty_produced: 15 });
  ok('Yield variance: produce 15/20 → FG value 315, yield_variance 105 (loss)',
    done2.json.status === 'Completed' && near(done2.json.fg_value, 315) && near(done2.json.yield_variance, 105),
    JSON.stringify({ fg: done2.json.fg_value, var: done2.json.yield_variance }));
  const tb3 = await inj('GET', '/api/ledger/trial-balance', admin);
  const row3 = (c: string) => (tb3.json.rows ?? []).find((r: any) => r.account_code === c);
  ok('Yield variance GL: 5810 dr 105, 1210 FG cumulative 735, WIP nets 0, TB balanced',
    tb3.json.totals?.balanced === true && near(row3('5810')?.debit, 105) && near(row3('1210')?.debit, 735) && near(row3('1250')?.balance, 0),
    JSON.stringify({ bal: tb3.json.totals?.balanced, var5810: row3('5810')?.debit, fg: row3('1210')?.debit, wip: row3('1250')?.balance }));
  const woList = (await inj('GET', '/api/manufacturing/work-orders', admin)).json;
  const wo2Row = (woList.work_orders ?? []).find((w: any) => w.wo_no === wo2No);
  ok('WO register exposes yield_variance on the completed order (105); full-yield WO has 0',
    near(wo2Row?.yield_variance, 105) && near((woList.work_orders ?? []).find((w: any) => w.wo_no === woNo)?.yield_variance, 0),
    `wo2=${wo2Row?.yield_variance}`);

  // ── 8. material usage variance: complete at full yield but report ACTUAL material above standard ──
  const wo3 = await inj('POST', '/api/manufacturing/work-orders', admin, { bom_code: 'BOM-CAKE', qty_planned: 20, product_item_id: 'CAKE', product_name: 'เค้ก' });
  const wo3No = wo3.json.wo_no;
  await inj('POST', `/api/manufacturing/work-orders/${wo3No}/issue`, admin);
  // std material 260; report actual 300 → over-usage variance 40 → Dr 5810 40 / Cr 1200 40. Full yield → no yield var.
  const done3 = await inj('POST', `/api/manufacturing/work-orders/${wo3No}/complete`, admin, { qty_produced: 20, actual_material: 300 });
  ok('Material usage variance: actual 300 vs std 260 → material_variance 40 (over), no yield variance',
    near(done3.json.material_variance, 40) && near(done3.json.yield_variance, 0), JSON.stringify({ mv: done3.json.material_variance, yv: done3.json.yield_variance }));
  const tb4 = await inj('GET', '/api/ledger/trial-balance', admin);
  const row4 = (c: string) => (tb4.json.rows ?? []).find((r: any) => r.account_code === c);
  ok('Material variance GL: 5810 cumulative 145 (105 yield + 40 material), TB balanced',
    tb4.json.totals?.balanced === true && near(row4('5810')?.debit, 145),
    JSON.stringify({ bal: tb4.json.totals?.balanced, v5810: row4('5810')?.debit }));

  // ── docs/43 PR-5 — a GL-24-governed posting-rule override re-routes the MFG variance leg ──
  // Default path (5810) is pinned by §7/§8 above; an approved MFG.WO_COMPLETE rule re-routes a NEW
  // work order's yield-variance leg to 5811 while the FG/WIP controls stay pinned.
  await db.insert(s.accounts).values({ code: '5811', name: 'Yield Variance — override (PR-5)', type: 'Expense', normalBalance: 'D', isPostable: true }).onConflictDoNothing();
  const p5Rule = (await inj('POST', '/api/ledger/posting-rules', admin, { eventType: 'MFG.WO_COMPLETE', legOrder: 1, role: 'yield_variance', side: 'DR', accountCode: '5811' })).json;
  ok('PR-5: MFG.WO_COMPLETE override upsert lands PendingApproval (GL-24)', p5Rule?.status === 'PendingApproval', `${p5Rule?.status}`);
  const p5Ap = await inj('POST', `/api/ledger/posting-rules/${Number(p5Rule?.id)}/approve`, mgr);
  ok('PR-5: a different user approves the rule', p5Ap.status === 200 && p5Ap.json?.status === 'Approved', `${p5Ap.status} ${p5Ap.json?.status}`);
  const wo4 = await inj('POST', '/api/manufacturing/work-orders', admin, { bom_code: 'BOM-CAKE', qty_planned: 20, product_item_id: 'CAKE', product_name: 'เค้ก' });
  await inj('POST', `/api/manufacturing/work-orders/${wo4.json.wo_no}/issue`, admin);
  const done4 = await inj('POST', `/api/manufacturing/work-orders/${wo4.json.wo_no}/complete`, admin, { qty_produced: 15 });
  const tb5 = await inj('GET', '/api/ledger/trial-balance', admin);
  const row5 = (c: string) => (tb5.json.rows ?? []).find((r: any) => r.account_code === c);
  ok('PR-5: the approved override routes the NEW yield loss (105) to 5811; 5810 stays at 145; TB balanced',
    near(done4.json.yield_variance, 105) && near(row5('5811')?.debit, 105) && near(row5('5810')?.debit, 145) && tb5.json.totals?.balanced === true,
    JSON.stringify({ v5811: row5('5811')?.debit, v5810: row5('5810')?.debit, bal: tb5.json.totals?.balanced }));

  console.log('\n── Phase 18 — Manufacturing (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} manufacturing checks failed` : `\n✅ All ${checks.length} manufacturing checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
