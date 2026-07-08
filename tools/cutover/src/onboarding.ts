/**
 * A4+A5 — tenant onboarding/provisioning + force-change password, over PGlite.
 * signup auto-provisions fiscal periods + captures identity; /api/tenant/profile read+write;
 * seeded-admin must_change_password gate + /api/auth/change-password.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover onboarding
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'onb-secret';
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
import { BillingService } from '../../../apps/api/dist/modules/billing/billing.service';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }]).onConflictDoNothing();
  const hq = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0].id);
  // seeded admin carries the force-change flag (mirrors seed.ts / migration 0045)
  await db.insert(s.users).values([{ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq, mustChangePassword: true }]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();
  await app.get(BillingService).seedPlans();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = (u: string, p: string) => inj('POST', '/api/login', undefined, { username: u, password: p });
  const year = new Date().getFullYear();

  // ── 1. signup → tenant + periods provisioned + identity captured ──
  const su = await inj('POST', '/api/auth/signup', undefined, {
    company_name: 'ร้านทดสอบ', tenant_code: 'shoptest', admin_username: 'owner1', admin_password: 'ownerpass1', email: 'o@x.com',
    tax_id: '0105551234567', vat_registered: true,
  });
  ok('Signup → tenant created + fiscal year provisioned', su.status === 201 && su.json.fiscal_year_provisioned === year && !!su.json.tenant_id, JSON.stringify({ st: su.status, fy: su.json.fiscal_year_provisioned }));
  const newTid = su.json.tenant_id;
  const periodRows = (await pg.query(`SELECT count(*)::int n FROM fiscal_periods WHERE tenant_id=${newTid}`)).rows as any[];
  ok('Signup provisioned 12 periods for the new tenant', periodRows[0].n === 12, `periods=${periodRows[0].n}`);

  // Multi-company tenancy (ITGC-AC-18): the new company gets its OWN org (org_id = its tenant id) on both
  // the tenant row and the created Admin, so under TENANCY_MODE=multi-company it's isolated by default.
  const orgRows = (await pg.query(`SELECT (SELECT org_id FROM tenants WHERE id=${newTid}) AS t_org, (SELECT org_id FROM users WHERE username='owner1') AS u_org`)).rows as any[];
  ok('Signup assigns org_id = tenant id on the new tenant AND its Admin (multi-company isolation)', Number(orgRows[0].t_org) === Number(newTid) && Number(orgRows[0].u_org) === Number(newTid), JSON.stringify({ t_org: orgRows[0].t_org, u_org: orgRows[0].u_org, tid: newTid }));

  // ── 2. new owner can log in + post a journal into a current-year period ──
  const ownerLogin = await login('owner1', 'ownerpass1');
  ok('New owner login → not forced to change password', ownerLogin.json.must_change_password === false, JSON.stringify({ mcp: ownerLogin.json.must_change_password }));
  const owner = ownerLogin.json.token;
  const je = await inj('POST', '/api/ledger/journal', owner, { date: `${year}-06-15`, source: 'TEST', lines: [{ account_code: '1000', debit: 100 }, { account_code: '4000', credit: 100 }] });
  // GL-05: a manual JE posts as DRAFT (pending) — excluded from balances until a different user approves it.
  ok('New tenant manual JE posts as Draft (periods exist; GL-05 maker-checker)', /^JE-/.test(je.json.entry_no ?? '') && je.json.pending === true, `${je.status} ${je.json.entry_no} pending=${je.json.pending}`);

  // ── 3. tenant profile GET/PATCH ──
  const prof = await inj('GET', '/api/tenant/profile', owner);
  ok('Profile GET → identity from signup (tax_id, legal_name=company)', prof.json.tax_id === '0105551234567' && prof.json.legal_name === 'ร้านทดสอบ' && prof.json.vat_registered === true, JSON.stringify({ tid: prof.json.tax_id, ln: prof.json.legal_name }));
  ok('Profile GET → setup_complete=false until address filled', prof.json.setup_complete === false, `complete=${prof.json.setup_complete}`);
  const patch = await inj('PATCH', '/api/tenant/profile', owner, { address_line1: '1 ถนนหลัก', province: 'กรุงเทพมหานคร', postal_code: '10110', vat_rate: 0.07 });
  ok('Profile PATCH → setup_complete=true after address', patch.status === 200 && patch.json.setup_complete === true && patch.json.province === 'กรุงเทพมหานคร', JSON.stringify({ st: patch.status, c: patch.json.setup_complete }));

  // ── 3a2. Onboarding checklist + starter pack (ITGC-AC-18 #4): the setup-wizard backbone + a minimal
  //         industry starter (default HQ branch). ──
  const status1 = await inj('GET', '/api/tenant/onboarding-status', owner);
  const step = (r: any, k: string) => (r.json.steps ?? []).find((s: any) => s.key === k);
  ok('Onboarding status → profile done, branch not yet, next=branch', status1.status === 200 && step(status1, 'profile')?.done === true && step(status1, 'branch')?.done === false && status1.json.next === 'branch', JSON.stringify({ st: status1.status, done: status1.json.done, total: status1.json.total, next: status1.json.next }));
  const sp1 = await inj('POST', '/api/tenant/starter-pack', owner, {});
  ok('Starter-pack creates the HQ branch', sp1.status === 201 && (sp1.json.created ?? []).includes('hq_branch'), JSON.stringify(sp1.json));
  const status2 = await inj('GET', '/api/tenant/onboarding-status', owner);
  ok('Onboarding status → branch step done after starter-pack', status2.status === 200 && step(status2, 'branch')?.done === true, JSON.stringify({ done: status2.json.done, next: status2.json.next }));
  const sp2 = await inj('POST', '/api/tenant/starter-pack', owner, {});
  ok('Starter-pack is idempotent (2nd call skips HQ)', sp2.status === 201 && (sp2.json.skipped ?? []).includes('hq_branch'), JSON.stringify(sp2.json));

  // ── 3b. Platform-admin create-company (ITGC-AC-18): only a PLATFORM_ADMIN_USERNAMES user can
  //        POST /api/admin/tenants to provision a new company — the authenticated alternative to toggling
  //        public signup. Guard is enforced regardless of tenancy mode. ──
  process.env.PLATFORM_ADMIN_USERNAMES = ''; // owner1 is NOT a platform admin yet
  const createBody = { company_name: 'PlatCo', tenant_code: 'platco1', admin_username: 'platco_admin', admin_password: 'platco12345', email: 'p@c.com' };
  const denied = await inj('POST', '/api/admin/tenants', owner, createBody);
  ok('Create-company blocked for a non-platform-admin (403 PLATFORM_ADMIN_REQUIRED)', denied.status === 403 && denied.json.error?.code === 'PLATFORM_ADMIN_REQUIRED', `${denied.status} ${denied.json.error?.code}`);
  process.env.PLATFORM_ADMIN_USERNAMES = 'owner1'; // now owner1 is a platform owner
  // L-4: provisioning an admin whose username is a platform owner (would silently inherit the god bypass) is refused.
  const reservedCreate = await inj('POST', '/api/admin/tenants', owner, { company_name: 'GodCo', tenant_code: 'godco1', admin_username: 'owner1', admin_password: 'godco12345', email: 'g@c.com' });
  ok('Provisioning an admin whose username is a platform owner is refused (400 RESERVED_USERNAME) — L-4', reservedCreate.status === 400 && reservedCreate.json.error?.code === 'RESERVED_USERNAME', `${reservedCreate.status} ${reservedCreate.json.error?.code}`);
  const created = await inj('POST', '/api/admin/tenants', owner, createBody);
  ok('Platform-admin creates a new company via POST /api/admin/tenants (201)', created.status === 201 && !!created.json.tenant_id, `${created.status} tid=${created.json.tenant_id}`);
  const pcRows = (await pg.query(`SELECT (SELECT org_id FROM tenants WHERE id=${created.json.tenant_id}) AS t_org, (SELECT org_id FROM users WHERE username='platco_admin') AS u_org, (SELECT count(*)::int FROM fiscal_periods WHERE tenant_id=${created.json.tenant_id}) AS periods`)).rows as any[];
  ok('Platform-created company is org-isolated + fully provisioned (org_id=tenant id, 12 periods)', Number(pcRows[0].t_org) === Number(created.json.tenant_id) && Number(pcRows[0].u_org) === Number(created.json.tenant_id) && pcRows[0].periods === 12, JSON.stringify(pcRows[0]));
  const platLogin = await login('platco_admin', 'platco12345');
  ok('The newly platform-created Admin can log in', !!platLogin.json.token, `st=${platLogin.status}`);

  // ── 3b2. ITGC-AC-02: ONLY the platform owner may grant the Admin role. platco_admin is a per-tenant
  //         Admin (holds `users`) but is NOT a platform owner — it must not be able to mint another Admin,
  //         while the platform owner (owner1) can. A non-Admin role is unaffected. ──
  const grantAdminDenied = await inj('POST', '/api/admin/users', platLogin.json.token, { username: 'wannabe_admin', password: 'wannabe12345', role: 'Admin' });
  ok('Company Admin (non-platform) cannot grant the Admin role (403 ADMIN_GRANT_DENIED)', grantAdminDenied.status === 403 && grantAdminDenied.json.error?.code === 'ADMIN_GRANT_DENIED', `${grantAdminDenied.status} ${grantAdminDenied.json.error?.code}`);
  const grantNonAdmin = await inj('POST', '/api/admin/users', platLogin.json.token, { username: 'platco_sales', password: 'salespass12345', role: 'Sales' });
  ok('Company Admin CAN still create a non-Admin user (role granularity preserved)', grantNonAdmin.status === 201 && grantNonAdmin.json.created === true, `${grantNonAdmin.status} ${JSON.stringify(grantNonAdmin.json)}`);
  const grantAdminOk = await inj('POST', '/api/admin/users', owner, { username: 'god_made_admin', password: 'godadmin12345', role: 'Admin' });
  ok('Platform owner (godmimi) CAN grant the Admin role (201 created)', grantAdminOk.status === 201 && grantAdminOk.json.created === true, `${grantAdminOk.status} ${JSON.stringify(grantAdminOk.json)}`);
  // A non-platform Admin also cannot PROMOTE an existing user to Admin.
  const promoteDenied = await inj('PATCH', '/api/admin/users/platco_sales', platLogin.json.token, { role: 'Admin' });
  ok('Company Admin cannot promote a user to Admin either (403 ADMIN_GRANT_DENIED)', promoteDenied.status === 403 && promoteDenied.json.error?.code === 'ADMIN_GRANT_DENIED', `${promoteDenied.status} ${promoteDenied.json.error?.code}`);
  // Company directory (backs the Platform Console table + the switcher). Lists EVERY tenant enriched with
  // status/plan/user-count; a non-platform-admin is blocked at the guard.
  const dirDenied = await inj('GET', '/api/admin/tenants', platLogin.json.token); // platco_admin is NOT a platform owner
  ok('GET /api/admin/tenants blocked for a non-platform-admin (403)', dirDenied.status === 403, `${dirDenied.status} ${dirDenied.json.error?.code}`);
  const dir = await inj('GET', '/api/admin/tenants', owner); // owner1 IS the platform owner
  const dirRows = Array.isArray(dir.json) ? dir.json : [];
  const createdRow = dirRows.find((r: any) => Number(r.id) === Number(created.json.tenant_id));
  ok('GET /api/admin/tenants lists all companies enriched (status/plan/users) incl. the just-provisioned one',
    dir.status === 200 && dirRows.length >= 2 && !!createdRow && typeof createdRow.users === 'number' && 'status' in createdRow && 'plan_code' in createdRow,
    `n=${dirRows.length} created={status:${createdRow?.status},plan:${createdRow?.plan_code},users:${createdRow?.users}}`);
  // Company detail drawer (Platform Console) — full profile + subscription + counts + recent activity.
  const detail = await inj('GET', `/api/admin/tenants/${created.json.tenant_id}`, owner);
  ok('GET /api/admin/tenants/:id returns company detail (subscription + counts + activity)',
    detail.status === 200 && detail.json.id === Number(created.json.tenant_id) && !!detail.json.subscription && typeof detail.json.counts?.users === 'number' && Array.isArray(detail.json.recent_activity),
    `st=${detail.status} plan=${detail.json.subscription?.plan_code} users=${detail.json.counts?.users}`);
  // Platform subscription control — extend trial (pushes trial_ends_at out, status Trialing).
  const ext = await inj('POST', `/api/admin/tenants/${created.json.tenant_id}/extend-trial`, owner, { days: 14 });
  ok('POST /api/admin/tenants/:id/extend-trial extends the trial (status Trialing, future end)',
    ext.status === 200 && ext.json.status === 'Trialing' && new Date(ext.json.trial_ends_at).getTime() > Date.now(),
    `st=${ext.status} ends=${ext.json.trial_ends_at}`);
  // Platform subscription control — change plan (no impersonation).
  const chg = await inj('POST', `/api/admin/tenants/${created.json.tenant_id}/plan`, owner, { plan_code: 'pro' });
  ok('POST /api/admin/tenants/:id/plan changes the plan cross-tenant (status Active)',
    chg.status === 200 && chg.json.plan === 'pro' && chg.json.status === 'Active', `st=${chg.status} plan=${chg.json.plan}`);
  // Directory carries setup_complete (drives the "ตั้งค่ายังไม่เสร็จ" needs-attention card).
  const dir2 = await inj('GET', '/api/admin/tenants', owner);
  ok('GET /api/admin/tenants rows carry setup_complete', Array.isArray(dir2.json) && dir2.json.every((r: any) => typeof r.setup_complete === 'boolean'), `sample=${dir2.json?.[0]?.setup_complete}`);
  // Company tags/segments (migration 0246) — set + reflected in the directory.
  const setTags = await inj('POST', `/api/admin/tenants/${created.json.tenant_id}/tags`, owner, { tags: ['enterprise', 'enterprise', ' vip '] });
  const dirTags = ((await inj('GET', '/api/admin/tenants', owner)).json as any[]).find((r) => Number(r.id) === Number(created.json.tenant_id));
  ok('POST /api/admin/tenants/:id/tags sets deduped/trimmed tags reflected in the directory',
    setTags.status === 200 && Array.isArray(setTags.json.tags) && setTags.json.tags.length === 2 && JSON.stringify(dirTags?.tags) === JSON.stringify(['enterprise', 'vip']),
    `set=${JSON.stringify(setTags.json.tags)} dir=${JSON.stringify(dirTags?.tags)}`);
  // Cross-company AI usage aggregate (Platform Console AI-spend panel).
  const aiu = await inj('GET', '/api/admin/ai-usage', owner);
  ok('GET /api/admin/ai-usage returns a per-company token aggregate (array, sorted by spend)',
    aiu.status === 200 && Array.isArray(aiu.json) && aiu.json.every((r: any) => typeof r.tenant_id === 'number' && typeof r.total_tokens === 'number'),
    `st=${aiu.status} n=${Array.isArray(aiu.json) ? aiu.json.length : 'x'}`);
  // Detail + subscription control are platform-owner-gated too.
  // Cross-company activity feed (Platform Console) — owner (Admin, single-company bypass) sees audit rows
  // across tenants; the new tenant_id filter narrows to exactly one company.
  const auditAll = await inj('GET', '/api/admin/audit?limit=200', owner);
  const allRows = (auditAll.json.rows ?? []) as any[];
  const pickTid = allRows.map((r) => r.tenant_id).find((x) => x != null);
  const auditOne = pickTid != null ? ((await inj('GET', `/api/admin/audit?limit=200&tenant_id=${pickTid}`, owner)).json.rows ?? []) as any[] : [];
  ok('GET /api/admin/audit?tenant_id filters the fleet-wide feed to exactly one company',
    auditAll.status === 200 && allRows.length > 0 && (pickTid == null || (auditOne.length > 0 && auditOne.every((r) => Number(r.tenant_id) === Number(pickTid)))),
    `all=${allRows.length} pick=${pickTid} one=${auditOne.length}`);
  // Detail + subscription control are platform-owner-gated too.
  process.env.PLATFORM_ADMIN_USERNAMES = ''; // temporarily drop owner's platform status
  const detailDenied = await inj('GET', `/api/admin/tenants/${created.json.tenant_id}`, owner);
  ok('GET /api/admin/tenants/:id blocked for a non-platform-admin (403)', detailDenied.status === 403, `${detailDenied.status}`);
  process.env.PLATFORM_ADMIN_USERNAMES = ''; // restore

  // ── 3c. Invite-link onboarding (ITGC-AC-18 #2): a platform owner issues a SINGLE-USE, expiring invite;
  //        the invitee signs up with the token (works even when public signup is disabled). ──
  const inviteDenied = await inj('POST', '/api/admin/signup-invites', owner, { company_name: 'InviteCo' });
  ok('Issue-invite blocked for a non-platform-admin (403 PLATFORM_ADMIN_REQUIRED)', inviteDenied.status === 403 && inviteDenied.json.error?.code === 'PLATFORM_ADMIN_REQUIRED', `${inviteDenied.status} ${inviteDenied.json.error?.code}`);
  process.env.PLATFORM_ADMIN_USERNAMES = 'owner1';
  const inviteRes = await inj('POST', '/api/admin/signup-invites', owner, { company_name: 'InviteCo', email: 'i@c.com', ttl_hours: 24 });
  ok('Platform-admin issues a signup invite (201 + raw token returned once)', inviteRes.status === 201 && !!inviteRes.json.invite_token && !!inviteRes.json.expires_at, `${inviteRes.status}`);
  const inviteTok = inviteRes.json.invite_token;
  process.env.PLATFORM_ADMIN_USERNAMES = '';
  const bogus = await inj('POST', '/api/auth/signup', undefined, { company_name: 'X', tenant_code: 'inv-bogus', admin_username: 'invbogus', admin_password: 'invbogus12', email: 'x@y.com', invite_token: 'deadbeefcafe' });
  ok('Signup with a bogus invite token → 400 INVALID_INVITE', bogus.status === 400 && bogus.json.error?.code === 'INVALID_INVITE', `${bogus.status} ${bogus.json.error?.code}`);
  const invSignup = await inj('POST', '/api/auth/signup', undefined, { company_name: 'InviteCo', tenant_code: 'inviteco1', admin_username: 'inviteco_admin', admin_password: 'inviteco12', email: 'i@c.com', invite_token: inviteTok });
  ok('Signup with a VALID invite token → provisions the company (201)', invSignup.status === 201 && !!invSignup.json.tenant_id, `${invSignup.status} tid=${invSignup.json.tenant_id}`);
  const reuse = await inj('POST', '/api/auth/signup', undefined, { company_name: 'InviteCo2', tenant_code: 'inviteco2', admin_username: 'inviteco_admin2', admin_password: 'inviteco12', email: 'i@c.com', invite_token: inviteTok });
  ok('Re-using a consumed invite token → 400 INVALID_INVITE (single-use)', reuse.status === 400 && reuse.json.error?.code === 'INVALID_INVITE', `${reuse.status} ${reuse.json.error?.code}`);
  process.env.PLATFORM_ADMIN_USERNAMES = 'owner1';
  const invList = await inj('GET', '/api/admin/signup-invites', owner);
  ok('Invite list shows the consumed invite as used', invList.status === 200 && (invList.json.invites ?? []).some((x: any) => x.status === 'used'), `${invList.status}`);
  process.env.PLATFORM_ADMIN_USERNAMES = ''; // restore

  // ── 3d. Approval-queue onboarding (ITGC-AC-18 #3): a PUBLIC request → PENDING (no tenant); the platform
  //        owner approves (→ provisions) or rejects. ──
  const reqBody = { company_name: 'QueueCo', tenant_code: 'queueco1', admin_username: 'queueco_admin', admin_password: 'queueco12345', email: 'q@c.com' };
  const sreq = await inj('POST', '/api/auth/signup-requests', undefined, reqBody);
  ok('Public "request access" → 201 pending (no tenant provisioned yet)', sreq.status === 201 && sreq.json.status === 'pending' && !!sreq.json.request_id, `${sreq.status}`);
  const reqId = sreq.json.request_id;
  const noTenantYet = (await pg.query(`SELECT count(*)::int n FROM tenants WHERE code='queueco1'`)).rows as any[];
  ok('A pending request does NOT create a tenant', noTenantYet[0].n === 0, `tenants=${noTenantYet[0].n}`);
  const dup = await inj('POST', '/api/auth/signup-requests', undefined, reqBody);
  ok('Duplicate pending request → 409 REQUEST_PENDING', dup.status === 409 && dup.json.error?.code === 'REQUEST_PENDING', `${dup.status} ${dup.json.error?.code}`);
  const listDenied = await inj('GET', '/api/admin/signup-requests', owner);
  ok('The request queue is platform-admin only (403 for a non-owner)', listDenied.status === 403, `${listDenied.status}`);
  process.env.PLATFORM_ADMIN_USERNAMES = 'owner1';
  const rlist = await inj('GET', '/api/admin/signup-requests?status=pending', owner);
  ok('Platform-admin sees the pending request in the queue', rlist.status === 200 && (rlist.json.requests ?? []).some((r: any) => r.id === reqId), `${rlist.status}`);
  // Platform notification inbox (item 2) — the signup request emitted a god notification; it's unread.
  // Then mark-all-read clears the unread count.
  const inbox = await inj('GET', '/api/admin/notifications', owner);
  const unread0 = (await inj('GET', '/api/admin/notifications/unread-count', owner)).json.unread_count;
  ok('Platform notification inbox surfaces the signup_request event (unread)',
    inbox.status === 200 && (inbox.json.items ?? []).some((n: any) => n.type === 'signup_request' && n.is_read === false) && unread0 >= 1,
    `st=${inbox.status} unread=${unread0}`);
  const markAll = await inj('POST', '/api/admin/notifications/mark-all-read', owner, {});
  const unread1 = (await inj('GET', '/api/admin/notifications/unread-count', owner)).json.unread_count;
  ok('mark-all-read clears the god unread count', markAll.status < 300 && markAll.json.ok === true && unread1 === 0, `st=${markAll.status} marked=${markAll.json.marked} unread=${unread1}`);
  const approve = await inj('POST', `/api/admin/signup-requests/${reqId}/approve`, owner, {});
  ok('Approve → provisions the company (201) + status approved', approve.status === 201 && !!approve.json.tenant_id && approve.json.status === 'approved', `${approve.status} tid=${approve.json.tenant_id}`);
  const qLogin = await login('queueco_admin', 'queueco12345');
  ok('The approved company Admin logs in with the REQUESTED password', !!qLogin.json.token, `st=${qLogin.status}`);
  const reApprove = await inj('POST', `/api/admin/signup-requests/${reqId}/approve`, owner, {});
  ok('Re-approving a handled request → 409 REQUEST_NOT_PENDING', reApprove.status === 409 && reApprove.json.error?.code === 'REQUEST_NOT_PENDING', `${reApprove.status} ${reApprove.json.error?.code}`);
  const req2 = await inj('POST', '/api/auth/signup-requests', undefined, { company_name: 'RejectCo', tenant_code: 'rejectco1', admin_username: 'rejectco_admin', admin_password: 'rejectco12345', email: 'r@c.com' });
  const rej = await inj('POST', `/api/admin/signup-requests/${req2.json.request_id}/reject`, owner, { reason: 'not a fit' });
  ok('Reject → status rejected (no tenant created)', rej.status === 200 && rej.json.status === 'rejected', `${rej.status}`);
  process.env.PLATFORM_ADMIN_USERNAMES = ''; // restore

  // ── 3g. Tenant lifecycle (ITGC-AC-18 #5): a platform owner suspends a company → its users are blocked
  //        (TENANT_SUSPENDED); reactivate restores access. Platform owners are exempt from the block. ──
  process.env.PLATFORM_ADMIN_USERNAMES = 'owner1';
  const lc = await inj('POST', '/api/admin/tenants', owner, { company_name: 'LifeCo', tenant_code: 'lifeco1', admin_username: 'lifeco_admin', admin_password: 'lifeco12345', email: 'l@c.com' });
  const lcTid = lc.json.tenant_id;
  const lcTok = (await login('lifeco_admin', 'lifeco12345')).json.token;
  const before = await inj('GET', '/api/tenant/onboarding-status', lcTok);
  ok('Before suspend: the new company Admin can access (200)', before.status === 200, `${before.status}`);
  process.env.PLATFORM_ADMIN_USERNAMES = ''; // owner1 not a platform admin for the denial check
  const suspDenied = await inj('POST', `/api/admin/tenants/${lcTid}/suspend`, owner, { reason: 'x' });
  ok('Suspend blocked for a non-platform-admin (403)', suspDenied.status === 403, `${suspDenied.status}`);
  process.env.PLATFORM_ADMIN_USERNAMES = 'owner1';
  const susp = await inj('POST', `/api/admin/tenants/${lcTid}/suspend`, owner, { reason: 'non-payment' });
  ok('Platform-admin suspends the company (200)', susp.status === 200 && susp.json.status === 'suspended', `${susp.status}`);
  const blocked = await inj('GET', '/api/tenant/onboarding-status', lcTok);
  ok('A suspended company Admin is BLOCKED (403 TENANT_SUSPENDED)', blocked.status === 403 && blocked.json.error?.code === 'TENANT_SUSPENDED', `${blocked.status} ${blocked.json.error?.code}`);
  const react = await inj('POST', `/api/admin/tenants/${lcTid}/reactivate`, owner, {});
  ok('Platform-admin reactivates the company (200)', react.status === 200 && react.json.status === 'active', `${react.status}`);
  const after = await inj('GET', '/api/tenant/onboarding-status', lcTok);
  ok('A reactivated company Admin can access again (200)', after.status === 200, `${after.status}`);
  process.env.PLATFORM_ADMIN_USERNAMES = ''; // restore

  // ── 3b. Billing checkout. Without STRIPE_SECRET_KEY (CI/dev) a paid plan returns a mock checkout URL;
  //        a free plan is rejected (nothing to charge). Real Stripe is exercised only with a key set. ──
  const coPro = await inj('POST', '/api/billing/checkout', owner, { plan_code: 'pro' });
  ok('Billing checkout (pro) → checkout URL (mock without STRIPE key)', (coPro.status === 200 || coPro.status === 201) && typeof coPro.json.url === 'string' && coPro.json.mock === true, JSON.stringify({ st: coPro.status, mock: coPro.json.mock }));
  const coFree = await inj('POST', '/api/billing/checkout', owner, { plan_code: 'free' });
  ok('Billing checkout (free) → 400 PLAN_NOT_PURCHASABLE (no monthly price)', coFree.status === 400 && coFree.json.error?.code === 'PLAN_NOT_PURCHASABLE', `${coFree.status} ${coFree.json.error?.code}`);

  // ── 3c. Stripe webhook → subscription state machine. No STRIPE_WEBHOOK_SECRET in test ⇒ the parsed
  //        event body is accepted. checkout.completed activates; payment_failed → PastDue; deleted → Canceled. ──
  const tId = su.json.tenant_id;
  const hook = (evt: any) => inj('POST', '/api/billing/stripe/webhook', undefined, evt);
  const whA = await hook({ type: 'checkout.session.completed', data: { object: { client_reference_id: String(tId), metadata: { tenant_id: String(tId), plan_code: 'pro' }, customer: 'cus_onb', subscription: 'sub_onb' } } });
  const subA = await inj('GET', '/api/billing/subscription', owner);
  ok('Stripe webhook: checkout.completed → subscription Active on pro', whA.json.handled === true && subA.json.status === 'Active' && subA.json.plan_code === 'pro', JSON.stringify({ handled: whA.json.handled, st: subA.json.status, plan: subA.json.plan_code }));
  await hook({ type: 'invoice.payment_failed', data: { object: { customer: 'cus_onb' } } });
  const subP = await inj('GET', '/api/billing/subscription', owner);
  ok('Stripe webhook: invoice.payment_failed → PastDue', subP.json.status === 'PastDue', `st=${subP.json.status}`);
  await hook({ type: 'customer.subscription.deleted', data: { object: { customer: 'cus_onb' } } });
  const subC = await inj('GET', '/api/billing/subscription', owner);
  ok('Stripe webhook: subscription.deleted → Canceled', subC.json.status === 'Canceled', `st=${subC.json.status}`);

  // ── 3d. PlanGuard (already wired as APP_GUARD) gates an ai_chat route on subscription status. A non-Admin
  //        tenant user (Sales carries `dashboard`; Admin would bypass PlanGuard) hitting GET /api/ai/kb/search:
  //        Canceled → SUBSCRIPTION_INACTIVE; expired trial → TRIAL_EXPIRED; Active pro (ai_chat=true) → allowed. ──
  await db.insert(s.users).values([{ username: 'planuser', passwordHash: await pw.hash('planpass1'), role: 'Sales', tenantId: Number(tId) }]).onConflictDoNothing();
  const puTok = (await login('planuser', 'planpass1')).json.token;
  const gated = () => inj('GET', '/api/ai/kb/search?q=hours', puTok);
  const gCanceled = await gated(); // owner-tenant sub is Canceled from the webhook test above
  ok('PlanGuard: Canceled subscription blocks ai_chat route (403 SUBSCRIPTION_INACTIVE)', gCanceled.status === 403 && gCanceled.json.error?.code === 'SUBSCRIPTION_INACTIVE', `${gCanceled.status} ${gCanceled.json.error?.code}`);
  await db.update(s.subscriptions).set({ status: 'Trialing', trialEndsAt: new Date(Date.now() - 86400000) }).where(eq(s.subscriptions.tenantId, Number(tId)));
  const gExpired = await gated();
  ok('PlanGuard: expired trial blocks ai_chat route (403 TRIAL_EXPIRED)', gExpired.status === 403 && gExpired.json.error?.code === 'TRIAL_EXPIRED', `${gExpired.status} ${gExpired.json.error?.code}`);
  await db.update(s.subscriptions).set({ status: 'Active' }).where(eq(s.subscriptions.tenantId, Number(tId)));
  const gActive = await gated();
  ok('PlanGuard: Active pro plan (ai_chat=true) allows the route (not 403)', gActive.status !== 403, `${gActive.status}`);

  // ── 4. A5 — seeded admin forced to change password ──
  const a1 = await login('admin', 'admin123');
  ok('Seeded admin login → must_change_password=true', a1.json.must_change_password === true, JSON.stringify({ mcp: a1.json.must_change_password }));
  const adminTok = a1.json.token;
  // docs/27 R0-3 — must_change_password is a HARD API gate (guards.ts), not just a login flag: every
  // endpoint except change-password/logout/me/refresh answers 403 PASSWORD_CHANGE_REQUIRED until rotated.
  const gatedApi = await inj('GET', '/api/ledger/trial-balance', adminTok);
  ok('A5/R0-3: must-change user blocked from business APIs (403 PASSWORD_CHANGE_REQUIRED)',
    gatedApi.status === 403 && gatedApi.json.error?.code === 'PASSWORD_CHANGE_REQUIRED', `${gatedApi.status} ${gatedApi.json.error?.code}`);
  const gatedMe = await inj('GET', '/api/auth/me', adminTok);
  ok('A5/R0-3: /api/auth/me still reachable for the must-change user (UI can render state)',
    gatedMe.status === 200, `${gatedMe.status}`);
  const badChange = await inj('POST', '/api/auth/change-password', adminTok, { current_password: 'wrong', new_password: 'newpass12' });
  ok('Change-password with wrong current → 400', badChange.status === 400 && badChange.json.error?.code === 'BAD_CURRENT_PASSWORD', `${badChange.status} ${badChange.json.error?.code}`);
  const change = await inj('POST', '/api/auth/change-password', adminTok, { current_password: 'admin123', new_password: 'newadminpass1' });
  ok('Change-password (correct current) → 200 ok', change.status === 200 && change.json.ok === true, `${change.status}`);
  const a2 = await login('admin', 'newadminpass1');
  ok('Re-login with new password → must_change_password cleared', a2.status === 200 && a2.json.must_change_password === false, JSON.stringify({ st: a2.status, mcp: a2.json.must_change_password }));
  const oldLogin = await login('admin', 'admin123');
  ok('Old password no longer works (401)', oldLogin.status === 401, `${oldLogin.status}`);

  // ── 4b. docs/27 R2-2 — an authorization change revokes outstanding sessions immediately ──
  // Permissions ride the JWT claim, so narrowing a user's overrides must not wait out the token TTL:
  // PATCH /api/admin/users bumps tokens_valid_from → the pre-change token dies NOW (TOKEN_REVOKED) and a
  // fresh login carries the narrowed permission set.
  const preChangeTok = (await login('planuser', 'planpass1')).json.token;
  const preOk = await inj('GET', '/api/ai/kb/search?q=hours', preChangeTok);
  const permPatch = await inj('PATCH', '/api/admin/users/planuser', a2.json.token, { permissions: ['dashboard'] });
  ok('R2-2: permission update accepted + reports sessions_revoked', (permPatch.status === 200 || permPatch.status === 201) && permPatch.json.sessions_revoked === true, `${permPatch.status} ${JSON.stringify(permPatch.json)}`);
  const staleTok = await inj('GET', '/api/ai/kb/search?q=hours', preChangeTok);
  ok('R2-2: pre-change token rejected immediately (401 TOKEN_REVOKED, not TTL-lagged)',
    preOk.status !== 401 && staleTok.status === 401 && staleTok.json.error?.code === 'TOKEN_REVOKED', `pre=${preOk.status} post=${staleTok.status} ${staleTok.json.error?.code}`);
  const freshLogin = await login('planuser', 'planpass1');
  ok('R2-2: fresh login works with the narrowed permission set', freshLogin.status === 200, `${freshLogin.status}`);

  // ── 5. Step 10: feature flags / Labs ──
  const ff = await inj('GET', '/api/feature-flags', owner);
  const consol = (ff.json.flags ?? []).find((f: any) => f.key === 'consolidation');
  const labs0 = (ff.json.flags ?? []).find((f: any) => f.key === 'labs_visible');
  ok('Feature flags: LABS module consolidation default off; labs_visible default off', consol?.tier === 'LABS' && consol?.enabled === false && labs0?.enabled === false && labs0?.source === 'default', JSON.stringify({ consol: consol?.enabled, labs: labs0?.enabled }));
  const setLabs = await inj('PUT', '/api/feature-flags/labs_visible', owner, { enabled: true });
  const labs1 = (setLabs.json.flags ?? []).find((f: any) => f.key === 'labs_visible');
  ok('Feature flags: enable labs_visible → override on', labs1?.enabled === true && labs1?.source === 'override', JSON.stringify(labs1 ?? {}));
  const badFlag = await inj('PUT', '/api/feature-flags/nonsense', owner, { enabled: true });
  ok('Feature flags: unknown flag → 400 UNKNOWN_FLAG', badFlag.status === 400 && badFlag.json.error?.code === 'UNKNOWN_FLAG', `${badFlag.status} ${badFlag.json.error?.code}`);
  const ffAdmin = await inj('GET', '/api/feature-flags', a2.json.token);
  ok('Feature flags: RLS — HQ admin tenant unaffected by the other tenant override (labs_visible still off)', (ffAdmin.json.flags ?? []).find((f: any) => f.key === 'labs_visible')?.enabled === false, JSON.stringify((ffAdmin.json.flags ?? []).find((f: any) => f.key === 'labs_visible') ?? {}));

  console.log('\n── A4+A5 — Onboarding / provisioning / password ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} onboarding checks failed` : `\n✅ All ${checks.length} onboarding checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
