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
  // Direct insert bypasses LedgerService → rebuild the gl_period_balances snapshot (R1-2; the service's
  // health check reads the trial balance, which now reads the snapshot).
  await pg.exec(`DELETE FROM gl_period_balances;
    INSERT INTO gl_period_balances (tenant_id, ledger_code, period, cost_center_code, account_code, debit, credit)
    SELECT je.tenant_id, coalesce(je.ledger_code,''), coalesce(je.period,''), coalesce(jl.cost_center_code,''), jl.account_code, coalesce(sum(jl.debit),0), coalesce(sum(jl.credit),0)
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE je.status = 'Posted'
    GROUP BY 1,2,3,4,5;`);
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
  const h = (await app.inject({ method: 'GET', url: '/api/finance/health', headers: { authorization: `Bearer ${token}` } })).json();

  // ── 1. inputs sourced from real sub-ledgers ──
  ok('cash on hand from GL = 100,000; POS run-rate ฿2,000/day', near(h.cash_on_hand, 100000) && near(h.pos_daily_run_rate, 2000), JSON.stringify({ cash: h.cash_on_hand, rate: h.pos_daily_run_rate }));

  // ── 2. AR/AP outstanding + overdue split ──
  ok('AR 40k (10k overdue → 25%), AP 180k outstanding',
    near(h.ar_outstanding, 40000) && near(h.ap_outstanding, 180000) && near(h.overdue_ar, 10000) && near(h.overdue_ar_pct, 25),
    JSON.stringify({ ar: h.ar_outstanding, ap: h.ap_outstanding, odpct: h.overdue_ar_pct }));

  // ── 3. derived ratios: days-cash-on-hand + current ratio ──
  ok('days-cash-on-hand ≈14.9 (cash ÷ daily outflow), current ratio ≈0.78',
    near(h.days_cash_on_hand, 14.9) && near(h.current_ratio, 0.78),
    JSON.stringify({ dch: h.days_cash_on_hand, cr: h.current_ratio }));

  // ── 4. working-capital health score (0–100, A–E) + transparent drivers ──
  ok('health score 45 / grade D; drivers liquidity 25 + receivables 75 (0.6/0.4 weighted)',
    h.score === 45 && h.grade === 'D' && h.drivers?.liquidity === 25 && h.drivers?.receivables === 75,
    JSON.stringify({ score: h.score, grade: h.grade, drivers: h.drivers }));

  console.log('\n── C11 — Working-capital financial-health score ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} financial-health checks failed` : `\n✅ All ${checks.length} financial-health checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
