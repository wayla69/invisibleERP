/**
 * Accounting Tier 3 — Revenue Recognition / Deferred Revenue (รายได้รอตัดบัญชี) over PGlite:
 * defer prepaid cash to 2400 Unearned Revenue, recognize straight-line into 4000 over the term.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover revrec
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'revrec-secret';
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
const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

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
    { username: 'hqadmin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: null }, // HQ super-admin (no tenant)
    { username: 'sales1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 },
    { username: 'sales2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t2 },
  ]).onConflictDoNothing();

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
  const [admin, sales1, sales2] = [await login('admin', 'admin123'), await login('sales1', 'pw1'), await login('sales2', 'pw2')];
  const leg = (j: any, c: string, side: string) => (j?.lines ?? []).filter((l: any) => l.account_code === c).reduce((a: number, l: any) => a + Number(l[side]), 0);
  const jBy = async (source: string, sourceRef?: string) => (await inj('GET', '/api/ledger/journal?limit=40', admin)).json.entries.find((e: any) => e.source === source && (!sourceRef || e.source_ref === sourceRef));

  const accJson = JSON.stringify((await inj('GET', '/api/ledger/accounts', admin)).json);
  ok('COA seeded with 2400 Unearned Revenue', accJson.includes('2400'));

  // S1: 12-month schedule for 1200 starting 2032-01
  const s1 = await inj('POST', '/api/revenue/schedules', admin, { total_amount: 1200, start_period: '2032-01', months: 12, receipt_date: '2032-01-05' });
  ok('Create 12-month schedule (DEFREV-, 12 lines)', /^DEFREV-/.test(s1.json.schedule_no ?? '') && s1.json.lines?.length === 12, `${s1.status} ${JSON.stringify(s1.json).slice(0, 90)}`);
  const jDef = await jBy('DEFREV', s1.json.schedule_no);
  ok('Deferral GL: Dr1000=1200 / Cr2400=1200', near(leg(jDef, '1000', 'debit'), 1200) && near(leg(jDef, '2400', 'credit'), 1200));
  ok('Straight-line split: 12×100, sum 1200', s1.json.lines.every((l: any) => near(l.amount, 100)) && near(s1.json.lines.reduce((a: number, l: any) => a + l.amount, 0), 1200));

  // S2: 1300 over 12 (remainder test) starting 2033-01 (won't interfere with 2032 recognition)
  const s2 = await inj('POST', '/api/revenue/schedules', admin, { total_amount: 1300, start_period: '2033-01', months: 12, receipt_date: '2033-01-05' });
  ok('Remainder split: 1300/12 → 11×108.3333 + 108.3337, sum 1300', near(s2.json.lines.slice(0, 11).reduce((a: number, l: any) => a + l.amount, 0), 1191.6663) && near(s2.json.lines.reduce((a: number, l: any) => a + l.amount, 0), 1300));

  // recognize 2032-01 → S1 line 100
  const rec1 = await inj('POST', '/api/revenue/recognize?period=2032-01', admin);
  ok('Recognize 2032-01: posts REVREC 100', rec1.json.recognized_count >= 1 && near(rec1.json.journals.find((j: any) => j.schedule_no === s1.json.schedule_no)?.amount, 100), JSON.stringify(rec1.json).slice(0, 90));
  const jRec = await jBy('REVREC', `${s1.json.schedule_no}:2032-01`);
  ok('Recognition GL: Dr2400=100 / Cr4000=100', near(leg(jRec, '2400', 'debit'), 100) && near(leg(jRec, '4000', 'credit'), 100));
  const def1 = await inj('GET', '/api/revenue/deferred', admin);
  ok('Deferred after 1 month: S1 remaining 1100', near(def1.json.by_schedule.find((b: any) => b.schedule_no === s1.json.schedule_no)?.remaining, 1100), JSON.stringify(def1.json.by_schedule?.[0]));
  ok('GL 2400 reconciles to unrecognized lines', def1.json.reconciled === true && near(def1.json.gl_unearned, def1.json.deferred_balance), JSON.stringify({ g: def1.json.gl_unearned, d: def1.json.deferred_balance }));

  // idempotent re-run
  const rec1b = await inj('POST', '/api/revenue/recognize?period=2032-01', admin);
  ok('Recognition idempotent (re-run → 0 new)', rec1b.json.recognized_count === 0, JSON.stringify(rec1b.json).slice(0, 50));

  // recognize the remaining 11 months of S1
  for (let m = 2; m <= 12; m++) await inj('POST', `/api/revenue/recognize?period=2032-${String(m).padStart(2, '0')}`, admin);
  const def2 = await inj('GET', '/api/revenue/deferred', admin);
  ok('After 12 months: S1 deferred 0', near(def2.json.by_schedule.find((b: any) => b.schedule_no === s1.json.schedule_no)?.remaining, 0), JSON.stringify(def2.json.by_schedule.find((b: any) => b.schedule_no === s1.json.schedule_no)));
  const sl = await inj('GET', '/api/revenue/schedules?status=completed', admin);
  ok('Schedule status → completed after full recognition', (sl.json.schedules ?? []).some((x: any) => x.schedule_no === s1.json.schedule_no && near(x.remaining_amount, 0)), `count=${sl.json.count}`);
  const is = await inj('GET', '/api/ledger/income-statement?from=2032-01-01&to=2032-12-31', admin);
  ok('Income statement 2032: revenue 1200 recognized', near(is.json.revenue, 1200), `rev=${is.json.revenue}`);
  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json.totals ?? {};
  ok('Trial balance balanced after deferral + recognition', near(tb.debit ?? tb.total_debit, tb.credit ?? tb.total_credit), JSON.stringify(tb).slice(0, 60));

  // RLS
  await inj('POST', '/api/revenue/schedules', sales1, { total_amount: 600, start_period: '2034-01', months: 6 });
  await inj('POST', '/api/revenue/schedules', sales2, { total_amount: 700, start_period: '2034-01', months: 7 });
  const l1 = await inj('GET', '/api/revenue/schedules', sales1);
  ok('RLS: T1 sees only its own schedule (600, not 700)', (l1.json.schedules ?? []).some((x: any) => near(x.total_amount, 600)) && !(l1.json.schedules ?? []).some((x: any) => near(x.total_amount, 700)), JSON.stringify((l1.json.schedules ?? []).map((x: any) => x.total_amount)));

  // ── cross-tenant guard (W2/M1): HQ super-admin (no tenant) must name a tenant; recognition is scoped ──
  await inj('POST', '/api/revenue/schedules', sales1, { total_amount: 300, start_period: '2035-01', months: 1 }); // T1 due line in 2035-01
  await inj('POST', '/api/revenue/schedules', sales2, { total_amount: 400, start_period: '2035-01', months: 1 }); // T2 due line in 2035-01
  const hqadmin = await login('hqadmin', 'admin123');
  const recNoTenant = await inj('POST', '/api/revenue/recognize?period=2035-01', hqadmin);
  ok('HQ admin recognize without tenant_id → 400 TENANT_REQUIRED', recNoTenant.status === 400 && recNoTenant.json.error?.code === 'TENANT_REQUIRED', `${recNoTenant.status} ${recNoTenant.json.error?.code}`);
  const recT1 = await inj('POST', `/api/revenue/recognize?period=2035-01&tenant_id=${t1}`, hqadmin);
  ok('HQ admin recognize tenant_id=T1 → ONLY T1 line (count 1, amount 300)', recT1.json.recognized_count === 1 && near(recT1.json.total_recognized, 300), JSON.stringify({ c: recT1.json.recognized_count, t: recT1.json.total_recognized }));
  const recT2 = await inj('POST', `/api/revenue/recognize?period=2035-01&tenant_id=${t2}`, hqadmin);
  ok('T2 line untouched by the T1 run → recognized only now (count 1, amount 400)', recT2.json.recognized_count === 1 && near(recT2.json.total_recognized, 400), JSON.stringify({ c: recT2.json.recognized_count, t: recT2.json.total_recognized }));

  // ──────────────────────────────────────────────────────────────────────────────────────────────────
  // WS3.4 — TFRS 15 / IFRS 15 revenue recognition (REV-19): contract → POs → SSP allocation → schedule →
  // recognize (release deferred revenue 2410 → revenue 4300) + refund liability (2420). Uses admin (HQ
  // tenant). Dedicated future periods so they don't collide with the DEFREV recognition above.
  ok('COA seeded with 2410 Deferred Revenue + 2420 Refund Liability', accJson.includes('2410') && accJson.includes('2420'));

  // total 1000 with SSP A=800 (over_time 4 months) + B=400 (point_in_time) → forces a real allocation+rounding
  const tbBefore = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  const rev2410Before = -Number((tbBefore.rows ?? []).find((r: any) => r.account_code === '2410')?.balance ?? 0);
  const c1 = await inj('POST', '/api/revenue/contracts', admin, {
    total_price: 1000, contract_date: '2040-01-05', description: 'TFRS15 test contract',
    obligations: [
      { name: 'Implementation (over time)', ssp: 800, method: 'over_time', start_date: '2040-01-01', end_date: '2040-04-30' },
      { name: 'License (point in time)', ssp: 400, method: 'point_in_time', start_date: '2040-01-15' },
    ],
  });
  ok('REV-19: create contract (REVC-, 2 POs, Draft)', /^REVC-/.test(c1.json.contract_no ?? '') && c1.json.obligations?.length === 2 && c1.json.status === 'Draft', `${c1.status} ${JSON.stringify(c1.json).slice(0, 80)}`);
  const cid = c1.json.id;

  // Step 4 — allocate by SSP: A=1000×800/1200=666.6667, B=1000×400/1200=333.3333; residual on largest (A)
  const alloc = await inj('POST', `/api/revenue/contracts/${cid}/allocate`, admin);
  const sumAlloc = (alloc.json.allocation ?? []).reduce((a: number, x: any) => a + x.allocated_price, 0);
  ok('REV-19: SSP allocation Σ == total_price (exact, residual handled)', near(alloc.json.sum_allocated, 1000) && near(round2(sumAlloc), 1000), JSON.stringify(alloc.json.allocation));
  const allocA = alloc.json.allocation.find((x: any) => x.name.startsWith('Implementation'))?.allocated_price;
  const allocB = alloc.json.allocation.find((x: any) => x.name.startsWith('License'))?.allocated_price;
  ok('REV-19: A≈666.67 (gets residual), B≈333.33', near(allocA, 666.6667) && near(allocB, 333.3333), `A=${allocA} B=${allocB}`);

  // activate → Dr 1100 AR 1000 / Cr 2410 1000
  const act = await inj('POST', `/api/revenue/contracts/${cid}/activate`, admin, {});
  ok('REV-19: activate → status Active, deferred 1000', act.json.status === 'Active' && near(act.json.deferred_revenue, 1000), JSON.stringify(act.json));
  const jInv = await jBy('REVREC-INV', `REVREC-INV:${c1.json.contract_no}`);
  ok('REV-19: activation GL Dr1100=1000 / Cr2410=1000', near(leg(jInv, '1100', 'debit'), 1000) && near(leg(jInv, '2410', 'credit'), 1000), JSON.stringify({ ar: leg(jInv, '1100', 'debit'), def: leg(jInv, '2410', 'credit') }));

  // buildSchedule → A has 4 monthly rows (~166.6667), B has 1 row at 2040-01
  const sch = await inj('POST', `/api/revenue/contracts/${cid}/schedule`, admin);
  const aRows = (sch.json.schedule ?? []).filter((r: any) => near(r.planned_amount, 166.6667) || (r.planned_amount > 100 && r.planned_amount < 200));
  ok('REV-19: schedule A=4 monthly rows + B=1 row (5 total)', sch.json.schedule?.length === 5 && aRows.length === 4, `rows=${sch.json.schedule?.length}`);

  // recognize period 2040-01 → one month of A (166.6667) + B point-in-time (333.3333) = 500.0000
  const r1 = await inj('POST', '/api/revenue/contracts/recognize', admin, { contract_id: cid, period: '2040-01' });
  ok('REV-19: recognize 2040-01 → 2 rows, total 500', r1.json.recognized_count === 2 && near(r1.json.total_recognized, 500), JSON.stringify({ c: r1.json.recognized_count, t: r1.json.total_recognized }));
  const tbAfter1 = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  const rev2410After = -Number((tbAfter1.rows ?? []).find((r: any) => r.account_code === '2410')?.balance ?? 0);
  const rev4300 = Number((tbAfter1.rows ?? []).find((r: any) => r.account_code === '4300')?.balance ?? 0);
  ok('REV-19: 2410 deferred decreases by 500 (1000 raised → 500 left)', near(rev2410After - rev2410Before, 500), `Δ2410=${round2(rev2410After - rev2410Before)}`);
  ok('REV-19: 4300 revenue recognized (credit balance ≥ 500)', Math.abs(rev4300) >= 499.99, `4300=${rev4300}`);

  // idempotent: recognize the SAME period again → 0 new
  const r1b = await inj('POST', '/api/revenue/contracts/recognize', admin, { contract_id: cid, period: '2040-01' });
  ok('REV-19: recognize same period again → no double post (0 new)', r1b.json.recognized_count === 0, JSON.stringify(r1b.json).slice(0, 50));

  // accrueRefundLiability rate 10% → Cr 2420 posted (base = recognized 500 → expected 50)
  const refResp = await inj('POST', `/api/revenue/contracts/${cid}/refund-liability`, admin, { expected_refund_rate: 0.10, as_of_date: '2040-01-31' });
  ok('REV-19: refund liability 10% of recognized 500 = 50', near(refResp.json.expected_refund_amount, 50) && near(refResp.json.posted_delta, 50), JSON.stringify(refResp.json));
  const jRef = await jBy('REVREC-REF', `REVREC-REF:${c1.json.contract_no}:2040-01-31`);
  ok('REV-19: refund GL Dr4300=50 (contra) / Cr2420=50', near(leg(jRef, '4300', 'debit'), 50) && near(leg(jRef, '2420', 'credit'), 50), JSON.stringify({ d: leg(jRef, '4300', 'debit'), c: leg(jRef, '2420', 'credit') }));

  const tbFinal = (await inj('GET', '/api/ledger/trial-balance', admin)).json.totals ?? {};
  ok('REV-19: trial balance still balanced after TFRS15 postings', near(tbFinal.debit ?? tbFinal.total_debit, tbFinal.credit ?? tbFinal.total_credit), JSON.stringify(tbFinal).slice(0, 60));

  await app.close();
  await pg.close();

  console.log('\n── Accounting Tier 3 — Revenue Recognition (รายได้รอตัดบัญชี) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} revrec checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} revrec checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
