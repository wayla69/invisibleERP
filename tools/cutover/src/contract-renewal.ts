/**
 * SVC-3 — Service Contract Renewal & Expiry management (SVC-02 maker-checker + expiry worklist) over PGlite.
 * Propose within-threshold (auto) / over-threshold (pending) renewals; self-approval blocked; a distinct
 * approver creates the successor contract; reject leaves the old contract; expiry detective; RLS isolation.
 * Builds ONLY on service_contracts — never touches resolveEvent/sla_events/subscriptions.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover contract-renewal
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'renewal-secret';
process.env.NODE_ENV = 'test';
// multi-company so per-tenant Admins are RLS-scoped to their own tenant (single-company grants a global
// Admin bypass) — lets the RLS-isolation checks below prove a T1 Admin can't see/act on HQ renewals.
process.env.TENANCY_MODE = 'multi-company';

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
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'mgr', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }, // distinct approver (SVC-02 maker-checker)
    { username: 't1admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t1 }, // other tenant (RLS)
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ routerOptions: { maxParamLength: 500 } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /**/ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const [admin, mgr, t1admin] = [await login('admin', 'admin123'), await login('mgr', 'admin123'), await login('t1admin', 'admin123')];

  const mkContract = async (token: string, customer: string, endDate: string, monthly: number) =>
    (await inj('POST', '/api/service/contracts', token, { customer_name: customer, sla_tier: 'Gold', start_date: '2026-01-01', end_date: endDate, monthly_value: monthly })).json;

  // ── 0. Threshold config (SVC-02) ──
  const set0 = await inj('GET', '/api/service/renewal-settings', admin);
  ok('Renewal threshold default = 5%', near(set0.json.max_auto_uplift_pct, 5), JSON.stringify(set0.json));

  // ── 1. Within-threshold renewal auto-approves + creates successor ──
  const c1 = await mkContract(admin, 'Acme Corp', '2026-07-31', 10000);
  const r1 = await inj('POST', `/api/service/contracts/${c1.id}/renew`, admin, { uplift_pct: 3, proposed_start: '2026-08-01', proposed_end: '2027-07-31' });
  ok('Within-threshold (3%) renewal → auto_approved', r1.status === 201 && r1.json.auto_approved === true && r1.json.requires_approval === false, JSON.stringify(r1.json));
  ok('Auto renewal new_value = 10000×1.03 = 10300', near(r1.json.renewal?.new_value, 10300), `new=${r1.json.renewal?.new_value}`);
  ok('Auto renewal created successor contract', !!r1.json.successor_contract?.contract_no && near(r1.json.successor_contract?.monthly_value, 10300), JSON.stringify(r1.json.successor_contract));

  // Old contract now shows renewal_status=renewed and is excluded from the expiry worklist
  const listC = await inj('GET', '/api/service/contracts', admin);
  const oldC1 = listC.json.contracts?.find((c: any) => c.id === c1.id);
  // fetch expiring to assert exclusion below

  // ── 2. Over-threshold renewal → pending, no successor yet ──
  const c2 = await mkContract(admin, 'Beta Ltd', '2026-08-15', 20000);
  const r2 = await inj('POST', `/api/service/contracts/${c2.id}/renew`, admin, { uplift_pct: 20 });
  ok('Over-threshold (20%) renewal → pending, requires approval', r2.status === 201 && r2.json.requires_approval === true && r2.json.auto_approved === false && r2.json.renewal?.status === 'pending', JSON.stringify(r2.json));
  ok('Pending over-threshold renewal has NO successor', r2.json.successor_contract === undefined, JSON.stringify(Object.keys(r2.json)));
  const r2Id = r2.json.renewal.id;

  // ── 3. Self-approval blocked (SVC-02 maker-checker) ──
  const selfApprove = await inj('POST', `/api/service/renewals/${r2Id}/approve`, admin);
  ok('Self-approve pending renewal → 403 SOD_SELF_APPROVAL', selfApprove.status === 403 && selfApprove.json.error?.code === 'SOD_SELF_APPROVAL', JSON.stringify(selfApprove.json));

  // ── 4. Distinct approver approves → successor created + old contract renewed ──
  const approve = await inj('POST', `/api/service/renewals/${r2Id}/approve`, mgr);
  ok('Distinct approver approves → successor contract created', approve.status === 200 && approve.json.renewal?.status === 'approved' && near(approve.json.successor_contract?.monthly_value, 24000), JSON.stringify(approve.json));
  const listAfter = await inj('GET', '/api/service/contracts', admin);
  const c2row = listAfter.json.contracts?.find((c: any) => c.id === c2.id);
  ok('Old contract marked renewal_status=renewed after approval', c2row?.renewal_status === 'renewed' && !!c2row?.renewed_to_contract_id, JSON.stringify(c2row));

  // ── 5. Reject leaves the old contract (declined, no successor) ──
  const c3 = await mkContract(admin, 'Gamma Co', '2026-09-01', 5000);
  const r3 = await inj('POST', `/api/service/contracts/${c3.id}/renew`, admin, { uplift_pct: 15 });
  const reject = await inj('POST', `/api/service/renewals/${r3.json.renewal.id}/reject`, mgr, { reason: 'Customer negotiating' });
  ok('Reject pending renewal → declined', reject.status === 200 && reject.json.renewal?.status === 'rejected' && reject.json.declined === true, JSON.stringify(reject.json));
  const listAfter2 = await inj('GET', '/api/service/contracts', admin);
  const c3row = listAfter2.json.contracts?.find((c: any) => c.id === c3.id);
  ok('Rejected renewal leaves old contract (renewal_status=declined, no successor)', c3row?.renewal_status === 'declined' && !c3row?.renewed_to_contract_id, JSON.stringify(c3row));

  // ── 6. auto_renew that would raise price is gated even within threshold ──
  const c4 = await mkContract(admin, 'Delta Inc', '2026-09-30', 8000);
  const r4 = await inj('POST', `/api/service/contracts/${c4.id}/renew`, admin, { uplift_pct: 2, auto_renew: true });
  ok('auto_renew + small uplift → still pending (price rise gated)', r4.status === 201 && r4.json.requires_approval === true, JSON.stringify(r4.json));

  // ── 7. Expiring detective read ──
  const exp = await inj('GET', '/api/service/contracts/expiring?days=90&as_of=2026-07-11', admin);
  const expNos = (exp.json.expiring ?? []).map((c: any) => c.contract_no);
  ok('Expiring worklist excludes renewed contracts', exp.status === 200 && !expNos.includes(c1.contract_no) && !expNos.includes(c2.contract_no), JSON.stringify(expNos));
  ok('Expiring worklist includes near-expiry contract with no renewal in flight', expNos.includes(c3.contract_no), JSON.stringify(expNos));

  // ── 8. Threshold change lifts the auto-approval ceiling ──
  const put = await inj('PUT', '/api/service/renewal-settings', admin, { max_auto_uplift_pct: 25 });
  ok('Update threshold to 25%', put.status === 200 && near(put.json.max_auto_uplift_pct, 25), JSON.stringify(put.json));
  const c5 = await mkContract(admin, 'Epsilon LLC', '2026-10-31', 12000);
  const r5 = await inj('POST', `/api/service/contracts/${c5.id}/renew`, admin, { uplift_pct: 18 });
  ok('18% renewal auto-approves under the raised 25% threshold', r5.json.auto_approved === true && !!r5.json.successor_contract, JSON.stringify(r5.json));

  // ── 9. Guard: cannot re-renew an already-renewed contract ──
  const reRenew = await inj('POST', `/api/service/contracts/${c1.id}/renew`, admin, { uplift_pct: 1 });
  ok('Re-renew an already-renewed contract → 400 CONTRACT_ALREADY_RENEWED', reRenew.status === 400 && reRenew.json.error?.code === 'CONTRACT_ALREADY_RENEWED', JSON.stringify(reRenew.json));

  // ── 10. RLS isolation — T1 cannot see or act on HQ renewals ──
  const t1List = await inj('GET', '/api/service/renewals', t1admin);
  ok('RLS: T1 sees none of HQ renewals', t1List.status === 200 && t1List.json.count === 0, JSON.stringify({ count: t1List.json.count }));
  const t1Approve = await inj('POST', `/api/service/renewals/${r4.json.renewal.id}/approve`, t1admin);
  ok('RLS: T1 cannot approve an HQ renewal → 404 RENEWAL_NOT_FOUND', t1Approve.status === 404 && t1Approve.json.error?.code === 'RENEWAL_NOT_FOUND', JSON.stringify(t1Approve.json));

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
