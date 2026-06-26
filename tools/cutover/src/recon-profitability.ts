/**
 * Phase 20 Batch 1C — Account Reconciliation + CO-PA Profitability over PGlite.
 * GL-vs-subledger auto-match, SoD certification, segment allocation, contribution margin.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover recon-profitability
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'recon-secret';
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

  await db.insert(s.permissions).values(PERMISSIONS.map((k: string) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'T1' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1] = [await tid('HQ'), await tid('T1')];
  await db.insert(s.users).values([
    { username: 'admin',   passwordHash: await pw.hash('admin123'), role: 'Admin',   tenantId: hq },
    { username: 'preparer', passwordHash: await pw.hash('pw1'),     role: 'Planner', tenantId: t1 },
    { username: 'reviewer', passwordHash: await pw.hash('pw2'),     role: 'Planner', tenantId: t1 },
  ]).onConflictDoNothing();
  // Planner role is now SoD-clean; preparer/reviewer keep the old bundled perms (exec + approvals)
  // via per-user override. The SoD certify test (preparer cannot certify own work) is user-ID-based
  // in business logic — not perm-based — so giving preparer 'approvals' does not break that test.
  for (const un of ['preparer', 'reviewer']) {
    const uid = Number((await db.select().from(s.users).where(eq(s.users.username, un)))[0].id);
    await db.insert(s.userPermissions).values(
      ['dashboard', 'exec', 'warehouse', 'procurement', 'planner', 'masterdata', 'approvals'].map((perm) => ({ userId: uid, perm })),
    ).onConflictDoNothing();
  }

  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ maxParamLength: 500 }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();

  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /**/ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const [admin, prep, rev] = [await login('admin', 'admin123'), await login('preparer', 'pw1'), await login('reviewer', 'pw2')];

  // ── Seed GL for T1: account 1000, period 2026-01, two lines: +1200 and +800 ──
  await db.insert(s.journalEntries).values({ entryNo: 'JE-R001', entryDate: '2026-01-05', period: '2026-01', memo: 'deposit 1', source: 'Manual', tenantId: t1, status: 'Posted' }).onConflictDoNothing();
  await db.insert(s.journalEntries).values({ entryNo: 'JE-R002', entryDate: '2026-01-15', period: '2026-01', memo: 'deposit 2', source: 'Manual', tenantId: t1, status: 'Posted' }).onConflictDoNothing();
  const [je1] = await db.select().from(s.journalEntries).where(eq(s.journalEntries.entryNo, 'JE-R001'));
  const [je2] = await db.select().from(s.journalEntries).where(eq(s.journalEntries.entryNo, 'JE-R002'));
  await db.insert(s.journalLines).values([
    { entryId: Number(je1.id), accountCode: '1000', debit: '1200', credit: '0', tenantId: t1 },
    { entryId: Number(je1.id), accountCode: '4000', debit: '0',    credit: '1200', tenantId: t1 },
    { entryId: Number(je2.id), accountCode: '1000', debit: '800',  credit: '0', tenantId: t1 },
    { entryId: Number(je2.id), accountCode: '4000', debit: '0',    credit: '800', tenantId: t1 },
  ]).onConflictDoNothing();

  // ── RECONCILIATION CHECKS ──

  // 1. Open recon period for account 1000, period 2026-01
  const open = await inj('POST', '/api/recon/periods', prep, { account_code: '1000', period: '2026-01' });
  ok('Open recon period → status Open', open.status === 201 && open.json.status === 'Open', JSON.stringify(open.json));
  const rpId = open.json.id;

  // 2. Import GL items → 2 items
  const imp = await inj('POST', `/api/recon/periods/${rpId}/import-gl`, prep);
  ok('Import GL items → 2 items, gl_balance=2000', imp.status === 200 && imp.json.imported === 2 && near(imp.json.gl_balance, 2000), JSON.stringify(imp.json));

  // 3. Add subledger item matching first GL line (1200)
  const sb1 = await inj('POST', `/api/recon/periods/${rpId}/items`, prep, { source: 'Subledger', amount: 1200, ref_doc: 'BANK-001' });
  ok('Add subledger item 1200', sb1.status === 201 && near(sb1.json.amount, 1200), JSON.stringify(sb1.json));

  // 4. Auto-match → 1 pair matched
  const match = await inj('POST', `/api/recon/periods/${rpId}/auto-match`, prep);
  ok('Auto-match → 1 pair, 1 unmatched GL remain', match.status === 200 && match.json.matched_pairs === 1 && match.json.unmatched_gl === 1, JSON.stringify(match.json));

  // 5. Period summary shows 1 unmatched GL
  const summ = await inj('GET', `/api/recon/periods/${rpId}/summary`, prep);
  ok('Period summary: 1 unmatched GL', summ.json.items?.unmatched_gl === 1, JSON.stringify(summ.json));

  // 6. Add remaining subledger item (800) and re-match
  await inj('POST', `/api/recon/periods/${rpId}/items`, prep, { source: 'Subledger', amount: 800, ref_doc: 'BANK-002' });
  const match2 = await inj('POST', `/api/recon/periods/${rpId}/auto-match`, prep);
  ok('Second auto-match → 0 unmatched GL, status=Reconciled', match2.json.unmatched_gl === 0 && match2.json.matched_pairs === 1, JSON.stringify(match2.json));

  // 7. Verify period status is now Reconciled
  const summ2 = await inj('GET', `/api/recon/periods/${rpId}/summary`, prep);
  ok('Period status = Reconciled after full match', summ2.json.status === 'Reconciled', `status=${summ2.json.status}`);

  // 8. SoD violation: preparer cannot certify their own work
  const selfCert = await inj('POST', `/api/recon/periods/${rpId}/certify`, prep);
  ok('Preparer cannot certify own work (SoD → 403)', selfCert.status === 403, `status=${selfCert.status}`);

  // 9. Reviewer can certify
  const cert = await inj('POST', `/api/recon/periods/${rpId}/certify`, rev);
  ok('Reviewer certifies → status Certified', cert.status === 200 && cert.json.status === 'Certified', JSON.stringify(cert.json));

  // 10. Cannot certify twice
  const cert2 = await inj('POST', `/api/recon/periods/${rpId}/certify`, rev);
  ok('Double-certify → 400', cert2.status === 400, `status=${cert2.status}`);

  // ── PROFITABILITY CHECKS ──

  // 11. Create two Brand segments
  const segA = await inj('POST', '/api/profitability/segments', prep, { segment_type: 'Brand', code: 'THAI', name: 'Thai Cuisine' });
  const segB = await inj('POST', '/api/profitability/segments', prep, { segment_type: 'Brand', code: 'INTL', name: 'International' });
  ok('Create segments A + B', segA.status === 201 && segB.status === 201, `A=${segA.json.id} B=${segB.json.id}`);

  // 12. Create allocation rule: expense 5100 → Brand, equal split
  const rule = await inj('POST', '/api/profitability/rules', prep, { name: 'COGS to Brand', from_account_code: '5100', to_segment_type: 'Brand', driver: 'equal' });
  ok('Create allocation rule', rule.status === 201 && rule.json.driver === 'equal', JSON.stringify(rule.json));

  // 13. Seed 5100 GL for T1 (expense 3000) — needed for allocation
  await db.insert(s.journalEntries).values({ entryNo: 'JE-EXP-001', entryDate: '2026-01-20', period: '2026-01', memo: 'Jan COGS', source: 'Manual', tenantId: t1, status: 'Posted' }).onConflictDoNothing();
  const [jeExp] = await db.select().from(s.journalEntries).where(eq(s.journalEntries.entryNo, 'JE-EXP-001'));
  await db.insert(s.journalLines).values([
    { entryId: Number(jeExp.id), accountCode: '5100', debit: '3000', credit: '0', tenantId: t1 },
    { entryId: Number(jeExp.id), accountCode: '2000', debit: '0', credit: '3000', tenantId: t1 },
  ]).onConflictDoNothing();

  // Use preparer (Finance role, T1) for allocation — needs exec permission
  const allocToken = await login('admin', 'admin123');
  // Admin is HQ-scoped; for T1 allocation we use prep token (Finance @ T1)
  const alloc = await inj('POST', '/api/profitability/run', prep, { period: '2026-01' });
  ok('Run allocation → lines created', alloc.status === 200 && alloc.json.lines_created === 2, JSON.stringify(alloc.json));

  // 14. Profitability report: each segment gets 1500 allocated cost (3000 / 2 equal)
  const report = await inj('GET', '/api/profitability/report?period=2026-01&segment_type=Brand', prep);
  ok('Profitability report → 2 segments with 1500 each', report.json.segments?.length === 2 && report.json.segments.every((s: any) => near(s.allocated_costs, 1500)), JSON.stringify(report.json));

  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => {
  const pass = checks.filter((c) => c.ok).length;
  const fail = checks.filter((c) => !c.ok).length;
  console.log(`\n${'─'.repeat(60)}`);
  for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  console.log(`${'─'.repeat(60)}\n${pass}/${checks.length} passed${fail ? ` (${fail} failed)` : ' 🎉'}`);
  if (fail) process.exit(1);
});
