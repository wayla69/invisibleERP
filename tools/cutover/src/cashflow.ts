/**
 * C11 — Merchant cash-flow forecast + working-capital health score. Projects the cash position week-by-week
 * from opening cash (GL) + AR collections + AP payments (by due date) + the POS run-rate, flags an upcoming
 * shortfall, and scores financial health. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover cashflow
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cf-secret';
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
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.5;
const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); // Asia/Bangkok day
const shift = (n: number) => { const t = new Date(`${today}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'T1', name: 'ร้านหนึ่ง', vatRegistered: true }]).onConflictDoNothing();
  const t1 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'T1')))[0].id);
  await db.insert(s.users).values([{ username: 'boss', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: t1 }]).onConflictDoNothing();

  // opening cash: a posted GL entry Dr 1000 Cash / Cr 3000 Equity = 100,000
  const [je] = await db.insert(s.journalEntries).values({ entryNo: 'JE-OPEN', entryDate: today, period: today.slice(0, 7), source: 'Manual', sourceRef: 'OPEN-CASH', status: 'Posted', tenantId: t1, createdBy: 'seed' }).returning({ id: s.journalEntries.id });
  await db.insert(s.journalLines).values([
    { entryId: Number(je.id), accountCode: '1000', debit: '100000', credit: '0', tenantId: t1 },
    { entryId: Number(je.id), accountCode: '3000', debit: '0', credit: '100000', tenantId: t1 },
  ]);
  // AR (inflows): 30k due in 3 days + 10k OVERDUE (5 days ago) → both collect in week 1
  await db.insert(s.arInvoices).values([
    { invoiceNo: 'INV-A', dueDate: shift(3), tenantId: t1, amount: '30000', paidAmount: '0', status: 'Unpaid' },
    { invoiceNo: 'INV-OVERDUE', dueDate: shift(-5), tenantId: t1, amount: '10000', paidAmount: '0', status: 'Unpaid' },
  ]);
  // AP (outflows): 50k due in 5 days (week 1) + a big 130k due in 10 days (week 2) → cash shortfall in week 2
  await db.insert(s.apTransactions).values([
    { txnNo: 'AP-1', tenantId: t1, vendorName: 'ซัพพลายเออร์ A', dueDate: shift(5), amount: '50000', paidAmount: '0', status: 'Unpaid' },
    { txnNo: 'AP-2', tenantId: t1, vendorName: 'ซัพพลายเออร์ B', dueDate: shift(10), amount: '130000', paidAmount: '0', status: 'Unpaid' },
  ]);
  // POS run-rate: 28 days × ฿2,000/day → posDaily 2000, ฿14,000/week immediate cash
  for (let i = 0; i < 28; i++)
    await db.insert(s.custPosSales).values({ saleNo: `S-${i}`, saleDate: shift(-i), tenantId: t1, status: 'Completed', subtotal: '2000', total: '2000', createdBy: 'pos' });

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const token = (await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'boss', password: 'pw' } })).json().token;
  const cf = (await app.inject({ method: 'GET', url: '/api/finance/cashflow?weeks=8', headers: { authorization: `Bearer ${token}` } })).json();
  const wk = (n: number) => (cf.weekly ?? []).find((w: any) => w.week === n);

  // ── 1. opening cash sourced from the GL cash accounts ──
  ok('opening cash from GL = 100,000; POS run-rate ฿2,000/day', near(cf.opening_cash, 100000) && near(cf.pos_daily_run_rate, 2000), JSON.stringify({ open: cf.opening_cash, rate: cf.pos_daily_run_rate }));

  // ── 2. week 1: AR 40k (incl. overdue) + POS 14k − AP 50k → balance 104k ──
  ok('week 1: AR 40k (incl. overdue) + POS 14k − AP 50k → projected 104k',
    near(wk(1)?.ar_inflow, 40000) && near(wk(1)?.ap_outflow, 50000) && near(wk(1)?.pos_inflow, 14000) && near(wk(1)?.projected_balance, 104000),
    JSON.stringify(wk(1)));

  // ── 3. shortfall detection: the 130k AP in week 2 drives the balance negative ──
  ok('shortfall: week 2 (130k AP) → first_shortfall_week 2, min balance −12k',
    cf.summary?.first_shortfall_week === 2 && near(cf.summary?.min_projected_balance, -12000),
    JSON.stringify({ wk: cf.summary?.first_shortfall_week, min: cf.summary?.min_projected_balance }));

  // ── 4. working-capital health score (transparent drivers) ──
  const h = cf.health ?? {};
  ok('health score: 0–100 with A–E grade, days-cash, current ratio ≈0.78, overdue AR 25%',
    typeof h.score === 'number' && h.score >= 0 && h.score <= 100 && ['A', 'B', 'C', 'D', 'E'].includes(h.grade) && typeof h.days_cash_on_hand === 'number' && near(h.current_ratio, 0.78) && near(h.overdue_ar_pct, 25),
    JSON.stringify({ score: h.score, grade: h.grade, dch: h.days_cash_on_hand, cr: h.current_ratio, odar: h.overdue_ar_pct }));

  console.log('\n── C11 — Merchant cash-flow forecast + health score ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} cash-flow checks failed` : `\n✅ All ${checks.length} cash-flow checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
