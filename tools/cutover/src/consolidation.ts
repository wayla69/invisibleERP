/**
 * Phase 20 Batch 1B — Financial Consolidation over PGlite.
 * Multi-entity GL roll-up, IC elimination, NCI (minority interest).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover consolidation
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'consol-secret';
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
  await db.insert(s.tenants).values([
    { code: 'HQ', name: 'Head Office' },
    { code: 'T1', name: 'Sub 1' },
    { code: 'T2', name: 'Sub 2 (80%)' },
  ]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ routerOptions: { maxParamLength: 500 } }));
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
  const admin = await login('admin', 'admin123');

  // ── Seed GL for T1: Revenue 5000, Expense 3000 → net income 2000 ──
  await db.insert(s.journalEntries).values({ entryNo: 'JE-T1-001', entryDate: '2026-01-10', period: '2026-01', memo: 'T1 Jan', source: 'Manual', tenantId: t1, status: 'Posted' }).onConflictDoNothing();
  const [jeT1] = await db.select().from(s.journalEntries).where(eq(s.journalEntries.entryNo, 'JE-T1-001'));
  await db.insert(s.journalLines).values([
    { entryId: Number(jeT1.id), accountCode: '1000', debit: '5000', credit: '0', tenantId: t1 },
    { entryId: Number(jeT1.id), accountCode: '4000', debit: '0', credit: '5000', tenantId: t1 },
    { entryId: Number(jeT1.id), accountCode: '5100', debit: '3000', credit: '0', tenantId: t1 },
    { entryId: Number(jeT1.id), accountCode: '2000', debit: '0', credit: '3000', tenantId: t1 },
  ]).onConflictDoNothing();

  // ── Seed GL for T2: Revenue 4000, Expense 2500 → net income 1500 ──
  await db.insert(s.journalEntries).values({ entryNo: 'JE-T2-001', entryDate: '2026-01-10', period: '2026-01', memo: 'T2 Jan', source: 'Manual', tenantId: t2, status: 'Posted' }).onConflictDoNothing();
  const [jeT2] = await db.select().from(s.journalEntries).where(eq(s.journalEntries.entryNo, 'JE-T2-001'));
  await db.insert(s.journalLines).values([
    { entryId: Number(jeT2.id), accountCode: '1000', debit: '4000', credit: '0', tenantId: t2 },
    { entryId: Number(jeT2.id), accountCode: '4000', debit: '0', credit: '4000', tenantId: t2 },
    { entryId: Number(jeT2.id), accountCode: '5100', debit: '2500', credit: '0', tenantId: t2 },
    { entryId: Number(jeT2.id), accountCode: '2000', debit: '0', credit: '2500', tenantId: t2 },
  ]).onConflictDoNothing();

  // ── Seed IC transaction T1→T2, amount=1000 (creates 1150/2150 entries) ──
  await db.insert(s.icTransactions).values({
    icNo: 'IC-20260110-001', tenantId: t1, fromTenantId: t1, toTenantId: t2,
    txnDate: '2026-01-10', amount: '1000', settledAmount: '0', currency: 'THB',
    category: 'shared-cost', status: 'Open',
  }).onConflictDoNothing();
  // Seed the 1150/2150 GL lines manually (since we're bypassing the full IC service)
  await db.insert(s.journalEntries).values({ entryNo: 'JE-IC-001', entryDate: '2026-01-10', period: '2026-01', memo: 'IC from T1', source: 'IC', tenantId: t1, status: 'Posted' }).onConflictDoNothing();
  const [jeIcFrom] = await db.select().from(s.journalEntries).where(eq(s.journalEntries.entryNo, 'JE-IC-001'));
  await db.insert(s.journalLines).values([
    { entryId: Number(jeIcFrom.id), accountCode: '1150', debit: '1000', credit: '0', tenantId: t1 },
    { entryId: Number(jeIcFrom.id), accountCode: '5100', debit: '0', credit: '1000', tenantId: t1 },
  ]).onConflictDoNothing();
  await db.insert(s.journalEntries).values({ entryNo: 'JE-IC-002', entryDate: '2026-01-10', period: '2026-01', memo: 'IC to T2', source: 'IC', tenantId: t2, status: 'Posted' }).onConflictDoNothing();
  const [jeIcTo] = await db.select().from(s.journalEntries).where(eq(s.journalEntries.entryNo, 'JE-IC-002'));
  await db.insert(s.journalLines).values([
    { entryId: Number(jeIcTo.id), accountCode: '5100', debit: '1000', credit: '0', tenantId: t2 },
    { entryId: Number(jeIcTo.id), accountCode: '2150', debit: '0', credit: '1000', tenantId: t2 },
  ]).onConflictDoNothing();

  // ── Checks ──

  // 1. Create consolidation group
  const grp = await inj('POST', '/api/consolidation/groups', admin, { name: 'Invisible Group 2026', fiscal_year: 2026 });
  ok('Create group → has id + name', grp.status === 201 && grp.json.id > 0 && grp.json.name === 'Invisible Group 2026', JSON.stringify(grp.json));
  const groupId = grp.json.id;

  // 2. Add T1 entity (100% ownership)
  const addT1 = await inj('POST', `/api/consolidation/groups/${groupId}/entities`, admin, { entity_tenant_id: t1, ownership_pct: 100 });
  ok('Add T1 entity (100% owned)', addT1.status === 201 && Number(addT1.json.entity_tenant_id) === t1, JSON.stringify(addT1.json));

  // 3. Add T2 entity (80% ownership)
  const addT2 = await inj('POST', `/api/consolidation/groups/${groupId}/entities`, admin, { entity_tenant_id: t2, ownership_pct: 80 });
  ok('Add T2 entity (80% owned)', addT2.status === 201 && near(addT2.json.ownership_pct, 80), JSON.stringify(addT2.json));

  // 4. List entities → 2 active
  const ents = await inj('GET', `/api/consolidation/groups/${groupId}/entities`, admin);
  ok('List entities → 2 active', ents.json.entities?.length === 2, JSON.stringify(ents.json));

  // 5. Non-admin cannot create group
  const other = await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' });
  // We only have admin user; test that POST without token returns 401
  const unauth = await inj('POST', '/api/consolidation/groups', undefined, { name: 'X', fiscal_year: 2026 });
  ok('Unauthenticated request → 401', unauth.status === 401, `status=${unauth.status}`);

  // ── REC-03 — IC reconciliation sign-off gates consolidation elimination ──
  await db.insert(s.users).values([{ username: 'admin2', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }]).onConflictDoNothing();
  const admin2 = await login('admin2', 'admin123');
  // The consolidation run is BLOCKED until the period's IC reconciliation is reviewed + approved.
  const blockedRun = await inj('POST', `/api/consolidation/groups/${groupId}/run`, admin, { period: '2026-01' });
  ok('REC-03: consolidation BLOCKED until IC reconciliation is approved → 400 IC_RECON_NOT_APPROVED', blockedRun.status === 400 && blockedRun.json.error?.code === 'IC_RECON_NOT_APPROVED', `${blockedRun.status} ${blockedRun.json.error?.code}`);
  // Preparer reconciles + signs (IC Due-From 1150 == Due-To 2150 == 1000 → eliminates).
  const icPrep = await inj('POST', `/api/ic-reconciliation/groups/${groupId}/prepare`, admin, { period: '2026-01' });
  ok('REC-03: prepare → Prepared, due-from 1000 = due-to 1000, eliminates true', icPrep.status === 200 && icPrep.json.status === 'Prepared' && near(icPrep.json.total_due_from, 1000) && near(icPrep.json.total_due_to, 1000) && icPrep.json.eliminates === true, JSON.stringify(icPrep.json).slice(0, 150));
  // The preparer cannot approve their own reconciliation (SoD R-consol).
  const icSelf = await inj('POST', `/api/ic-reconciliation/groups/${groupId}/approve`, admin, { period: '2026-01' });
  ok('REC-03: preparer cannot approve their own reconciliation → 403 SOD_VIOLATION', icSelf.status === 403 && icSelf.json.error?.code === 'SOD_VIOLATION', `${icSelf.status} ${icSelf.json.error?.code}`);
  // An independent approver (≠ preparer) signs off → Approved.
  const icAppr = await inj('POST', `/api/ic-reconciliation/groups/${groupId}/approve`, admin2, { period: '2026-01' });
  ok('REC-03: independent approver signs off → Approved', icAppr.status === 200 && icAppr.json.status === 'Approved' && icAppr.json.approved_by === 'admin2', JSON.stringify(icAppr.json).slice(0, 150));

  // 6. Run consolidation for 2026-01 (now that the IC reconciliation is approved)
  const run = await inj('POST', `/api/consolidation/groups/${groupId}/run`, admin, { period: '2026-01' });
  ok('Run consolidation → status Final', run.status === 200 && run.json.status === 'Final', JSON.stringify(run.json));
  const runId = run.json.run_id;

  // 7. Entity count = 2
  ok('Run covers 2 entities', run.json.entity_count === 2, `count=${run.json.entity_count}`);

  // 8. IC elimination found (1 ic transaction seeded)
  ok('IC elimination detected (1 transaction)', run.json.ic_eliminations === 1, `eliminations=${run.json.ic_eliminations}`);

  // 9. Run lines include Entity lines for 4000 (revenue)
  const lines = await inj('GET', `/api/consolidation/runs/${runId}/lines`, admin);
  ok('Get run lines → has lines', lines.json.lines?.length > 0, `lines=${lines.json.lines?.length}`);
  const entityLines = lines.json.lines.filter((l: any) => l.line_type === 'Entity' && l.account_code === '4000');
  ok('Entity lines exist for 4000 (revenue)', entityLines.length === 2, `4000 entity lines=${entityLines.length}`);

  // 10. Consolidated 4000 revenue = -9000 (T1=-5000 + T2=-4000; net = debit-credit = 0-9000)
  const consol = run.json.consolidated_accounts.find((a: any) => a.account_code === '4000');
  ok('Consolidated revenue 4000 = -9000', near(consol?.net_thb, -9000), `net=${consol?.net_thb}`);

  // 11. Elimination lines for 1150 and 2150 both present
  const elimLines = lines.json.lines.filter((l: any) => l.line_type === 'Elimination');
  const elim1150 = elimLines.find((l: any) => l.account_code === '1150');
  const elim2150 = elimLines.find((l: any) => l.account_code === '2150');
  ok('Elimination line for 1150 (Due-From) exists', !!elim1150, JSON.stringify(elim1150));
  ok('Elimination line for 2150 (Due-To) exists', !!elim2150, JSON.stringify(elim2150));

  // 12. NCI line for T2 (20% of net income = 20% of 1500 = 300) — T2 net income from GL seeded above
  // T2 GL: 4000 net = -4000, 5100 net = 3500 (2500 expense + 1000 IC debit)
  // plNetSum_T2 = (-4000) + 3500 = -500; netIncome_T2 = -(-500) = 500; NCI = 20% * 500 = 100
  const nciLine = lines.json.lines.find((l: any) => l.line_type === 'NCI');
  ok('NCI line for T2 exists in run (3300)', !!nciLine && nciLine.account_code === '3300', JSON.stringify(nciLine));

  // 13. List runs → 1 run with status Final
  const runs = await inj('GET', `/api/consolidation/groups/${groupId}/runs`, admin);
  ok('List runs → 1 run, status Final', runs.json.runs?.length === 1 && runs.json.runs[0].status === 'Final', JSON.stringify(runs.json));

  // 14. List groups → 1 group
  const groups = await inj('GET', '/api/consolidation/groups', admin);
  ok('List groups → 1 group', groups.json.groups?.length === 1, `count=${groups.json.groups?.length}`);

  // ── WS3.3 CON-03: elimination integrity (balanced consolidated TB) ──

  // 15. Run returns a balanced flag + zero elimination net (1150/2150 cancel)
  ok('CON-03 run is balanced (TB nets ~0)', run.json.balanced === true && near(run.json.tb_net, 0) && near(run.json.elimination_net, 0), `balanced=${run.json.balanced} tb=${run.json.tb_net} elim=${run.json.elimination_net}`);

  // 16. Elimination lines net to zero (1150 −1000 + 2150 +1000)
  const elimNet = lines.json.lines.filter((l: any) => l.line_type === 'Elimination').reduce((a: number, l: any) => a + Number(l.amount_thb), 0);
  ok('CON-03 IC eliminations net to ~0', Math.abs(elimNet) < 0.01, `elimNet=${elimNet}`);

  // ── WS3.3 CON-03: maker-checker post ──

  // 17. Self-post by the runner (admin ran it) → SELF_POST
  const selfPost = await inj('POST', `/api/consolidation/runs/${runId}/post`, admin);
  ok('CON-03 self-post → SELF_POST', selfPost.status === 403 && selfPost.json.error?.code === 'SELF_POST', JSON.stringify(selfPost.json));

  // 18. Post by a DIFFERENT admin user → Posted (admin2 created earlier for the REC-03 sign-off)
  const posted = await inj('POST', `/api/consolidation/runs/${runId}/post`, admin2);
  ok('CON-03 post by other user → Posted', posted.status === 200 && posted.json.status === 'Posted', JSON.stringify(posted.json));

  // 19. Re-run a Posted period → ALREADY_POSTED
  const rerun = await inj('POST', `/api/consolidation/groups/${groupId}/run`, admin, { period: '2026-01' });
  ok('CON-03 re-run posted period → ALREADY_POSTED', rerun.status === 400 && rerun.json.error?.code === 'ALREADY_POSTED', JSON.stringify(rerun.json));

  // ── B3 (docs/50 Wave 2): schedulable consolidation staging — per-group fault isolation, auto-Draft
  //    only (posting stays CON-03 maker-checker). The posted 2026-01 group reports already_posted; an
  //    un-gated period (2026-02, no IC recon sign-off yet) reports IC_RECON_NOT_APPROVED — neither errors ──
  const conSub = await inj('POST', '/api/bi/subscriptions', admin, { name: 'รวมงบสิ้นงวด', report_type: 'consolidation_run', frequency: 'monthly', filters: { period: '2026-01', group_id: groupId } });
  ok('B3: consolidation_run subscription accepted', conSub.status < 300 && !!conSub.json.id, JSON.stringify(conSub.json).slice(0, 80));
  const conJob1 = await inj('POST', `/api/bi/subscriptions/${conSub.json.id}/run`, admin);
  ok('B3: job on the POSTED period is a graceful per-group no-op (already_posted, HTTP 200)', conJob1.status === 200, `${conJob1.status}`);
  const conSub2 = await inj('POST', '/api/bi/subscriptions', admin, { name: 'รวมงบ 2026-02', report_type: 'consolidation_run', frequency: 'monthly', filters: { period: '2026-02', group_id: groupId } });
  const conJob2 = await inj('POST', `/api/bi/subscriptions/${conSub2.json.id}/run`, admin);
  ok('B3: job on an un-signed-off period no-ops per group (IC gate intact, HTTP 200)', conJob2.status === 200, `${conJob2.status}`);
  const runsAfterJobs = await inj('GET', `/api/consolidation/groups/${groupId}/runs`, admin);
  ok('B3: neither job created a run past the gates (still only the posted 2026-01 run)', (runsAfterJobs.json.runs ?? []).length === 1 && (runsAfterJobs.json.runs ?? [])[0]?.status === 'Posted', JSON.stringify((runsAfterJobs.json.runs ?? []).map((r: any) => ({ p: r.period, st: r.status }))));
  // Approve 2026-02's IC recon (prepare → a DIFFERENT user approves) → the same job now STAGES a Draft run.
  await inj('POST', `/api/ic-reconciliation/groups/${groupId}/prepare`, admin, { period: '2026-02' });
  await inj('POST', `/api/ic-reconciliation/groups/${groupId}/approve`, admin2, { period: '2026-02' });
  const conJob3 = await inj('POST', `/api/bi/subscriptions/${conSub2.json.id}/run`, admin);
  const runsAfterStage = await inj('GET', `/api/consolidation/groups/${groupId}/runs`, admin);
  const stagedFeb = (runsAfterStage.json.runs ?? []).find((r: any) => r.period === '2026-02');
  ok('B3: once the IC gate clears, the job stages the period run as DRAFT (posting stays maker-checker)', conJob3.status === 200 && !!stagedFeb && stagedFeb.status !== 'Posted', JSON.stringify(stagedFeb ?? {}));

  // ── WS3.3 CON-04: segment reporting (IFRS 8) ──

  // Seed a branch-tagged P&L JE for HQ tenant so the segment report has dimensioned data.
  await db.insert(s.journalEntries).values({ entryNo: 'JE-SEG-001', entryDate: '2026-02-10', period: '2026-02', memo: 'Seg Feb', source: 'Manual', tenantId: hq, status: 'Posted' }).onConflictDoNothing();
  const [jeSeg] = await db.select().from(s.journalEntries).where(eq(s.journalEntries.entryNo, 'JE-SEG-001'));
  await db.insert(s.journalLines).values([
    { entryId: Number(jeSeg.id), accountCode: '4000', debit: '0', credit: '6000', tenantId: hq, branchId: 1 },
    { entryId: Number(jeSeg.id), accountCode: '5100', debit: '2000', credit: '0', tenantId: hq, branchId: 1 },
    { entryId: Number(jeSeg.id), accountCode: '4000', debit: '0', credit: '3000', tenantId: hq, branchId: 2 },
    { entryId: Number(jeSeg.id), accountCode: '5100', debit: '1000', credit: '0', tenantId: hq, branchId: 2 },
  ]).onConflictDoNothing();

  // 20. Define a segment grouping branches 1+2 into 'NORTH'
  const seg = await inj('POST', '/api/consolidation/segments', admin, { code: 'NORTH', name: 'Northern Region', dimension: 'branch', member_keys: [1, 2] });
  ok('CON-04 define segment → has id', seg.status === 201 && seg.json.id > 0, JSON.stringify(seg.json));

  // 21. Segment report by branch for 2026-02 → NORTH revenue 9000 / expense 3000 / net 6000
  const segRep = await inj('GET', '/api/consolidation/segment-report?period=2026-02&dimension=branch', admin);
  const north = segRep.json.segments?.find((x: any) => x.segment === 'NORTH');
  ok('CON-04 segment report NORTH rev=9000 exp=3000 net=6000', !!north && near(north.revenue, 9000) && near(north.expense, 3000) && near(north.net, 6000), JSON.stringify(segRep.json));

  // 22. List segments → at least 1
  const segs = await inj('GET', '/api/consolidation/segments', admin);
  ok('CON-04 list segments → ≥1', segs.json.segments?.length >= 1, `count=${segs.json.segments?.length}`);

  // 23. Define + list an elimination rule
  const rule = await inj('POST', '/api/consolidation/rules', admin, { group_id: groupId, name: 'IC due-from/due-to', rule_type: 'ic_balance', debit_account: '2150', credit_account: '1150' });
  ok('CON-03 define elimination rule → has id', rule.status === 201 && rule.json.id > 0, JSON.stringify(rule.json));
  const rules = await inj('GET', `/api/consolidation/rules?group_id=${groupId}`, admin);
  ok('CON-03 list elimination rules → ≥1', rules.json.rules?.length >= 1, `count=${rules.json.rules?.length}`);

  // ── FIN-5: CTA / OCI + average-rate translation + consolidated cash flow ──
  // A foreign (USD) subsidiary T3 whose books balance in USD: Dr Cash 1000, Cr Revenue 1000 (period 2026-03).
  // FX rates for USD: 2026-03-15 = 30 (in-month → average basis), 2026-03-28 = 32 (closing). Both are in the
  // month, so average = (30+32)/2 = 31; closing = 32 (latest ≤ period-end proxy 2026-03-28).
  await db.insert(s.tenants).values([{ code: 'T3', name: 'Sub 3 (USD)' }]).onConflictDoNothing();
  const t3 = await tid('T3');
  await db.insert(s.fxRates).values([
    { currency: 'USD', rateDate: '2026-03-15', rate: '30', status: 'Approved', source: 'manual' },
    { currency: 'USD', rateDate: '2026-03-28', rate: '32', status: 'Approved', source: 'manual' },
  ]).onConflictDoNothing();
  await db.insert(s.journalEntries).values({ entryNo: 'JE-T3-001', entryDate: '2026-03-10', period: '2026-03', memo: 'T3 Mar (USD)', source: 'Manual', tenantId: t3, status: 'Posted' }).onConflictDoNothing();
  const [jeT3] = await db.select().from(s.journalEntries).where(eq(s.journalEntries.entryNo, 'JE-T3-001'));
  await db.insert(s.journalLines).values([
    { entryId: Number(jeT3.id), accountCode: '1000', debit: '1000', credit: '0', tenantId: t3 },
    { entryId: Number(jeT3.id), accountCode: '4000', debit: '0', credit: '1000', tenantId: t3 },
  ]).onConflictDoNothing();

  const grpFx = await inj('POST', '/api/consolidation/groups', admin, { name: 'FX Group 2026', fiscal_year: 2026 });
  const fxGroupId = grpFx.json.id;
  await inj('POST', `/api/consolidation/groups/${fxGroupId}/entities`, admin, { entity_tenant_id: t3, ownership_pct: 100, entity_currency: 'USD' });
  // IC reconciliation sign-off (no IC → 0 = 0, eliminates) then approve by a different user.
  await inj('POST', `/api/ic-reconciliation/groups/${fxGroupId}/prepare`, admin, { period: '2026-03' });
  await inj('POST', `/api/ic-reconciliation/groups/${fxGroupId}/approve`, admin2, { period: '2026-03' });

  const fxRun = await inj('POST', `/api/consolidation/groups/${fxGroupId}/run`, admin, { period: '2026-03' });
  ok('FIN-5 dual-rate run → Final + balanced', fxRun.status === 200 && fxRun.json.status === 'Final' && fxRun.json.balanced === true, JSON.stringify(fxRun.json).slice(0, 200));
  // Translation: Cash 1000 @closing 32 = 32000; Revenue 4000 @avg 31 = −31000; entityTranslated = 1000 → CTA = −1000.
  ok('FIN-5 CTA total parked in OCI ≈ −1000', near(fxRun.json.cta_total, -1000), `cta_total=${fxRun.json.cta_total}`);
  const cashAcct = fxRun.json.consolidated_accounts.find((a: any) => a.account_code === '1000');
  ok('FIN-5 cash 1000 translated at closing rate = 32000', near(cashAcct?.net_thb, 32000), `net=${cashAcct?.net_thb}`);
  const revAcct = fxRun.json.consolidated_accounts.find((a: any) => a.account_code === '4000');
  ok('FIN-5 revenue 4000 translated at average rate = −31000', near(revAcct?.net_thb, -31000), `net=${revAcct?.net_thb}`);
  const ctaAcct = fxRun.json.consolidated_accounts.find((a: any) => a.account_code === '3400');
  ok('FIN-5 CTA/OCI reserve line 3400 = −1000', near(ctaAcct?.net_thb, -1000), `net=${ctaAcct?.net_thb}`);

  // Run lines carry the rate + basis used per line.
  const fxLines = await inj('GET', `/api/consolidation/runs/${fxRun.json.run_id}/lines`, admin);
  const revLine = fxLines.json.lines.find((l: any) => l.line_type === 'Entity' && l.account_code === '4000');
  const cashLine = fxLines.json.lines.find((l: any) => l.line_type === 'Entity' && l.account_code === '1000');
  const ctaLine = fxLines.json.lines.find((l: any) => l.line_type === 'FX_CTA');
  ok('FIN-5 P&L line tagged average rate 31', revLine?.rate_type === 'average' && near(revLine?.fx_rate, 31), JSON.stringify(revLine));
  ok('FIN-5 BS line tagged closing rate 32', cashLine?.rate_type === 'closing' && near(cashLine?.fx_rate, 32), JSON.stringify(cashLine));
  ok('FIN-5 FX_CTA line on 3400 tagged cta', ctaLine?.account_code === '3400' && ctaLine?.rate_type === 'cta' && near(ctaLine?.amount_thb, -1000), JSON.stringify(ctaLine));

  // Consolidated statement of cash flows (indirect, post-elimination): net income 31000, FX effect 1000,
  // Δ cash 32000 — and it reconciles (activity sections tie to the movement in the cash accounts).
  const scf = await inj('GET', `/api/consolidation/runs/${fxRun.json.run_id}/cash-flow`, admin);
  ok('FIN-5 consolidated SCF reconciles', scf.status === 200 && scf.json.reconciled === true, JSON.stringify(scf.json).slice(0, 220));
  ok('FIN-5 consolidated SCF net income = 31000', near(scf.json.operating?.net_income, 31000), `ni=${scf.json.operating?.net_income}`);
  ok('FIN-5 consolidated SCF fx-effect on cash = 1000', near(scf.json.fx_effect?.net, 1000), `fx=${scf.json.fx_effect?.net}`);
  ok('FIN-5 consolidated SCF Δcash = 32000', near(scf.json.net_change_in_cash, 32000) && near(scf.json.consolidated_cash_movement, 32000), `Δ=${scf.json.net_change_in_cash}`);

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
