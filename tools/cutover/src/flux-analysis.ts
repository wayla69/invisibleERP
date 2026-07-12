/**
 * CLS-01 (GL-25) — Flux / variance analysis with forced explanation + sign-off, over PGlite. A SOX
 * management-review control over the period close. A preparer GENERATES a period-over-period P&L (or BS /
 * vs budget) movement analysis from gl_period_balances; each line's Δ$ / Δ% is tested against configurable
 * thresholds (absolute + %). A threshold-BREACHING line REQUIRES a written explanation before sign-off; an
 * INDEPENDENT reviewer (≠ preparer) certifies. Posts NOTHING to the GL — a read-only aggregator.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover flux-analysis
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'flux-secret';
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
    { username: 'prep', passwordHash: await pw.hash('pw'), role: 'GlAccountant', tenantId: t1 },     // preparer (gl_close granted below)
    { username: 'rev', passwordHash: await pw.hash('pw'), role: 'FinancialController', tenantId: t1 }, // independent reviewer
    { username: 'shop2', passwordHash: await pw.hash('pw'), role: 'Customer', tenantId: t2, customerName: 'T2' }, // RLS
  ]).onConflictDoNothing();
  const grantPerms = async (username: string, perms: string[]) => {
    const uid = Number((await db.select().from(s.users).where(eq(s.users.username, username)))[0].id);
    await db.insert(s.userPermissions).values(perms.map((perm) => ({ userId: uid, perm }))).onConflictDoNothing();
  };
  await grantPerms('prep', ['gl_close', 'fin_report']);
  await grantPerms('rev', ['gl_close', 'fin_report']);

  // Chart of accounts (shared master, no tenant_id). Types drive the P&L / BS basis + natural-balance sign.
  await db.insert(s.accounts).values([
    { code: '4100', name: 'Sales revenue', type: 'Revenue' },
    { code: '5100', name: 'Cost of goods sold', type: 'Expense' },
    { code: '5200', name: 'Marketing expense', type: 'Expense' },
    { code: '1100', name: 'Accounts receivable', type: 'Asset' },
    { code: '2100', name: 'Accounts payable', type: 'Liability' },
  ]).onConflictDoNothing();

  // Seed the gl_period_balances snapshot directly (the flux service reads it read-only). Signed amount by
  // natural balance: Revenue = credit − debit; Expense/Asset = debit − credit.
  const bal = (tenantId: number, period: string, accountCode: string, debit: number, credit: number) =>
    db.insert(s.glPeriodBalances).values({ tenantId, period, accountCode, debit: String(debit), credit: String(credit) });
  // Prior period 2025-05
  await bal(t1, '2025-05', '4100', 0, 100000);   // revenue 100,000
  await bal(t1, '2025-05', '5100', 60000, 0);    // COGS 60,000
  await bal(t1, '2025-05', '5200', 5000, 0);     // marketing 5,000
  // Current period 2025-06
  await bal(t1, '2025-06', '4100', 0, 130000);   // revenue 130,000 → Δ +30,000 / +30%  → BREACH
  await bal(t1, '2025-06', '5100', 61000, 0);    // COGS 61,000    → Δ +1,000 / +1.67%  → below abs threshold
  await bal(t1, '2025-06', '5200', 20000, 0);    // marketing 20,000 → Δ +15,000 / +300% → BREACH
  // Prior year 2024-06 (for the prior_year comparative)
  await bal(t1, '2024-06', '4100', 0, 90000);
  // Approved budget for 2025-06 (for the budget comparative)
  await db.insert(s.budgets).values([
    { tenantId: t1, fiscalYear: 2025, accountCode: '4100', period: '2025-06', amount: '110000', status: 'Approved', requestedBy: 'admin', approvedBy: 'boss' },
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const prep = await login('prep', 'pw');
  const rev = await login('rev', 'pw');
  const shop2 = await login('shop2', 'pw');
  const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.01;

  // ── A. Generate P&L flux vs prior_period: 3 lines, 2 breach thresholds (4100 +30k, 5200 +15k) ──
  const gen = await inj('POST', '/api/close/flux/generate', prep, { period: '2025-06', basis: 'PL', comparative: 'prior_period', threshold_abs: 10000, threshold_pct: 10 });
  const analysisId = Number(gen.json?.analysis?.id);
  const lines: any[] = gen.json?.lines ?? [];
  const line4100 = lines.find((l) => l.account_code === '4100');
  const line5100 = lines.find((l) => l.account_code === '5100');
  const line5200 = lines.find((l) => l.account_code === '5200');
  ok('Generate: Draft analysis with 3 P&L lines, comparative_period 2025-05',
    (gen.status === 200 || gen.status === 201) && gen.json?.analysis?.status === 'Draft' && lines.length === 3 && gen.json?.analysis?.comparative_period === '2025-05',
    `st=${gen.status} status=${gen.json?.analysis?.status} n=${lines.length} cmp=${gen.json?.analysis?.comparative_period}`);
  ok('Generate: Δ$ / Δ% computed correctly (4100 +30000/+30%, 5200 +15000/+300%)',
    near(line4100?.current_amt, 130000) && near(line4100?.comparative_amt, 100000) && near(line4100?.delta_amt, 30000) && near(line4100?.delta_pct, 30)
    && near(line5200?.delta_amt, 15000) && near(line5200?.delta_pct, 300),
    `4100 Δ=${line4100?.delta_amt}/${line4100?.delta_pct}% 5200 Δ=${line5200?.delta_amt}/${line5200?.delta_pct}%`);
  ok('Generate: threshold breach flags — 4100 & 5200 breached, 5100 (Δ 1000 < abs 10000) not breached',
    line4100?.breached === true && line5200?.breached === true && line5100?.breached === false && gen.json?.analysis?.breached_count === 2,
    `4100=${line4100?.breached} 5100=${line5100?.breached} 5200=${line5200?.breached} count=${gen.json?.analysis?.breached_count}`);

  // ── B. Review blocked while a breached line is unexplained → UNEXPLAINED_LINES ──
  const revEarly = await inj('POST', `/api/close/flux/${analysisId}/review`, rev);
  ok('Review blocked while breached lines unexplained → 400 UNEXPLAINED_LINES', revEarly.status === 400 && revEarly.json?.error?.code === 'UNEXPLAINED_LINES', `st=${revEarly.status} code=${revEarly.json?.error?.code}`);

  // ── C. Explaining a NON-breached line is rejected ──
  const explainNb = await inj('PUT', `/api/close/flux/${analysisId}/lines/${line5100?.id}/explain`, prep, { explanation: 'no' });
  ok('Explain a non-breached line rejected → 400 LINE_NOT_BREACHED', explainNb.status === 400 && explainNb.json?.error?.code === 'LINE_NOT_BREACHED', `st=${explainNb.status} code=${explainNb.json?.error?.code}`);

  // ── D. Explain first breached line → still Draft (1 of 2); review still blocked ──
  const ex1 = await inj('PUT', `/api/close/flux/${analysisId}/lines/${line4100?.id}/explain`, prep, { explanation: 'New enterprise contract signed in June lifted sales.' });
  ok('Explain 1 of 2 breached → status stays Draft (explained_count 1)', ex1.status === 200 && ex1.json?.analysis?.status === 'Draft' && ex1.json?.analysis?.explained_count === 1, `status=${ex1.json?.analysis?.status} explained=${ex1.json?.analysis?.explained_count}`);
  const revMid = await inj('POST', `/api/close/flux/${analysisId}/review`, rev);
  ok('Review still blocked with 1 line unexplained → UNEXPLAINED_LINES', revMid.status === 400 && revMid.json?.error?.code === 'UNEXPLAINED_LINES', `st=${revMid.status} code=${revMid.json?.error?.code}`);

  // ── E. Explain second breached line → status advances to Explained ──
  const ex2 = await inj('PUT', `/api/close/flux/${analysisId}/lines/${line5200?.id}/explain`, prep, { explanation: 'Q2 brand campaign; approved incremental marketing spend.' });
  ok('Explain all breached lines → status advances to Explained (explained_count 2)', ex2.status === 200 && ex2.json?.analysis?.status === 'Explained' && ex2.json?.analysis?.explained_count === 2, `status=${ex2.json?.analysis?.status} explained=${ex2.json?.analysis?.explained_count}`);

  // ── F. Self-review blocked (maker-checker): preparer cannot sign off ──
  const selfReview = await inj('POST', `/api/close/flux/${analysisId}/review`, prep);
  ok('Self-review rejected → 403 SOD_SELF_APPROVAL', selfReview.status === 403 && selfReview.json?.error?.code === 'SOD_SELF_APPROVAL', `st=${selfReview.status} code=${selfReview.json?.error?.code}`);

  // ── G. Independent reviewer certifies ──
  const certify = await inj('POST', `/api/close/flux/${analysisId}/review`, rev, { note: 'Explanations reasonable; consistent with pipeline & campaign approvals.' });
  ok('Independent reviewer certifies → status Certified, reviewed_by=rev', certify.status === 200 && certify.json?.analysis?.status === 'Certified' && certify.json?.analysis?.reviewed_by === 'rev', `status=${certify.json?.analysis?.status} by=${certify.json?.analysis?.reviewed_by}`);

  // ── H. Post-certification is locked: further explanation rejected ──
  const exLocked = await inj('PUT', `/api/close/flux/${analysisId}/lines/${line5200?.id}/explain`, prep, { explanation: 'change' });
  ok('Explain after certification rejected → 400 ALREADY_CERTIFIED', exLocked.status === 400 && exLocked.json?.error?.code === 'ALREADY_CERTIFIED', `st=${exLocked.status} code=${exLocked.json?.error?.code}`);
  const reCert = await inj('POST', `/api/close/flux/${analysisId}/review`, rev);
  ok('Re-certify a Certified analysis rejected → 400 ALREADY_CERTIFIED', reCert.status === 400 && reCert.json?.error?.code === 'ALREADY_CERTIFIED', `st=${reCert.status} code=${reCert.json?.error?.code}`);

  // ── I. prior_year comparative (2024-06): 4100 130000 vs 90000 → Δ +40000 / +44% breach ──
  const genPY = await inj('POST', '/api/close/flux/generate', prep, { period: '2025-06', basis: 'PL', comparative: 'prior_year' });
  const py4100 = (genPY.json?.lines ?? []).find((l: any) => l.account_code === '4100');
  ok('prior_year comparative resolves to 2024-06 and flags 4100 (+40000)', genPY.json?.analysis?.comparative_period === '2024-06' && near(py4100?.comparative_amt, 90000) && near(py4100?.delta_amt, 40000) && py4100?.breached === true, `cmp=${genPY.json?.analysis?.comparative_period} Δ=${py4100?.delta_amt} breach=${py4100?.breached}`);

  // ── J. budget comparative (P&L only): 4100 130000 vs approved budget 110000 → Δ +20000 breach ──
  const genBud = await inj('POST', '/api/close/flux/generate', prep, { period: '2025-06', basis: 'PL', comparative: 'budget' });
  const bud4100 = (genBud.json?.lines ?? []).find((l: any) => l.account_code === '4100');
  ok('budget comparative uses approved budget (4100 vs 110000 → Δ +20000 breach)', genBud.json?.analysis?.comparative_period === 'budget' && near(bud4100?.comparative_amt, 110000) && near(bud4100?.delta_amt, 20000) && bud4100?.breached === true, `cmp=${genBud.json?.analysis?.comparative_period} Δ=${bud4100?.delta_amt}`);
  const budBs = await inj('POST', '/api/close/flux/generate', prep, { period: '2025-06', basis: 'BS', comparative: 'budget' });
  ok('budget comparative on BS basis rejected → 400 BUDGET_PL_ONLY', budBs.status === 400 && budBs.json?.error?.code === 'BUDGET_PL_ONLY', `st=${budBs.status} code=${budBs.json?.error?.code}`);

  // ── K. BS basis only includes balance-sheet accounts (cumulative through period) ──
  await bal(t1, '2025-06', '1100', 25000, 0);   // AR 25,000 (Asset)
  const genBs = await inj('POST', '/api/close/flux/generate', prep, { period: '2025-06', basis: 'BS', comparative: 'prior_period' });
  const bsCodes = (genBs.json?.lines ?? []).map((l: any) => l.account_code);
  ok('BS basis includes only balance-sheet accounts (1100 present, 4100/5100 absent)', bsCodes.includes('1100') && !bsCodes.includes('4100') && !bsCodes.includes('5100'), `codes=${JSON.stringify(bsCodes)}`);

  // ── L. RLS: T2 sees none of T1's flux analyses ──
  const t2list = await inj('GET', '/api/close/flux', shop2);
  ok('RLS: T2 sees none of T1 flux analyses', t2list.status === 403 || (t2list.json?.analyses ?? []).length === 0, `st=${t2list.status} n=${(t2list.json?.analyses ?? []).length}`);

  // ── M. Bad period is rejected ──
  const badPeriod = await inj('POST', '/api/close/flux/generate', prep, { period: '2025/06' });
  ok('Bad period rejected → 400', badPeriod.status === 400, `st=${badPeriod.status}`);

  console.log('\n── CLS-01 (GL-25) — Flux / variance analysis with forced explanation + sign-off ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} flux-analysis checks failed` : `\n✅ All ${checks.length} flux-analysis checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
