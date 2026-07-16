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

  // ── 3b3. Pentest remediation (2026-07-16) — the "only the platform owner may grant Admin" control
  //         (assertCanGrantRole) must have NO side doors. Three paths previously reached Admin/god authority
  //         without passing through it; each is now closed. ──
  // P1 — a password reset is a privileged-access grant over the TARGET account. A non-platform Admin cannot
  //      reset another Admin's password (would seize a peer Admin account + inherit its bypass); only the
  //      platform owner can. Resetting a non-privileged user is unchanged.
  const resetAdminDenied = await inj('POST', '/api/admin/users/god_made_admin/reset-password', platLogin.json.token, { password: 'hijacked12345' });
  ok('P1: a non-platform Admin cannot reset an Admin account password (403 ADMIN_GRANT_DENIED)', resetAdminDenied.status === 403 && resetAdminDenied.json.error?.code === 'ADMIN_GRANT_DENIED', `${resetAdminDenied.status} ${resetAdminDenied.json.error?.code}`);
  const resetSalesOk = await inj('POST', '/api/admin/users/platco_sales/reset-password', platLogin.json.token, { password: 'admin123' });
  ok('P1: a company Admin CAN still reset a non-Admin user password (granularity preserved)', (resetSalesOk.status === 200 || resetSalesOk.status === 201) && resetSalesOk.json.reset === true, `${resetSalesOk.status} ${JSON.stringify(resetSalesOk.json)}`);
  const resetAdminByGod = await inj('POST', '/api/admin/users/god_made_admin/reset-password', owner, { password: 'admin123' });
  ok('P1: the platform owner CAN reset an Admin account (2xx)', (resetAdminByGod.status === 200 || resetAdminByGod.status === 201) && resetAdminByGod.json.reset === true, `${resetAdminByGod.status}`);

  // P2 — the SSO JIT default_role allow-list excludes privileged roles, so an AccessAdmin/Admin cannot
  //      configure SSO to auto-provision itself an Admin (a second bypass of the Admin-grant control).
  const ssoAdminDenied = await inj('PUT', '/api/platform/identity', platLogin.json.token, { default_role: 'Admin' });
  ok('P2: SSO default_role cannot be set to Admin (400 BAD_ROLE)', ssoAdminDenied.status === 400 && ssoAdminDenied.json.error?.code === 'BAD_ROLE', `${ssoAdminDenied.status} ${ssoAdminDenied.json.error?.code}`);
  const ssoAccessAdminDenied = await inj('PUT', '/api/platform/identity', platLogin.json.token, { default_role: 'AccessAdmin' });
  ok('P2: SSO default_role cannot be set to AccessAdmin either (400 BAD_ROLE)', ssoAccessAdminDenied.status === 400 && ssoAccessAdminDenied.json.error?.code === 'BAD_ROLE', `${ssoAccessAdminDenied.status} ${ssoAccessAdminDenied.json.error?.code}`);
  const ssoSalesOk = await inj('PUT', '/api/platform/identity', platLogin.json.token, { default_role: 'Sales' });
  ok('P2: SSO default_role CAN still be a non-privileged role (Sales, 200)', ssoSalesOk.status === 200 && ssoSalesOk.json.default_role === 'Sales', `${ssoSalesOk.status} ${JSON.stringify(ssoSalesOk.json?.error ?? ssoSalesOk.json?.default_role ?? '')}`);

  // P3 — an API key ADOPTS its minting human's identity (security review H-2). A key minted by the platform
  //      owner must NOT thereby become an MFA-free "god" credential: PlatformAdminGuard rejects machine
  //      principals outright, even when created_by is a platform owner.
  const godKey = (await inj('POST', '/api/platform/api-keys', owner, { name: 'god-key', scopes: ['exec'] })).json.key;
  const keyHitsPlatform = await inj('GET', '/api/admin/tenants', godKey);
  ok('P3: a platform-owner-minted API key is NOT a platform-admin credential (403 PLATFORM_ADMIN_REQUIRED)', keyHitsPlatform.status === 403 && keyHitsPlatform.json.error?.code === 'PLATFORM_ADMIN_REQUIRED', `${keyHitsPlatform.status} ${keyHitsPlatform.json.error?.code}`);
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
  // ── 3b4. B1 (docs/50 Track B): SME provisioning folds the sidebar from the company's INDUSTRY —
  //         the industry nav profile (@ierp/shared nav-profiles) is stamped into tenants.sme_prefs at
  //         creation and surfaced on /api/auth/me as sme_hidden_nav_groups + sme_open_nav_groups. ──
  const b1Resto = await inj('POST', '/api/admin/tenants', owner, {
    company_name: 'ครัวคนเดียว', tenant_code: 'b1resto', admin_username: 'b1_resto_owner', admin_password: 'resto12345',
    email: 'b1r@x.co', control_profile: 'sme', industry: 'restaurant',
  });
  ok('B1: god provisions an SME restaurant company (201, control_profile=sme, industry=restaurant)',
    b1Resto.status === 201 && b1Resto.json.control_profile === 'sme' && b1Resto.json.industry === 'restaurant',
    `${b1Resto.status} cp=${b1Resto.json.control_profile} ind=${b1Resto.json.industry}`);
  const b1RestoTok = (await login('b1_resto_owner', 'resto12345')).json.token;
  const b1RestoMe = await inj('GET', '/api/auth/me', b1RestoTok);
  ok('B1: restaurant SME /api/auth/me carries the industry fold profile (hidden ⊇ projects; open ⊇ POS frontline)',
    b1RestoMe.status === 200
      && (b1RestoMe.json.sme_hidden_nav_groups ?? []).includes('nav.group.projects')
      && (b1RestoMe.json.sme_open_nav_groups ?? []).includes('nav.group.pos_sales')
      && (b1RestoMe.json.sme_open_nav_groups ?? []).includes('nav.sub.pos_frontline'),
    JSON.stringify({ hidden: b1RestoMe.json.sme_hidden_nav_groups, open: b1RestoMe.json.sme_open_nav_groups }));
  // A later god sme-prefs edit owns hidden_nav_groups but must PRESERVE the stamped industry open profile.
  const b1PrefsEdit = await inj('POST', `/api/admin/tenants/${b1Resto.json.tenant_id}/sme-prefs`, owner, { hidden_nav_groups: ['nav.group.hr'] });
  const b1RestoMe2 = await inj('GET', '/api/auth/me', b1RestoTok);
  ok('B1: a god sme-prefs edit replaces hidden_nav_groups but preserves the stamped open_nav_groups',
    b1PrefsEdit.status === 200
      && (b1RestoMe2.json.sme_hidden_nav_groups ?? []).includes('nav.group.hr')
      && !(b1RestoMe2.json.sme_hidden_nav_groups ?? []).includes('nav.group.projects')
      && (b1RestoMe2.json.sme_open_nav_groups ?? []).includes('nav.sub.pos_frontline'),
    JSON.stringify({ hidden: b1RestoMe2.json.sme_hidden_nav_groups, open: b1RestoMe2.json.sme_open_nav_groups }));
  // A different industry gets a different fold (distribution: POS domains hidden, procurement open).
  const b1Dist = await inj('POST', '/api/admin/tenants', owner, {
    company_name: 'ค้าส่งคนเดียว', tenant_code: 'b1dist', admin_username: 'b1_dist_owner', admin_password: 'dist12345',
    email: 'b1d@x.co', control_profile: 'sme', industry: 'distribution',
  });
  const b1DistMe = await inj('GET', '/api/auth/me', (await login('b1_dist_owner', 'dist12345')).json.token);
  ok('B1: distribution SME gets its own industry fold (hidden ⊇ pos_sales; open ⊇ procurement)',
    b1Dist.status === 201
      && (b1DistMe.json.sme_hidden_nav_groups ?? []).includes('nav.group.pos_sales')
      && (b1DistMe.json.sme_open_nav_groups ?? []).includes('nav.group.procurement'),
    JSON.stringify({ hidden: b1DistMe.json.sme_hidden_nav_groups, open: b1DistMe.json.sme_open_nav_groups }));
  // Enterprise regression: a non-SME company's /me carries NO nav profile fields at all.
  const b1EntMe = await inj('GET', '/api/auth/me', platLogin.json.token);
  ok('B1: an ENTERPRISE company /api/auth/me carries no SME nav profile (behaviour unchanged)',
    b1EntMe.status === 200 && b1EntMe.json.control_profile !== 'sme'
      && b1EntMe.json.sme_open_nav_groups === undefined && b1EntMe.json.sme_hidden_nav_groups === undefined,
    JSON.stringify({ cp: b1EntMe.json.control_profile, open: b1EntMe.json.sme_open_nav_groups }));

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

  // ── 3g2. Tenant factory-reset: god wipes a pilot company's test data. Permanent lifecycle operation,
  //         triple-gated — god-only, the company must be SUSPENDED first (409 TENANT_NOT_SUSPENDED — the
  //         two-step that makes an active company unwipeable: suspend → reset → reactivate), and the
  //         company code must be typed (400 CONFIRM_MISMATCH). The wipe deletes every tenant-scoped row
  //         EXCEPT identity/billing/audit, re-seeds fiscal year + CoA, and never touches a sibling. ──
  // Seed test data into LifeCo: the starter-pack HQ branch + a manual JE (needs the provisioned periods).
  await inj('POST', '/api/tenant/starter-pack', lcTok, {});
  await inj('PATCH', '/api/tenant/profile', lcTok, { address_line1: '9 ถนนรอง', province: 'กรุงเทพมหานคร', postal_code: '10120' });
  await inj('POST', '/api/ledger/journal', lcTok, { date: `${year}-06-20`, source: 'TEST', lines: [{ account_code: '1000', debit: 50 }, { account_code: '4000', credit: 50 }] });
  // The 2026-07-13 OSHINEI reset outage: a TENANTLESS line-item child (cust_pos_items has no tenant_id
  // column) referencing a tenant-scoped parent was invisible to the wipe loop's tenant_id enumeration and
  // permanently blocked the parent's DELETE → FACTORY_RESET_BLOCKED. Seed that exact shape so the reset
  // must clear it via the FK-child walk in tenant-wipe.ts.
  await pg.query(`INSERT INTO cust_pos_sales (sale_no, sale_date, tenant_id, subtotal, discount, tax_amount, total, payment_method, status, created_by)
    VALUES ('SALE-FR-1', '${year}-06-20', ${lcTid}, '100', '0', '0', '100', 'Cash', 'Completed', 'lifeco_admin')`);
  await pg.query(`INSERT INTO cust_pos_items (sale_id, item_id, item_description, qty, uom, unit_price, amount, discount_pct, is_custom)
    SELECT id, 'A', 'Apple', '1', 'EA', '100', '100', '0', false FROM cust_pos_sales WHERE sale_no='SALE-FR-1'`);
  // The 2026-07-13 Amber reset outage (second bug): goods_receipts↔gr_items are BOTH tenant-scoped, but
  // gr_items FK-references goods_receipts and sorts AFTER it alphabetically. The old savepoint-retry loop
  // relied on catching the failed goods_receipts DELETE and retrying next round — which PGlite honours but
  // postgres-js does NOT (a failed statement poisons the whole tx), so prod raised a raw FK 500 while CI
  // stayed green. Seed the exact shape so the reset must delete gr_items BEFORE goods_receipts (topo order).
  await pg.query(`INSERT INTO goods_receipts (gr_no, gr_date, tenant_id, received_by) VALUES ('GR-FR-1', '${year}-06-20', ${lcTid}, 'lifeco_admin')`);
  await pg.query(`INSERT INTO gr_items (gr_id, tenant_id, po_no, item_id, received_qty, uom) SELECT id, ${lcTid}, 'PO-FR-1', 'A', '1', 'EA' FROM goods_receipts WHERE gr_no='GR-FR-1'`);
  // Third bug: append-only immutability triggers (GL_IMMUTABLE on a Posted journal_entries row,
  // approval_actions_immutable on any approval_actions row) RAISE on DELETE and block the wipe. The wipe
  // sets app.tenant_wipe='on' (migration 0402) so those triggers skip their block. Seed both directly
  // (Posted status + an approval action) so the reset must delete through the immutability guard.
  await pg.query(`INSERT INTO journal_entries (entry_no, entry_date, source, status, tenant_id) VALUES ('JE-POSTED-FR', '${year}-06-20', 'TEST', 'Posted', ${lcTid})`);
  await pg.query(`INSERT INTO journal_lines (entry_id, account_code, debit, credit, tenant_id) SELECT id, '1000', '25', '0', ${lcTid} FROM journal_entries WHERE entry_no='JE-POSTED-FR'`);
  await pg.query(`INSERT INTO workflow_instances (tenant_id, doc_type, doc_no, created_by) VALUES (${lcTid}, 'PO', 'WF-FR-1', 'lifeco_admin')`);
  await pg.query(`INSERT INTO approval_actions (tenant_id, instance_id, step_no, actor, decision) SELECT ${lcTid}, id, 1, 'lifeco_admin', 'approve' FROM workflow_instances WHERE doc_no='WF-FR-1'`);
  const preCounts = (await pg.query(`SELECT (SELECT count(*)::int FROM branches WHERE tenant_id=${lcTid}) b,
    (SELECT count(*)::int FROM journal_entries WHERE tenant_id=${lcTid}) j,
    (SELECT count(*)::int FROM gr_items WHERE tenant_id=${lcTid}) gri,
    (SELECT count(*)::int FROM cust_pos_items ci JOIN cust_pos_sales cs ON ci.sale_id=cs.id WHERE cs.tenant_id=${lcTid}) ci`)).rows[0] as any;
  ok('Factory-reset setup: LifeCo holds test data (branch + JE + POS TENANTLESS child + GR tenant-scoped child)', preCounts.b >= 1 && preCounts.j >= 1 && preCounts.ci >= 1 && preCounts.gri >= 1, JSON.stringify(preCounts));

  process.env.PLATFORM_ADMIN_USERNAMES = 'owner1';
  const frActive = await inj('POST', `/api/admin/tenants/${lcTid}/factory-reset`, owner, { confirm: 'lifeco1' });
  ok('Factory reset on an ACTIVE (non-suspended) company → 409 TENANT_NOT_SUSPENDED (two-step safety)', frActive.status === 409 && frActive.json.error?.code === 'TENANT_NOT_SUSPENDED', `${frActive.status} ${frActive.json.error?.code}`);

  process.env.PLATFORM_ADMIN_USERNAMES = ''; // owner1 no longer god → guard must deny before anything runs
  const frNonGod = await inj('POST', `/api/admin/tenants/${lcTid}/factory-reset`, owner, { confirm: 'lifeco1' });
  ok('Factory reset blocked for a non-platform-admin (403)', frNonGod.status === 403, `${frNonGod.status}`);

  process.env.PLATFORM_ADMIN_USERNAMES = 'owner1';
  await inj('POST', `/api/admin/tenants/${lcTid}/suspend`, owner, { reason: 'pre-reset (UAT done)' });
  const frBadConfirm = await inj('POST', `/api/admin/tenants/${lcTid}/factory-reset`, owner, { confirm: 'wrong-code' });
  ok('Factory reset with a wrong typed code → 400 CONFIRM_MISMATCH', frBadConfirm.status === 400 && frBadConfirm.json.error?.code === 'CONFIRM_MISMATCH', `${frBadConfirm.status} ${frBadConfirm.json.error?.code}`);

  const otherBranchesBefore = Number((await pg.query(`SELECT count(*)::int n FROM branches WHERE tenant_id=${newTid}`)).rows[0]!.n);
  const fr = await inj('POST', `/api/admin/tenants/${lcTid}/factory-reset`, owner, { confirm: 'lifeco1' });
  ok('Factory reset (god + suspended + typed code) → 200 status=reset with rows_deleted>0', fr.status === 200 && fr.json.status === 'reset' && Number(fr.json.rows_deleted) > 0, `${fr.status} ${JSON.stringify(fr.json)}`);
  const post = (await pg.query(
    `SELECT (SELECT count(*)::int FROM branches WHERE tenant_id=${lcTid}) b,
            (SELECT count(*)::int FROM journal_entries WHERE tenant_id=${lcTid}) j,
            (SELECT count(*)::int FROM fiscal_periods WHERE tenant_id=${lcTid}) fp,
            (SELECT count(*)::int FROM users WHERE tenant_id=${lcTid}) u,
            (SELECT count(*)::int FROM subscriptions WHERE tenant_id=${lcTid}) sub,
            (SELECT count(*)::int FROM audit_log WHERE tenant_id=${lcTid}) al,
            (SELECT count(*)::int FROM cust_pos_sales WHERE tenant_id=${lcTid}) cs,
            (SELECT count(*)::int FROM cust_pos_items WHERE item_description='Apple') ci,
            (SELECT count(*)::int FROM goods_receipts WHERE tenant_id=${lcTid}) gr,
            (SELECT count(*)::int FROM gr_items WHERE tenant_id=${lcTid}) gri,
            (SELECT count(*)::int FROM approval_actions WHERE tenant_id=${lcTid}) aa,
            (SELECT count(*)::int FROM branches WHERE tenant_id=${newTid}) ob`)).rows[0] as any;
  ok('Reset wiped LifeCo data (branches + JEs = 0) and re-seeded 12 fiscal periods', post.b === 0 && post.j === 0 && post.fp === 12, JSON.stringify(post));
  ok('Reset cleared the TENANTLESS FK child too (cust_pos_items via cust_pos_sales — the OSHINEI blocker)', post.cs === 0 && post.ci === 0, JSON.stringify({ cs: post.cs, ci: post.ci }));
  ok('Reset cleared the tenant-scoped FK child in child-first order (gr_items before goods_receipts — the Amber blocker)', post.gr === 0 && post.gri === 0, JSON.stringify({ gr: post.gr, gri: post.gri }));
  ok('Reset deleted APPEND-ONLY rows through the immutability guard (Posted JE + approval_actions — app.tenant_wipe bypass)', post.j === 0 && post.aa === 0, JSON.stringify({ j: post.j, aa: post.aa }));
  ok('Reset PRESERVED identity/billing/audit (users, subscription, audit_log rows survive)', post.u >= 1 && post.sub >= 1 && post.al >= 1, JSON.stringify({ u: post.u, sub: post.sub, al: post.al }));
  ok('Reset did NOT touch the sibling tenant (its branches unchanged)', post.ob === otherBranchesBefore, `before=${otherBranchesBefore} after=${post.ob}`);
  const reactAfterReset = await inj('POST', `/api/admin/tenants/${lcTid}/reactivate`, owner, {});
  ok('Reactivate after reset → active again (suspend → reset → reactivate completes)', reactAfterReset.status === 200 && reactAfterReset.json.status === 'active', `${reactAfterReset.status}`);
  const lcRelogin = await login('lifeco_admin', 'lifeco12345');
  const lcAccess = await inj('GET', '/api/tenant/onboarding-status', lcRelogin.json.token);
  ok('The company Admin logs in and works after reset+reactivate (identity preserved)', lcRelogin.status === 200 && !!lcRelogin.json.token && lcAccess.status === 200, `login=${lcRelogin.status} access=${lcAccess.status}`);
  process.env.PLATFORM_ADMIN_USERNAMES = ''; // restore

  // ── 3g3. Tenant soft-delete (migration 0386): lighter than factory-reset — flags the tenant row
  //         WITHOUT touching business data. Same two-step safety (suspend → delete), god-only, typed
  //         company code. Deleted users are blocked (TENANT_DELETED) even if later reactivated (only
  //         restoreTenant clears it); the company drops out of listTenants() until restored. ──
  process.env.PLATFORM_ADMIN_USERNAMES = 'owner1';
  const delActive = await inj('POST', `/api/admin/tenants/${lcTid}/delete`, owner, { confirm: 'lifeco1' });
  ok('Delete on an ACTIVE (non-suspended) company → 409 TENANT_NOT_SUSPENDED', delActive.status === 409 && delActive.json.error?.code === 'TENANT_NOT_SUSPENDED', `${delActive.status} ${delActive.json.error?.code}`);

  process.env.PLATFORM_ADMIN_USERNAMES = ''; // owner1 no longer god → guard must deny before anything runs
  const delNonGod = await inj('POST', `/api/admin/tenants/${lcTid}/delete`, owner, { confirm: 'lifeco1' });
  ok('Delete blocked for a non-platform-admin (403)', delNonGod.status === 403, `${delNonGod.status}`);

  process.env.PLATFORM_ADMIN_USERNAMES = 'owner1';
  await inj('POST', `/api/admin/tenants/${lcTid}/suspend`, owner, { reason: 'pre-delete (pure test tenant)' });
  const delBadConfirm = await inj('POST', `/api/admin/tenants/${lcTid}/delete`, owner, { confirm: 'wrong-code' });
  ok('Delete with a wrong typed code → 400 CONFIRM_MISMATCH', delBadConfirm.status === 400 && delBadConfirm.json.error?.code === 'CONFIRM_MISMATCH', `${delBadConfirm.status} ${delBadConfirm.json.error?.code}`);

  const preDelCounts = (await pg.query(`SELECT (SELECT count(*)::int FROM users WHERE tenant_id=${lcTid}) u`)).rows[0] as any;
  const del = await inj('POST', `/api/admin/tenants/${lcTid}/delete`, owner, { confirm: 'lifeco1' });
  ok('Delete (god + suspended + typed code) → 200 status=deleted', del.status === 200 && del.json.status === 'deleted', `${del.status} ${JSON.stringify(del.json)}`);
  const postDelCounts = (await pg.query(`SELECT (SELECT count(*)::int FROM users WHERE tenant_id=${lcTid}) u`)).rows[0] as any;
  ok('Delete does NOT touch business data (unlike factory-reset — user rows unchanged)', postDelCounts.u === preDelCounts.u, JSON.stringify({ pre: preDelCounts.u, post: postDelCounts.u }));

  const delAgain = await inj('POST', `/api/admin/tenants/${lcTid}/delete`, owner, { confirm: 'lifeco1' });
  ok('Deleting an already-deleted company → 409 TENANT_ALREADY_DELETED', delAgain.status === 409 && delAgain.json.error?.code === 'TENANT_ALREADY_DELETED', `${delAgain.status} ${delAgain.json.error?.code}`);

  const listDefault = await inj('GET', '/api/admin/tenants', owner);
  ok('Deleted company drops out of the default company list', listDefault.status === 200 && !(listDefault.json as any[]).some((c: any) => c.id === lcTid), `${listDefault.status}`);
  const listIncl = await inj('GET', '/api/admin/tenants?include_deleted=1', owner);
  ok('include_deleted=1 shows the deleted company (flagged)', listIncl.status === 200 && (listIncl.json as any[]).some((c: any) => c.id === lcTid && c.deleted === true), `${listIncl.status}`);

  // Reactivate the SUSPENDED-and-deleted company: TENANT_DELETED must still win over TENANT_SUSPENDED
  // clearing — reactivate does not implicitly restore, so login stays blocked, now for the deleted reason.
  await inj('POST', `/api/admin/tenants/${lcTid}/reactivate`, owner, {});
  const delAccessBlocked = await inj('GET', '/api/tenant/onboarding-status', lcTok);
  ok('A deleted (even reactivated) company Admin is BLOCKED (403 TENANT_DELETED)', delAccessBlocked.status === 403 && delAccessBlocked.json.error?.code === 'TENANT_DELETED', `${delAccessBlocked.status} ${delAccessBlocked.json.error?.code}`);
  await inj('POST', `/api/admin/tenants/${lcTid}/suspend`, owner, { reason: 're-suspend for restore test' }); // put back to the pre-reactivate state

  const restoreNonDel = await inj('POST', `/api/admin/tenants/${newTid}/restore`, owner, {});
  ok('Restoring a non-deleted company → 409 TENANT_NOT_DELETED', restoreNonDel.status === 409 && restoreNonDel.json.error?.code === 'TENANT_NOT_DELETED', `${restoreNonDel.status} ${restoreNonDel.json.error?.code}`);

  const restore = await inj('POST', `/api/admin/tenants/${lcTid}/restore`, owner, {});
  ok('Restore (god-only) → 200 status=restored', restore.status === 200 && restore.json.status === 'restored', `${restore.status} ${JSON.stringify(restore.json)}`);
  const listAfterRestore = await inj('GET', '/api/admin/tenants', owner);
  ok('Restored company reappears in the default list', listAfterRestore.status === 200 && (listAfterRestore.json as any[]).some((c: any) => c.id === lcTid), `${listAfterRestore.status}`);
  const stillSuspendedAccess = await inj('GET', '/api/tenant/onboarding-status', lcTok);
  ok('Restore does NOT auto-reactivate — still 403 TENANT_SUSPENDED (separate reactivate required)', stillSuspendedAccess.status === 403 && stillSuspendedAccess.json.error?.code === 'TENANT_SUSPENDED', `${stillSuspendedAccess.status} ${stillSuspendedAccess.json.error?.code}`);
  const finalReact = await inj('POST', `/api/admin/tenants/${lcTid}/reactivate`, owner, {});
  const finalLogin = await login('lifeco_admin', 'lifeco12345');
  const finalAccess = await inj('GET', '/api/tenant/onboarding-status', finalLogin.json.token);
  ok('After restore + reactivate, the company Admin works normally again', finalReact.status === 200 && finalAccess.status === 200, `react=${finalReact.status} access=${finalAccess.status}`);
  process.env.PLATFORM_ADMIN_USERNAMES = ''; // restore

  // ── 3g4. Tenant PURGE (migration 0386): IRREVERSIBLE, gated behind an already-soft-deleted company
  //         (delete → purge, mirroring suspend → reset). Wipes every OTHER tenant-scoped row (business
  //         data, users, subscriptions, AI/usage meters) but ALWAYS preserves audit_log (ITGC-AC-16
  //         append-only chain — an explicit product decision) and therefore the tenants row itself, which
  //         survives solely as that chain's anchor. ──
  process.env.PLATFORM_ADMIN_USERNAMES = 'owner1';
  await inj('POST', `/api/admin/tenants/${lcTid}/suspend`, owner, { reason: 'pre-purge' });
  await inj('POST', `/api/admin/tenants/${lcTid}/delete`, owner, { confirm: 'lifeco1' });
  const auditBefore = Number((await pg.query(`SELECT count(*)::int n FROM audit_log WHERE tenant_id=${lcTid}`)).rows[0]!.n);
  ok('Purge setup: LifeCo has existing audit_log history', auditBefore >= 1, `n=${auditBefore}`);

  const purgeNotDeleted = await inj('POST', `/api/admin/tenants/${newTid}/purge`, owner, { confirm: 'shoptest' });
  ok('Purge on a NON-deleted company → 409 TENANT_NOT_DELETED (delete → purge two-step)', purgeNotDeleted.status === 409 && purgeNotDeleted.json.error?.code === 'TENANT_NOT_DELETED', `${purgeNotDeleted.status} ${purgeNotDeleted.json.error?.code}`);

  process.env.PLATFORM_ADMIN_USERNAMES = ''; // owner1 no longer god → guard must deny before anything runs
  const purgeNonGod = await inj('POST', `/api/admin/tenants/${lcTid}/purge`, owner, { confirm: 'lifeco1' });
  ok('Purge blocked for a non-platform-admin (403)', purgeNonGod.status === 403, `${purgeNonGod.status}`);

  process.env.PLATFORM_ADMIN_USERNAMES = 'owner1';
  const purgeBadConfirm = await inj('POST', `/api/admin/tenants/${lcTid}/purge`, owner, { confirm: 'wrong-code' });
  ok('Purge with a wrong typed code → 400 CONFIRM_MISMATCH', purgeBadConfirm.status === 400 && purgeBadConfirm.json.error?.code === 'CONFIRM_MISMATCH', `${purgeBadConfirm.status} ${purgeBadConfirm.json.error?.code}`);

  const purge = await inj('POST', `/api/admin/tenants/${lcTid}/purge`, owner, { confirm: 'lifeco1' });
  ok('Purge (god + soft-deleted + typed code) → 200 status=purged', purge.status === 200 && purge.json.status === 'purged' && Number(purge.json.rows_deleted) > 0, `${purge.status} ${JSON.stringify(purge.json)}`);

  const purgeAgain = await inj('POST', `/api/admin/tenants/${lcTid}/purge`, owner, { confirm: 'lifeco1' });
  ok('Purging an already-purged company → 409 TENANT_ALREADY_PURGED', purgeAgain.status === 409 && purgeAgain.json.error?.code === 'TENANT_ALREADY_PURGED', `${purgeAgain.status} ${purgeAgain.json.error?.code}`);

  const purgePost = (await pg.query(
    `SELECT (SELECT count(*)::int FROM tenants WHERE id=${lcTid}) t,
            (SELECT purged_at IS NOT NULL FROM tenants WHERE id=${lcTid}) purged,
            (SELECT count(*)::int FROM users WHERE tenant_id=${lcTid}) u,
            (SELECT count(*)::int FROM subscriptions WHERE tenant_id=${lcTid}) sub,
            (SELECT count(*)::int FROM audit_log WHERE tenant_id=${lcTid}) al,
            (SELECT count(*)::int FROM branches WHERE tenant_id=${newTid}) ob`)).rows[0] as any;
  ok('Purge kept the tenants row alive (audit_log anchor)', purgePost.t === 1 && purgePost.purged === true, JSON.stringify(purgePost));
  ok('Purge deleted users + subscriptions (permanent, no login possible)', purgePost.u === 0 && purgePost.sub === 0, JSON.stringify({ u: purgePost.u, sub: purgePost.sub }));
  ok('Purge PRESERVED audit_log (ITGC-AC-16 — never erased, even on purge)', purgePost.al >= auditBefore, `before=${auditBefore} after=${purgePost.al}`);
  ok('Purge did NOT touch the sibling tenant (its branches unchanged)', purgePost.ob === otherBranchesBefore, `before=${otherBranchesBefore} after=${purgePost.ob}`);

  const listAfterPurge = await inj('GET', '/api/admin/tenants?include_deleted=1', owner);
  const purgedRow = (listAfterPurge.json as any[]).find((c: any) => c.id === lcTid);
  ok('Purged company still appears under include_deleted=1, flagged purged', listAfterPurge.status === 200 && !!purgedRow && purgedRow.purged === true, `${listAfterPurge.status} ${JSON.stringify(purgedRow)}`);

  const restoreAfterPurge = await inj('POST', `/api/admin/tenants/${lcTid}/restore`, owner, {});
  ok('Restore on a purged company → 409 TENANT_PURGED (irreversible)', restoreAfterPurge.status === 409 && restoreAfterPurge.json.error?.code === 'TENANT_PURGED', `${restoreAfterPurge.status} ${restoreAfterPurge.json.error?.code}`);

  const purgedLogin = await login('lifeco_admin', 'lifeco12345');
  ok('The purged company Admin can no longer log in at all (user row deleted, 401)', purgedLogin.status === 401, `${purgedLogin.status}`);

  // ── 3g5. Global item-master GC (unused-item purge). `items` is a SHARED master (no tenant_id), so
  //         factory-reset/purge — which clear only tenant_id-scoped tables — never touch it: a wiped
  //         company's catalogue rows survive and keep showing in EVERY tenant's /shop. The platform owner
  //         garbage-collects items NO tenant references any more; an item another company still uses (here HQ
  //         has GC-USED on a PO line) is kept. Cross-tenant view is essential — computed under the
  //         @PlatformAdmin full RLS bypass, never per-company. ──
  await db.insert(s.items).values([
    { itemId: 'GC-USED', itemDescription: 'referenced by a surviving tenant (HQ)' },
    { itemId: 'GC-ORPHAN', itemDescription: 'no references anywhere' },
    { itemId: 'GC-IMG', itemDescription: 'orphan that also owns an image row' },
  ]).onConflictDoNothing();
  await db.insert(s.itemImages).values([{ itemId: 'GC-IMG', dataUrl: 'data:image/png;base64,AAAA' }]).onConflictDoNothing();
  await db.insert(s.poItems).values([{ tenantId: hq, itemId: 'GC-USED', orderQty: '1', unitPrice: '10' }]).onConflictDoNothing();

  process.env.PLATFORM_ADMIN_USERNAMES = ''; // owner is momentarily NOT a platform admin
  const gcDenied = await inj('GET', '/api/admin/item-maintenance/unused-items', owner);
  ok('Unused-items preview blocked for a non-platform-admin (403)', gcDenied.status === 403, `${gcDenied.status} ${gcDenied.json.error?.code}`);
  process.env.PLATFORM_ADMIN_USERNAMES = 'owner1';

  const gcPreview = await inj('GET', '/api/admin/item-maintenance/unused-items', owner);
  const gcIds: string[] = gcPreview.json.item_ids ?? [];
  ok('Unused-items preview lists the orphans but NOT the HQ-referenced item',
    gcPreview.status === 200 && gcIds.includes('GC-ORPHAN') && gcIds.includes('GC-IMG') && !gcIds.includes('GC-USED'),
    `orphan=${gcIds.includes('GC-ORPHAN')} img=${gcIds.includes('GC-IMG')} used=${gcIds.includes('GC-USED')} total=${gcPreview.json.total} refCols=${gcPreview.json.ref_columns}`);
  const usedBeforePurge = (await db.select().from(s.items).where(eq(s.items.itemId, 'GC-USED'))).length;
  const orphanBeforePurge = (await db.select().from(s.items).where(eq(s.items.itemId, 'GC-ORPHAN'))).length;
  ok('Preview is a dry-run — nothing deleted yet', usedBeforePurge === 1 && orphanBeforePurge === 1, JSON.stringify({ usedBeforePurge, orphanBeforePurge }));
  // Diagnostic: kept_by attributes each surviving (referenced) item to the company whose data keeps it alive —
  // here HQ, which holds GC-USED on a PO line. Reveals whether leftover shop items are a reset-leftover of the
  // viewed company or genuinely in use by another company.
  const gcHqKept = (gcPreview.json.kept_by ?? []).find((k: any) => Number(k.tenant_id) === hq);
  ok('Preview kept_by attributes a still-referenced item to the company that uses it (HQ ← GC-USED on a PO)',
    Array.isArray(gcPreview.json.kept_by) && !!gcHqKept && gcHqKept.items >= 1,
    `kept_by=${JSON.stringify((gcPreview.json.kept_by ?? []).slice(0, 4))}`);

  const gcBad = await inj('POST', '/api/admin/item-maintenance/purge-unused-items', owner, { confirm: 'nope' });
  ok('Purge with a wrong confirm phrase → 400 CONFIRM_MISMATCH', gcBad.status === 400 && gcBad.json.error?.code === 'CONFIRM_MISMATCH', `${gcBad.status} ${gcBad.json.error?.code}`);

  const gcPurge = await inj('POST', '/api/admin/item-maintenance/purge-unused-items', owner, { confirm: 'PURGE-UNUSED-ITEMS' });
  const gcPurged: string[] = gcPurge.json.item_ids ?? [];
  ok('Purge (god + confirm) → 200 status=purged, collects the orphans not the HQ-referenced item',
    gcPurge.status === 200 && gcPurge.json.status === 'purged' && gcPurged.includes('GC-ORPHAN') && gcPurged.includes('GC-IMG') && !gcPurged.includes('GC-USED'),
    `${gcPurge.status} items_deleted=${gcPurge.json.items_deleted} images_deleted=${gcPurge.json.images_deleted}`);
  const orphanGone = (await db.select().from(s.items).where(eq(s.items.itemId, 'GC-ORPHAN'))).length === 0;
  const imgItemGone = (await db.select().from(s.items).where(eq(s.items.itemId, 'GC-IMG'))).length === 0;
  const imgRowGone = (await db.select().from(s.itemImages).where(eq(s.itemImages.itemId, 'GC-IMG'))).length === 0;
  const usedKept = (await db.select().from(s.items).where(eq(s.items.itemId, 'GC-USED'))).length === 1;
  ok('Purge deleted the orphan + its image row, KEPT the still-referenced item', orphanGone && imgItemGone && imgRowGone && usedKept,
    JSON.stringify({ orphanGone, imgItemGone, imgRowGone, usedKept }));

  const gcAgain = await inj('POST', '/api/admin/item-maintenance/purge-unused-items', owner, { confirm: 'PURGE-UNUSED-ITEMS' });
  ok('Purge is idempotent — the collected orphans are not re-reported on a second run',
    gcAgain.status === 200 && !(gcAgain.json.item_ids ?? []).includes('GC-ORPHAN'), `items_deleted=${gcAgain.json.items_deleted}`);

  // ── 3g6. FORCE purge — GC-USED survives the normal purge (HQ references it on a PO). Force purge deletes it
  //         anyway, wiping the cross-tenant reference. Blast-radius preview shows HQ; strong confirm required. ──
  const fpPreview = await inj('POST', '/api/admin/item-maintenance/force-preview', owner, { item_ids: ['GC-USED'] });
  const fpHq = (fpPreview.json.by_tenant ?? []).find((k: any) => Number(k.tenant_id) === hq);
  ok('Force-preview shows the blast radius per company (HQ loses its GC-USED PO line)',
    fpPreview.status === 200 && fpPreview.json.items === 1 && !!fpHq && fpHq.ref_rows >= 1 && fpPreview.json.total_ref_rows >= 1,
    `items=${fpPreview.json.items} total_ref_rows=${fpPreview.json.total_ref_rows} by=${JSON.stringify((fpPreview.json.by_tenant ?? []).slice(0, 3))}`);
  const fpBad = await inj('POST', '/api/admin/item-maintenance/force-purge', owner, { item_ids: ['GC-USED'], confirm: 'PURGE-UNUSED-ITEMS' });
  ok('Force-purge rejects the normal confirm phrase (needs the stronger FORCE-PURGE-ITEMS) → 400', fpBad.status === 400 && fpBad.json.error?.code === 'CONFIRM_MISMATCH', `${fpBad.status} ${fpBad.json.error?.code}`);
  const poBefore = (await db.select().from(s.poItems).where(eq(s.poItems.itemId, 'GC-USED'))).length;
  const fpPurge = await inj('POST', '/api/admin/item-maintenance/force-purge', owner, { item_ids: ['GC-USED'], confirm: 'FORCE-PURGE-ITEMS' });
  ok('Force-purge (god + strong confirm) deletes the referenced item AND its cross-tenant reference rows',
    fpPurge.status === 200 && fpPurge.json.status === 'force_purged' && fpPurge.json.items_deleted === 1 && fpPurge.json.ref_rows_deleted >= 1,
    `${fpPurge.status} ${JSON.stringify({ items: fpPurge.json.items_deleted, refs: fpPurge.json.ref_rows_deleted, blocked: fpPurge.json.blocked })}`);
  const usedGoneNow = (await db.select().from(s.items).where(eq(s.items.itemId, 'GC-USED'))).length === 0;
  const poGoneNow = (await db.select().from(s.poItems).where(eq(s.poItems.itemId, 'GC-USED'))).length === 0;
  ok('Force-purge removed the item and its PO line (nothing dangles)', usedGoneNow && poGoneNow, JSON.stringify({ usedGoneNow, poGoneNow, poBefore }));

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
