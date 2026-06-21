/**
 * Phase 15 — Approval Workflow engine + Segregation of Duties (SoD) over PGlite:
 * generic multi-step amount-threshold routing, maker-checker, delegation, append-only audit, SoD rules.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover workflow
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wf-secret';
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
    { username: 'proc1', passwordHash: await pw.hash('pw'), role: 'Procurement', tenantId: t1 }, // maker + masterdata
    { username: 'mgr1', passwordHash: await pw.hash('pw'), role: 'Procurement', tenantId: t1 },  // step-1 approver
    { username: 'plan1', passwordHash: await pw.hash('pw'), role: 'Planner', tenantId: t1 },      // step-2 approver + exec
    { username: 'deleg1', passwordHash: await pw.hash('pw'), role: 'Sales', tenantId: t1 },       // delegation target (has approvals, not procurement)
    { username: 'sales2', passwordHash: await pw.hash('pw'), role: 'Sales', tenantId: t2 },       // T2 isolation
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
  const admin = await login('admin', 'admin123');
  const proc1 = await login('proc1', 'pw');
  const mgr1 = await login('mgr1', 'pw');
  const plan1 = await login('plan1', 'pw');
  const deleg1 = await login('deleg1', 'pw');
  const sales2 = await login('sales2', 'pw');
  const instOf = async (prNo: string) => ((await pg.query(`SELECT id, status, current_step FROM workflow_instances WHERE doc_no='${prNo}' ORDER BY id DESC LIMIT 1`)).rows as any[])[0];
  const mkPr = (token: string, amount: number) => inj('POST', '/api/procurement/prs', token, { amount, items: [{ item_id: 'A', request_qty: 1 }] });

  // ── 1. definition CRUD (created by a T1 masterdata user → tenant-visible to the T1 maker) ──
  const def = await inj('POST', '/api/workflow/definitions', mgr1, { doc_type: 'PR', name: 'PR approval', steps: [{ step_no: 1, approver_role: 'Procurement', min_amount: 0 }, { step_no: 2, approver_role: 'Planner', min_amount: 10000 }] });
  const defs = await inj('GET', '/api/workflow/definitions', mgr1);
  ok('Definition CRUD: 2-step PR workflow created + listed active', (def.status === 200 || def.status === 201) && (defs.json.definitions ?? []).some((d: any) => d.doc_type === 'PR' && d.active && d.steps.length === 2), JSON.stringify(def.json));

  // ── 2. submit routes to step 1 ──
  const pr1 = await mkPr(proc1, 5000);
  const i1 = await instOf(pr1.json.pr_no);
  ok('Submit routes to step 1 (pending)', pr1.json.status === 'Pending' && i1?.status === 'pending' && i1?.current_step === 1, JSON.stringify(i1));

  // ── 3. SoD maker-checker: creator cannot self-approve ──
  const self = await inj('PATCH', `/api/procurement/prs/${pr1.json.pr_no}/approve`, proc1, { approve: true });
  const i1b = await instOf(pr1.json.pr_no);
  ok('SoD maker-checker: creator self-approve → 403 SOD_VIOLATION, still pending', self.status === 403 && self.json.error?.code === 'SOD_VIOLATION' && i1b?.status === 'pending', `${self.status} ${self.json.error?.code}`);

  // ── 4-5. step-1 approve (sub-threshold) → approved + PR flips + status log ──
  const ap1 = await inj('PATCH', `/api/procurement/prs/${pr1.json.pr_no}/approve`, mgr1, { approve: true });
  const i1c = await instOf(pr1.json.pr_no);
  const slog = (await pg.query(`SELECT count(*)::int n FROM doc_status_log WHERE doc_type='PR' AND doc_no='${pr1.json.pr_no}'`)).rows as any[];
  ok('Step-1 approve (sub-threshold) → instance approved, PR Approved', ap1.json.status === 'Approved' && i1c?.status === 'approved', JSON.stringify({ pr: ap1.json.status, inst: i1c?.status }));
  ok('Status log trail recorded for the PR', Number(slog[0].n) >= 2, `n=${slog[0].n}`);

  // ── 6. reject path → terminal ──
  const pr2 = await mkPr(proc1, 5000);
  const rej = await inj('PATCH', `/api/procurement/prs/${pr2.json.pr_no}/approve`, mgr1, { approve: false });
  const i2 = await instOf(pr2.json.pr_no);
  const reAct = await inj('POST', `/api/workflow/instances/${i2.id}/act`, mgr1, { decision: 'approve' });
  ok('Reject → PR Rejected, instance rejected, further act → WORKFLOW_CLOSED', rej.json.status === 'Rejected' && i2?.status === 'rejected' && reAct.status === 400 && reAct.json.error?.code === 'WORKFLOW_CLOSED', `${rej.json.status} ${reAct.json.error?.code}`);

  // ── 7. over-threshold multi-level routing ──
  const pr3 = await mkPr(proc1, 50000);
  await inj('PATCH', `/api/procurement/prs/${pr3.json.pr_no}/approve`, mgr1, { approve: true }); // step 1
  const i3 = await instOf(pr3.json.pr_no);
  const ap3 = await inj('PATCH', `/api/procurement/prs/${pr3.json.pr_no}/approve`, plan1, { approve: true }); // step 2
  const i3b = await instOf(pr3.json.pr_no);
  ok('Over-threshold: step1→step2 routing; both cleared → Approved', i3?.current_step === 2 && i3?.status === 'pending' && ap3.json.status === 'Approved' && i3b?.status === 'approved', JSON.stringify({ afterStep1: i3?.current_step, final: i3b?.status }));

  // ── 8. delegation ──
  await inj('POST', '/api/workflow/delegations', mgr1, { to_user: 'deleg1', from_date: '2020-01-01', to_date: '2030-12-31' });
  const pr4 = await mkPr(proc1, 5000);
  const i4 = await instOf(pr4.json.pr_no);
  const delAct = await inj('POST', `/api/workflow/instances/${i4.id}/act`, deleg1, { decision: 'approve' }); // Sales delegate acts on behalf of mgr1
  const obo = (await pg.query(`SELECT on_behalf_of FROM approval_actions WHERE instance_id=${i4.id} ORDER BY id DESC LIMIT 1`)).rows as any[];
  ok('Delegation: Sales delegate approves on behalf of mgr1 (on_behalf_of recorded)', delAct.json.status === 'approved' && obo[0]?.on_behalf_of === 'mgr1', JSON.stringify({ st: delAct.json.status, obo: obo[0]?.on_behalf_of }));

  // ── 9. my-approvals scoping ──
  const pr5 = await mkPr(proc1, 5000);
  const mine = await inj('GET', '/api/workflow/my-approvals', mgr1);
  const t2mine = await inj('GET', '/api/workflow/my-approvals', sales2);
  ok('my-approvals: mgr1 sees pending step-1 PRs; T2 sees none', (mine.json.items ?? []).some((x: any) => x.doc_no === pr5.json.pr_no) && (t2mine.json.items ?? []).length === 0, `mine=${(mine.json.items ?? []).length} t2=${(t2mine.json.items ?? []).length}`);

  // ── 10. append-only audit trail ──
  let immutable = false;
  try { await pg.query(`UPDATE approval_actions SET comment='tamper' WHERE id=(SELECT id FROM approval_actions LIMIT 1)`); } catch { immutable = true; }
  const actCnt = (await pg.query(`SELECT count(*)::int n FROM approval_actions`)).rows as any[];
  ok('Audit trail append-only (UPDATE blocked by trigger) + rows recorded', immutable && Number(actCnt[0].n) >= 4, `immutable=${immutable} n=${actCnt[0].n}`);

  // ── 11. RLS isolation ──
  const t2inst = await inj('GET', `/api/workflow/instances/${i4.id}`, sales2);
  ok('RLS: T2 cannot read a T1 instance', t2inst.status === 404, `${t2inst.status}`);

  // ── 12. unknown instance + no-definition passthrough ──
  const unknown = await inj('POST', '/api/workflow/instances/999999/act', mgr1, { decision: 'approve' });
  await inj('PATCH', `/api/workflow/definitions/${(defs.json.definitions ?? []).find((d: any) => d.doc_type === 'PR')?.id ?? 1}`, mgr1, { active: false }); // deactivate → legacy passthrough
  const prX = await mkPr(proc1, 5000);
  const instX = await instOf(prX.json.pr_no);
  const apX = await inj('PATCH', `/api/procurement/prs/${prX.json.pr_no}/approve`, admin, { approve: true }); // legacy Admin path
  ok('Unknown instance → 404; no active def → autoApproved passthrough (legacy approve)', unknown.status === 404 && !instX && apX.json.status === 'Approved', `unknown=${unknown.status} inst=${!!instX} legacy=${apX.json.status}`);

  // ── 13. SoD PERM_PAIR rule + violation report ──
  await inj('POST', '/api/sod/rules', mgr1, { name: 'PO maker vs approver', kind: 'PERM_PAIR', perm_a: 'procurement', perm_b: 'approvals' });
  const viol = await inj('GET', '/api/sod/violations', admin);
  ok('SoD PERM_PAIR: violation report flags roles holding both perms', viol.json.count > 0 && (viol.json.violations ?? []).some((v: any) => v.perm_a === 'procurement' && v.perm_b === 'approvals'), JSON.stringify({ count: viol.json.count }));

  // ── 14. engine posts NOTHING to the GL ──
  const glRows = (await pg.query(`SELECT count(*)::int n FROM journal_entries WHERE source IN ('WORKFLOW','SOD')`)).rows as any[];
  ok('Engine posts no GL (no WORKFLOW/SOD journal entries)', Number(glRows[0].n) === 0, `n=${glRows[0].n}`);

  console.log('\n── Phase 15 — Approval Workflow + SoD ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} workflow checks failed` : `\n✅ All ${checks.length} workflow checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
