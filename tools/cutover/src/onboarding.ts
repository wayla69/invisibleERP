/**
 * A4+A5 — tenant onboarding/provisioning + force-change password, over PGlite.
 * signup auto-provisions fiscal periods + captures identity; /api/tenant/profile read+write;
 * seeded-admin must_change_password gate + /api/auth/change-password.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover onboarding
 */
import 'reflect-metadata';
import { authenticator } from 'otplib';
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
    return { status: res.statusCode, json, body: res.body }; // body: raw text for non-JSON responses (A4 printable docs)
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

  // ── 3b4. Privilege-escalation audit (2026-07-17, PE-1/PE-2): the `users` permission grants capability
  //         BOUNDED by the grantor's OWN — a least-privilege AccessAdmin (holds only `users`) cannot silently
  //         escalate, whether via an API-key scope (PE-1) or by provisioning a transacting puppet account
  //         (PE-2, which is routed to a second admin for approval — not blocked, so delegated admin still works). ──
  await db.insert(s.users).values([{ username: 'pe_iam', passwordHash: await pw.hash('peiam12345'), role: 'AccessAdmin', tenantId: hq }]).onConflictDoNothing();
  const iam = (await login('pe_iam', 'peiam12345')).json.token;
  // PE-2 — an AccessAdmin provisioning a role BEYOND its own set (GlAccountant ⇒ gl_post) is STAGED for a
  // different admin (two-person control), not applied. (customer_name=HQ keeps the staged row in-tenant.)
  const escGrant = await inj('POST', '/api/admin/users', iam, { username: 'iam_puppet', password: 'puppet12345', role: 'GlAccountant', customer_name: 'HQ' });
  ok('PE-2: AccessAdmin provisioning a transacting role is STAGED for approval, not applied', escGrant.json?.pending === true && !!escGrant.json?.access_exception_req_no, `${escGrant.status} ${JSON.stringify(escGrant.json)}`);
  const puppetLogin = await login('iam_puppet', 'puppet12345');
  ok('PE-2: the escalated puppet account was NOT created (cannot log in)', puppetLogin.status === 401, `${puppetLogin.status}`);
  // An Admin is unaffected (holds all perms) — proven by the existing grants above (platco_admin/owner create
  // Sales/Admin directly). PE-1 — an AccessAdmin cannot mint an API key whose scopes exceed its own perms.
  const escKey = await inj('POST', '/api/platform/api-keys', iam, { name: 'esc-key', scopes: ['gl_post'] });
  ok('PE-1: AccessAdmin cannot mint an API key with scopes beyond its perms (403 KEY_SCOPE_EXCEEDS_GRANTOR)', escKey.status === 403 && escKey.json.error?.code === 'KEY_SCOPE_EXCEEDS_GRANTOR', `${escKey.status} ${escKey.json.error?.code}`);
  const okKey = await inj('POST', '/api/platform/api-keys', iam, { name: 'iam-key', scopes: ['users'] });
  ok('PE-1: AccessAdmin CAN mint a key within its own permissions (users scope)', !!okKey.json?.key, `${okKey.status}`);
  // PE-1 (refinement) — a public-API-ONLY scope (`catalog:read`, not an internal permission) is not an
  // escalation and may be minted by any `users`-holder for integration.
  const pubKey = await inj('POST', '/api/platform/api-keys', iam, { name: 'iam-pub', scopes: ['catalog:read'] });
  ok('PE-1: AccessAdmin CAN mint a public-API-only scope key (catalog:read — not an internal permission)', !!pubKey.json?.key, `${pubKey.status}`);
  // PE-6 — the platform MFA surface must NOT silently re-enrol/downgrade an already-enrolled account (no
  // step-up). Enrol once (setup → verify), then a second setup is refused (must disable first, needs password+TOTP).
  const pmSetup = await inj('POST', '/api/platform/mfa/setup', iam);
  await inj('POST', '/api/platform/mfa/verify', iam, { token: authenticator.generate(pmSetup.json.secret) });
  const pmReenrol = await inj('POST', '/api/platform/mfa/setup', iam);
  ok('PE-6: platform mfa/setup refuses to re-enrol an MFA-enabled account (400 MFA_ALREADY_ENABLED)', pmReenrol.status === 400 && pmReenrol.json.error?.code === 'MFA_ALREADY_ENABLED', `${pmReenrol.status} ${pmReenrol.json.error?.code}`);
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
  // ── 3b4. B1 (docs/51 Track B): SME provisioning folds the sidebar from the company's INDUSTRY —
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

  // ── 3b5. B3 (docs/51 Track B): the starter pack seeds an SME industry kit — tenant-scoped sample
  //         content matching the B1 nav (restaurant: menu + dining tables; distribution: WH branch),
  //         idempotent, and NEVER touches the shared `items` master. Enterprise: HQ-only (pre-B3). ──
  const b3Resto1 = await inj('POST', '/api/tenant/starter-pack', b1RestoTok, {});
  ok('B3: restaurant SME starter-pack seeds HQ + sample menu + dining tables',
    b3Resto1.status === 201
      && ['hq_branch', 'menu_starter', 'dining_tables'].every((k) => (b3Resto1.json.created ?? []).includes(k)),
    JSON.stringify(b3Resto1.json));
  const b3RestoRows = (await pg.query(`SELECT (SELECT count(*)::int FROM menu_items WHERE tenant_id=${b1Resto.json.tenant_id}) AS menu, (SELECT count(*)::int FROM dining_tables WHERE tenant_id=${b1Resto.json.tenant_id}) AS tables, (SELECT count(*)::int FROM items WHERE item_id LIKE 'DEMO-%') AS shared_items`)).rows as any[];
  ok('B3: kit rows are tenant-scoped (menu 2, tables 4) and the SHARED items master got NOTHING',
    b3RestoRows[0].menu === 2 && b3RestoRows[0].tables === 4 && b3RestoRows[0].shared_items === 0,
    JSON.stringify(b3RestoRows[0]));
  const b3Resto2 = await inj('POST', '/api/tenant/starter-pack', b1RestoTok, {});
  ok('B3: second starter-pack call skips every kit piece (idempotent)',
    b3Resto2.status === 201
      && ['hq_branch', 'menu_starter', 'dining_tables'].every((k) => (b3Resto2.json.skipped ?? []).includes(k))
      && (b3Resto2.json.created ?? []).length === 0,
    JSON.stringify(b3Resto2.json));
  const b3Dist = await inj('POST', '/api/tenant/starter-pack', (await login('b1_dist_owner', 'dist12345')).json.token, {});
  ok('B3: distribution SME kit seeds the WH1 warehouse branch instead',
    b3Dist.status === 201 && (b3Dist.json.created ?? []).includes('wh_branch') && !(b3Dist.json.created ?? []).includes('menu_starter'),
    JSON.stringify(b3Dist.json));
  const b3Ent = await inj('POST', '/api/tenant/starter-pack', platLogin.json.token, {});
  ok('B3: an ENTERPRISE company starter-pack stays HQ-only (no industry kit)',
    b3Ent.status === 201
      && ((b3Ent.json.created ?? []).includes('hq_branch') || (b3Ent.json.skipped ?? []).includes('hq_branch'))
      && ['menu_starter', 'dining_tables', 'wh_branch', 'demo_project'].every((k) => !(b3Ent.json.created ?? []).includes(k) && !(b3Ent.json.skipped ?? []).includes(k)),
    JSON.stringify(b3Ent.json));
  // The remaining two industries: retail gets a POS sample catalog (type 'retail', no dining tables);
  // services gets a demo project (no menu kit at all).
  const b3Retail = await inj('POST', '/api/admin/tenants', owner, {
    company_name: 'ร้านค้าคนเดียว', tenant_code: 'b1retail', admin_username: 'b1_retail_owner', admin_password: 'retail12345',
    email: 'b1rt@x.co', control_profile: 'sme', industry: 'retail',
  });
  const b3RetailSp = await inj('POST', '/api/tenant/starter-pack', (await login('b1_retail_owner', 'retail12345')).json.token, {});
  const b3RetailRows = (await pg.query(`SELECT count(*)::int AS n FROM menu_items WHERE tenant_id=${Number(b3Retail.json.tenant_id) || 0} AND type='retail'`)).rows as any[];
  ok('B3: retail SME kit seeds 2 sample POS items (type retail) and NO dining tables',
    b3RetailSp.status === 201 && (b3RetailSp.json.created ?? []).includes('menu_starter')
      && !(b3RetailSp.json.created ?? []).includes('dining_tables') && !(b3RetailSp.json.skipped ?? []).includes('dining_tables')
      && b3RetailRows[0].n === 2,
    JSON.stringify({ resp: b3RetailSp.json, retailItems: b3RetailRows[0].n }));
  const b3Svc = await inj('POST', '/api/admin/tenants', owner, {
    company_name: 'ที่ปรึกษาคนเดียว', tenant_code: 'b1svc', admin_username: 'b1_svc_owner', admin_password: 'svc12345678',
    email: 'b1sv@x.co', control_profile: 'sme', industry: 'services',
  });
  const b3SvcSp = await inj('POST', '/api/tenant/starter-pack', (await login('b1_svc_owner', 'svc12345678')).json.token, {});
  const b3SvcRows = (await pg.query(`SELECT count(*)::int AS n FROM projects WHERE tenant_id=${Number(b3Svc.json.tenant_id) || 0} AND project_code='PRJ-DEMO'`)).rows as any[];
  ok('B3: services SME kit seeds the demo project and NO menu kit',
    b3SvcSp.status === 201 && (b3SvcSp.json.created ?? []).includes('demo_project')
      && !(b3SvcSp.json.created ?? []).includes('menu_starter') && b3SvcRows[0].n === 1,
    JSON.stringify({ resp: b3SvcSp.json, demoProjects: b3SvcRows[0].n }));

  // Expanded industries (2026-07-18): each new industry maps to one of the four seed kinds. Spot-check one
  // per kind — ecommerce→catalog, manufacturing→warehouse, construction→project, hospitality→catalog+tables.
  const b3Ecom = await inj('POST', '/api/admin/tenants', owner, {
    company_name: 'ร้านออนไลน์คนเดียว', tenant_code: 'b1ecom', admin_username: 'b1_ecom_owner', admin_password: 'ecom12345',
    email: 'b1ec@x.co', control_profile: 'sme', industry: 'ecommerce',
  });
  const b3EcomSp = await inj('POST', '/api/tenant/starter-pack', (await login('b1_ecom_owner', 'ecom12345')).json.token, {});
  ok('B3: ecommerce SME kit seeds a POS catalog (no tables)',
    b3EcomSp.status === 201 && (b3EcomSp.json.created ?? []).includes('menu_starter') && !(b3EcomSp.json.created ?? []).includes('dining_tables'),
    JSON.stringify(b3EcomSp.json));
  const b3Mfg = await inj('POST', '/api/admin/tenants', owner, {
    company_name: 'โรงงานคนเดียว', tenant_code: 'b1mfg', admin_username: 'b1_mfg_owner', admin_password: 'mfg1234567',
    email: 'b1mf@x.co', control_profile: 'sme', industry: 'manufacturing',
  });
  const b3MfgSp = await inj('POST', '/api/tenant/starter-pack', (await login('b1_mfg_owner', 'mfg1234567')).json.token, {});
  ok('B3: manufacturing SME kit seeds a WH1 warehouse (no menu kit)',
    b3MfgSp.status === 201 && (b3MfgSp.json.created ?? []).includes('wh_branch') && !(b3MfgSp.json.created ?? []).includes('menu_starter'),
    JSON.stringify(b3MfgSp.json));
  const b3Con = await inj('POST', '/api/admin/tenants', owner, {
    company_name: 'ผู้รับเหมาคนเดียว', tenant_code: 'b1con', admin_username: 'b1_con_owner', admin_password: 'con1234567',
    email: 'b1co@x.co', control_profile: 'sme', industry: 'construction',
  });
  const b3ConSp = await inj('POST', '/api/tenant/starter-pack', (await login('b1_con_owner', 'con1234567')).json.token, {});
  ok('B3: construction SME kit seeds the demo project (no menu kit)',
    b3ConSp.status === 201 && (b3ConSp.json.created ?? []).includes('demo_project') && !(b3ConSp.json.created ?? []).includes('menu_starter'),
    JSON.stringify(b3ConSp.json));

  // Onboarding industry packs (E1) also cover the new industries — applying one seeds its custom objects.
  const b3MfgPack = await inj('POST', '/api/onboarding/apply-pack', (await login('b1_mfg_owner', 'mfg1234567')).json.token, { pack: 'manufacturing' });
  ok('E1: the manufacturing industry pack seeds its custom objects (BOM + work center)',
    b3MfgPack.status === 201 && b3MfgPack.json.objects_created === 2,
    JSON.stringify(b3MfgPack.json));

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
  // 0451 — the request carries the /plans pack selection: MARKETING pack id 'growth' (→ real plan code
  // 'business' via PACK_TO_PLAN), annual billing, one real add-on + one junk value (dropped, not rejected).
  const reqBody = {
    company_name: 'QueueCo', tenant_code: 'queueco1', admin_username: 'queueco_admin', admin_password: 'queueco12345', email: 'q@c.com',
    requested_plan: 'growth', requested_billing: 'annual', requested_addons: ['cdp', 'bogus_addon'],
  };
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
  // 0451 — the queue row shows the carried pack: mapped to the REAL plan code, junk add-on dropped.
  const rrow = (rlist.json.requests ?? []).find((r: any) => r.id === reqId) ?? {};
  ok('Queue row carries requested plan business (mapped from pack growth) · annual · addons=[cdp]',
    rrow.requested_plan === 'business' && rrow.requested_interval === 'annual'
    && Array.isArray(rrow.requested_addons) && rrow.requested_addons.length === 1 && rrow.requested_addons[0] === 'cdp',
    `plan=${rrow.requested_plan} interval=${rrow.requested_interval} addons=${JSON.stringify(rrow.requested_addons)}`);
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
  // 0451 — approve HONOURS the carried pack: the provisioned subscription is on the requested plan,
  // billing interval, and purchased add-ons (not the legacy 'free' default).
  const qSub = (await pg.query(
    `SELECT s.plan_code, s.billing_interval, s.addons FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id WHERE t.code='queueco1' ORDER BY s.created_at DESC LIMIT 1`,
  )).rows as any[];
  ok('Approve provisions the REQUESTED pack: plan business · annual · addons=[cdp] on the subscription',
    qSub.length === 1 && qSub[0].plan_code === 'business' && qSub[0].billing_interval === 'annual'
    && Array.isArray(qSub[0].addons) && qSub[0].addons.length === 1 && qSub[0].addons[0] === 'cdp',
    `plan=${qSub[0]?.plan_code} interval=${qSub[0]?.billing_interval} addons=${JSON.stringify(qSub[0]?.addons)}`);
  // 0451 — the seeded catalogue now carries the Franchise tier (the /plans configurator's 4th pack).
  const franchisePlan = (await pg.query(`SELECT code, price_monthly::numeric n FROM plans WHERE code='franchise'`)).rows as any[];
  ok('Plan catalogue seeds the franchise tier at ฿14,900/mo', franchisePlan.length === 1 && Number(franchisePlan[0].n) === 14900, `rows=${franchisePlan.length} price=${franchisePlan[0]?.n}`);
  const reApprove = await inj('POST', `/api/admin/signup-requests/${reqId}/approve`, owner, {});
  ok('Re-approving a handled request → 409 REQUEST_NOT_PENDING', reApprove.status === 409 && reApprove.json.error?.code === 'REQUEST_NOT_PENDING', `${reApprove.status} ${reApprove.json.error?.code}`);
  const req2 = await inj('POST', '/api/auth/signup-requests', undefined, { company_name: 'RejectCo', tenant_code: 'rejectco1', admin_username: 'rejectco_admin', admin_password: 'rejectco12345', email: 'r@c.com' });
  const rej = await inj('POST', `/api/admin/signup-requests/${req2.json.request_id}/reject`, owner, { reason: 'not a fit' });
  ok('Reject → status rejected (no tenant created)', rej.status === 200 && rej.json.status === 'rejected', `${rej.status}`);

  // ── 3d-bis. A1 transactional email: every onboarding decision lands in the platform_emails outbox
  //            (Queued), the god deliver-pending sweep delivers via the mock provider (MAIL_PROVIDER
  //            unset ⇒ no network), and the outbox is god-only. The background worker delivers the same
  //            rows in production; the sweep makes it deterministic here. ──
  const outboxDenied = await inj('GET', '/api/admin/emails', qLogin.json.token);
  ok('A1: the email outbox is platform-admin only (403 for a company Admin)', outboxDenied.status === 403, `${outboxDenied.status}`);
  const outbox1 = await inj('GET', '/api/admin/emails', owner);
  const mailRows = (outbox1.json.emails ?? []) as any[];
  const invMail = mailRows.find((m) => m.template === 'signup_invite' && m.to_email === 'i@c.com');
  const apprMail = mailRows.find((m) => m.template === 'signup_approved' && m.to_email === 'q@c.com');
  const rejMail = mailRows.find((m) => m.template === 'signup_rejected' && m.to_email === 'r@c.com');
  ok('A1: invite + approval + rejection each queued an outbox email (status Queued)',
    outbox1.status === 200 && !!invMail && !!apprMail && !!rejMail
    && [invMail, apprMail, rejMail].every((m) => m.status === 'Queued'),
    `st=${outbox1.status} inv=${invMail?.status} appr=${apprMail?.status} rej=${rejMail?.status}`);
  ok('A1: the approval email is pinned to the provisioned company (about_tenant_id) with a login link subject',
    Number(apprMail?.about_tenant_id) === Number(approve.json.tenant_id) && String(apprMail?.subject ?? '').includes('QueueCo'),
    `about=${apprMail?.about_tenant_id} tid=${approve.json.tenant_id} subj=${apprMail?.subject}`);
  const sweep = await inj('POST', '/api/admin/emails/deliver-pending', owner, {});
  ok('A1: deliver-pending sweep delivers every queued email (mock provider, 0 failed)',
    sweep.status === 200 && sweep.json.attempted >= 3 && sweep.json.sent >= 3 && sweep.json.failed === 0,
    JSON.stringify(sweep.json));
  const outbox2 = await inj('GET', '/api/admin/emails', owner);
  const outboxAfter = (outbox2.json.emails ?? []) as any[];
  const sentSet = [invMail, apprMail, rejMail].map((m) => outboxAfter.find((x) => x.id === m?.id));
  ok('A1: the three onboarding emails are Sent with provider=mock + a provider message id',
    sentSet.every((m) => m?.status === 'Sent' && m?.provider === 'mock' && !!m?.provider_msg_id && !!m?.sent_at),
    sentSet.map((m) => `${m?.template}=${m?.status}/${m?.provider}`).join(' '));

  // ── 3g-bis. A2 SaaS lifecycle automation: the daily sweep (god POST /api/admin/saas-lifecycle/run —
  //            the BI 'saas_lifecycle' job runs the same code) sends trial reminders, auto-suspends an
  //            expired paid trial after grace, walks the PastDue dunning ladder, activates ฿0 plans, and
  //            is idempotent via saas_lifecycle_events dedup keys. ──
  const lcCreate = await inj('POST', '/api/admin/tenants', owner, {
    company_name: 'LifecycleCo', tenant_code: 'lifecyc1', admin_username: 'lifecyc_admin', admin_password: 'lifecyc12345', email: 'life@c.com', plan_code: 'business',
  });
  ok('A2: fixture company provisioned on a paid plan (Trialing)', lcCreate.status === 201 && !!lcCreate.json.tenant_id, `${lcCreate.status}`);
  const lcTid2 = Number(lcCreate.json.tenant_id);
  // T-1 window (half-day offset — midnight-safe): first run fires BOTH reminders once; second run fires nothing.
  await pg.query(`UPDATE subscriptions SET trial_ends_at = now() + interval '12 hours' WHERE tenant_id=${lcTid2}`);
  const run1 = await inj('POST', '/api/admin/saas-lifecycle/run', owner, {});
  ok('A2: T-1 sweep fires both trial reminders once (trial_reminder_7 + trial_reminder_1)',
    run1.status === 200 && run1.json.actions?.trial_reminder_7 === 1 && run1.json.actions?.trial_reminder_1 === 1,
    JSON.stringify(run1.json.actions));
  const run2 = await inj('POST', '/api/admin/saas-lifecycle/run', owner, {});
  ok('A2: an immediate re-run is a no-op for this tenant (dedup keys hold)',
    run2.status === 200 && !run2.json.actions?.trial_reminder_7 && !run2.json.actions?.trial_reminder_1, JSON.stringify(run2.json.actions));
  const remMail = ((await inj('GET', '/api/admin/emails', owner)).json.emails ?? []).filter((m: any) => m.template === 'trial_reminder' && m.to_email === 'life@c.com');
  ok('A2: the trial reminders emailed the company contact (2 outbox rows)', remMail.length === 2, `rows=${remMail.length}`);
  // Expired past grace → auto-suspend with attribution + email + still-idempotent.
  await pg.query(`UPDATE subscriptions SET trial_ends_at = now() - interval '10 days' WHERE tenant_id=${lcTid2}`);
  const run3 = await inj('POST', '/api/admin/saas-lifecycle/run', owner, {});
  const lcTen = (await pg.query(`SELECT suspended_at, suspended_by, suspend_reason FROM tenants WHERE id=${lcTid2}`)).rows[0] as any;
  ok('A2: an expired paid trial past grace is auto-suspended with attribution',
    run3.json.actions?.trial_suspended === 1 && !!lcTen.suspended_at && lcTen.suspended_by === 'saas_lifecycle (auto)' && /trial expired/.test(lcTen.suspend_reason ?? ''),
    `actions=${JSON.stringify(run3.json.actions)} by=${lcTen.suspended_by}`);
  const suspMail = ((await inj('GET', '/api/admin/emails', owner)).json.emails ?? []).find((m: any) => m.template === 'company_suspended' && m.to_email === 'life@c.com');
  ok('A2: the auto-suspension emailed the company (company_suspended queued)', !!suspMail, `found=${!!suspMail}`);
  const run4 = await inj('POST', '/api/admin/saas-lifecycle/run', owner, {});
  ok('A2: a suspended company is skipped by later sweeps', run4.json.actions?.trial_suspended == null, JSON.stringify(run4.json.actions));
  // PastDue dunning ladder on a reactivated company: dunning_1 now; backdate the anchor → suspend at day 21+.
  await inj('POST', `/api/admin/tenants/${lcTid2}/reactivate`, owner, {});
  await pg.query(`UPDATE subscriptions SET status='PastDue', trial_ends_at=NULL WHERE tenant_id=${lcTid2}`);
  const run5 = await inj('POST', '/api/admin/saas-lifecycle/run', owner, {});
  ok('A2: PastDue starts the dunning ladder (dunning_1 + payment_failed email)',
    run5.json.actions?.dunning_1 === 1
    && ((await inj('GET', '/api/admin/emails', owner)).json.emails ?? []).some((m: any) => m.template === 'payment_failed' && m.to_email === 'life@c.com'),
    JSON.stringify(run5.json.actions));
  await pg.query(`UPDATE saas_lifecycle_events SET created_at = now() - interval '22 days' WHERE event='dunning_1' AND about_tenant_id=${lcTid2}`);
  const run6 = await inj('POST', '/api/admin/saas-lifecycle/run', owner, {});
  const lcTen2 = (await pg.query(`SELECT suspended_at, suspend_reason FROM tenants WHERE id=${lcTid2}`)).rows[0] as any;
  ok('A2: dunning exhausted (≥21d) auto-suspends with the past-due reason',
    run6.json.actions?.pastdue_suspended === 1 && !!lcTen2.suspended_at && /past due/.test(lcTen2.suspend_reason ?? ''),
    `actions=${JSON.stringify(run6.json.actions)} reason=${lcTen2.suspend_reason}`);
  // Recovery: reactivate + Active → the ladder closes (dunning_cleared) so a later PastDue restarts fresh.
  await inj('POST', `/api/admin/tenants/${lcTid2}/reactivate`, owner, {});
  await pg.query(`UPDATE subscriptions SET status='Active' WHERE tenant_id=${lcTid2}`);
  const run7 = await inj('POST', '/api/admin/saas-lifecycle/run', owner, {});
  ok('A2: recovery to Active closes the dunning cycle (dunning_cleared)', run7.json.actions?.dunning_cleared === 1, JSON.stringify(run7.json.actions));
  // ฿0 plan at expiry → activated, never suspended.
  await pg.query(`UPDATE subscriptions SET status='Trialing', plan_code='free', trial_ends_at = now() - interval '2 days' WHERE tenant_id=${lcTid2}`);
  const run8 = await inj('POST', '/api/admin/saas-lifecycle/run', owner, {});
  const lcSub = (await pg.query(`SELECT status FROM subscriptions WHERE tenant_id=${lcTid2}`)).rows[0] as any;
  ok('A2: an expired ฿0-plan trial activates (free tier continues; no suspension)',
    run8.json.actions?.trial_free_activated === 1 && lcSub.status === 'Active', `actions=${JSON.stringify(run8.json.actions)} status=${lcSub.status}`);
  const lcEvents = await inj('GET', '/api/admin/saas-lifecycle/events', owner);
  ok('A2: the lifecycle event ledger records every action (god-only feed)',
    lcEvents.status === 200 && (lcEvents.json.events ?? []).filter((e: any) => e.about_tenant_id === lcTid2).length >= 6,
    `events=${(lcEvents.json.events ?? []).filter((e: any) => e.about_tenant_id === lcTid2).length}`);
  const lcDenied = await inj('GET', '/api/admin/saas-lifecycle/events', qLogin.json.token);
  ok('A2: the lifecycle feed + run are platform-admin only (403 for a company Admin)', lcDenied.status === 403, `${lcDenied.status}`);

  // ── 3g-ter. A3 add-on billing: tenant self-serve purchase (POST /api/billing/addons — always the
  //            CALLER'S OWN tenant) + checkout carrying add-ons as priced line items (annual = 10×
  //            monthly; plan-included add-ons cost nothing; THB-only; unknown keys fail closed). ──
  const lcLogin = await login('lifecyc_admin', 'lifecyc12345');
  const addonBad = await inj('POST', '/api/billing/addons', lcLogin.json.token, { addons: ['cdp', 'bogus_addon'] });
  ok('A3: self-serve add-ons refuse unknown keys (400 UNKNOWN_ADDON)', addonBad.status === 400 && addonBad.json.error?.code === 'UNKNOWN_ADDON', `${addonBad.status} ${addonBad.json.error?.code}`);
  const addonSet = await inj('POST', '/api/billing/addons', lcLogin.json.token, { addons: ['cdp', 'sandbox'] });
  ok('A3: self-serve add-on purchase applies to the caller\'s own tenant (entitlement-only in mock mode)',
    addonSet.status === 200 && Array.isArray(addonSet.json.addons) && addonSet.json.addons.length === 2 && addonSet.json.billing?.mock === true,
    JSON.stringify(addonSet.json));
  const ownSub = await inj('GET', '/api/billing/subscription', lcLogin.json.token);
  ok('A3: GET /api/billing/subscription reflects the purchased add-ons', JSON.stringify((ownSub.json.addons ?? []).slice().sort()) === JSON.stringify(['cdp', 'sandbox']), JSON.stringify(ownSub.json.addons));
  const queueAddons = (await pg.query(`SELECT s.addons FROM subscriptions s JOIN tenants t ON t.id=s.tenant_id WHERE t.code='queueco1'`)).rows[0] as any;
  ok('A3: another tenant\'s add-ons are untouched (BOLA-safe: own tenant only)', JSON.stringify(queueAddons.addons) === JSON.stringify(['cdp']), JSON.stringify(queueAddons.addons));
  const coBad = await inj('POST', '/api/billing/checkout', lcLogin.json.token, { plan_code: 'business', interval: 'annual', addons: ['cdp', 'bogus_addon'] });
  ok('A3: checkout refuses unknown add-on keys (400 UNKNOWN_ADDON)', coBad.status === 400 && coBad.json.error?.code === 'UNKNOWN_ADDON', `${coBad.status} ${coBad.json.error?.code}`);
  const coUsd = await inj('POST', '/api/billing/checkout', lcLogin.json.token, { plan_code: 'pro', currency: 'USD', addons: ['cdp'] });
  ok('A3: a non-THB checkout carrying add-ons fails closed (400 ADDON_CURRENCY_UNSUPPORTED)', coUsd.status === 400 && coUsd.json.error?.code === 'ADDON_CURRENCY_UNSUPPORTED', `${coUsd.status} ${coUsd.json.error?.code}`);
  const coAnnual = await inj('POST', '/api/billing/checkout', lcLogin.json.token, { plan_code: 'business', interval: 'annual', addons: ['cdp'] });
  ok('A3: annual checkout prices the add-on at 10× monthly and totals plan + add-ons (49,000 + 12,900)',
    coAnnual.status < 300 && coAnnual.json.mock === true && coAnnual.json.addons?.[0]?.key === 'cdp' && Number(coAnnual.json.addons?.[0]?.amount) === 12900 && Number(coAnnual.json.total_amount) === 61900,
    JSON.stringify({ addons: coAnnual.json.addons, total: coAnnual.json.total_amount }));
  const coIncluded = await inj('POST', '/api/billing/checkout', lcLogin.json.token, { plan_code: 'franchise', interval: 'annual', addons: ['sandbox'] });
  ok('A3: an add-on the target plan already includes is dropped from the charge (franchise ⊇ sandbox)',
    coIncluded.status < 300 && (coIncluded.json.addons ?? []).length === 0 && Number(coIncluded.json.total_amount) === 149000,
    JSON.stringify({ addons: coIncluded.json.addons, total: coIncluded.json.total_amount }));

  // ── 3g-quater. A4 own-SaaS receipts: a Stripe invoice.paid webhook records the platform's receipt
  //               (idempotent on the invoice id) + emails it; god records offline bank transfers; the
  //               tenant lists/downloads ONLY its own receipts (foreign number = 404). MAIL/STRIPE
  //               unset ⇒ mock providers, HTML fallback for the printable document. ──
  await pg.query(`UPDATE subscriptions SET stripe_customer_id='cus_lifetest' WHERE tenant_id=${lcTid2}`);
  const invEvent = { type: 'invoice.paid', data: { object: { id: 'in_test_1', customer: 'cus_lifetest', amount_paid: 490000, created: 1784600000 } } };
  const wh1 = await inj('POST', '/api/billing/stripe/webhook', undefined, invEvent);
  const rcpt1 = (await pg.query(`SELECT receipt_no, amount::numeric a, source, vat_amount FROM saas_receipts WHERE about_tenant_id=${lcTid2}`)).rows as any[];
  ok('A4: invoice.paid webhook records ONE receipt (฿4,900, source stripe_invoice) + re-activates the subscription',
    wh1.status < 300 && wh1.json.handled === true && rcpt1.length === 1 && Number(rcpt1[0].a) === 4900 && rcpt1[0].source === 'stripe_invoice' && /^RCPT-S-\d{6}$/.test(rcpt1[0].receipt_no),
    JSON.stringify({ st: wh1.status, rows: rcpt1 }));
  ok('A4: without RECEIPT_ISSUER_TAX_ID the receipt is plain (no VAT breakdown claimed)', rcpt1[0].vat_amount == null, `vat=${rcpt1[0].vat_amount}`);
  await inj('POST', '/api/billing/stripe/webhook', undefined, invEvent);
  const rcptAfterDup = (await pg.query(`SELECT count(*)::int n FROM saas_receipts WHERE about_tenant_id=${lcTid2}`)).rows[0] as any;
  ok('A4: a re-delivered webhook converges to the SAME receipt (idempotent on the invoice id)', rcptAfterDup.n === 1, `n=${rcptAfterDup.n}`);
  const rcptMail = ((await inj('GET', '/api/admin/emails', owner)).json.emails ?? []).find((m: any) => m.template === 'saas_receipt' && m.to_email === 'life@c.com');
  ok('A4: the receipt was emailed to the company contact (saas_receipt queued)', !!rcptMail && String(rcptMail.subject).includes(rcpt1[0].receipt_no), `subj=${rcptMail?.subject}`);
  const manual = await inj('POST', `/api/admin/tenants/${lcTid2}/receipts`, owner, { amount: 14900, period: '2026-07', note: 'โอนธนาคาร KTB' });
  ok('A4: god records an offline bank-transfer receipt (201, RCPT-S numbering)', manual.status === 201 && manual.json.created === true && /^RCPT-S-\d{6}$/.test(manual.json.receipt_no), JSON.stringify(manual.json));
  const myRcpts = await inj('GET', '/api/billing/receipts', lcLogin.json.token);
  ok('A4: the tenant lists its own receipts (2 — webhook + manual, newest first)',
    myRcpts.status === 200 && (myRcpts.json.receipts ?? []).length === 2 && myRcpts.json.receipts[0].receipt_no === manual.json.receipt_no,
    JSON.stringify((myRcpts.json.receipts ?? []).map((r: any) => r.receipt_no)));
  const pdfRes = await inj('GET', `/api/billing/receipts/${rcpt1[0].receipt_no}/pdf`, lcLogin.json.token);
  ok('A4: the printable receipt renders (HTML fallback in CI) with the Thai title + amount',
    pdfRes.status === 200 && String(pdfRes.body ?? '').includes('ใบเสร็จรับเงิน') && String(pdfRes.body ?? '').includes('4,900.00'),
    `st=${pdfRes.status} len=${String(pdfRes.body ?? '').length}`);
  const bolaRcpt = await inj('GET', `/api/billing/receipts/${rcpt1[0].receipt_no}/pdf`, qLogin.json.token);
  ok('A4: another tenant cannot fetch this receipt (404 — BOLA-safe, not 403)', bolaRcpt.status === 404, `${bolaRcpt.status}`);

  // ── 3g-quinquies. Wave B1: entitlement-observation ledger god read — the triage surface consulted
  //                  BEFORE moving a tenant into the ENTITLEMENTS_ENFORCE_TENANTS cohort. The guard's
  //                  write path is proven in the plan-gating harness; here we prove the endpoint + the
  //                  per-tenant rollup + tenant-name join against the real migrated table (0455). ──
  await pg.query(`INSERT INTO entitlement_observations (day, about_tenant_id, code, mode, route_perms, dedup_key) VALUES
    ('2026-07-20', ${lcTid2}, 'SUITE_NOT_ENTITLED', 'shadow', 'procurement', 'obs-test-1'),
    ('2026-07-21', ${lcTid2}, 'TRIAL_EXPIRED', 'shadow', '', 'obs-test-2')`);
  const obsRes = await inj('GET', '/api/admin/entitlement-observations?days=30', owner);
  const obsSum = (obsRes.json.summary ?? []).find((s: any) => s.tenant_id === lcTid2);
  ok('B1: god reads the observation rollup (per-tenant deny codes + tenant-name join)',
    obsRes.status === 200 && !!obsSum && obsSum.total === 2 && obsSum.codes.includes('SUITE_NOT_ENTITLED') && obsSum.codes.includes('TRIAL_EXPIRED') && typeof obsSum.tenant === 'string',
    JSON.stringify(obsSum ?? obsRes.json).slice(0, 200));
  const obsDenied = await inj('GET', '/api/admin/entitlement-observations', lcLogin.json.token);
  ok('B1: a tenant admin cannot read the observation ledger (403 — god-only)', obsDenied.status === 403, `${obsDenied.status}`);

  // ── 3g-sexies. Wave C — Thai payment rails: payment-info (platform PromptPay QR + bank details, amount
  //               due from plan + add-ons), tenant slip claims (dup-slip fail-closed, own-tenant only),
  //               and the god verify queue (approve → A4 receipt + subscription Active + email; reject →
  //               reasoned email; decided claims immutable). ──
  // Pin the fixture subscription to a known price point (earlier A2/A4 blocks moved it around).
  await pg.query(`UPDATE subscriptions SET plan_code='business', billing_interval='monthly', addons=NULL WHERE tenant_id=${lcTid2}`);
  const infoBare = await inj('GET', '/api/billing/payment-info', lcLogin.json.token);
  ok('C: payment-info without PLATFORM_PROMPTPAY_ID/BANK envs → rails hidden (nulls), amount due still priced',
    infoBare.status === 200 && infoBare.json.qr_payload === null && infoBare.json.bank_details === null && Number(infoBare.json.amount_due) === 4900,
    JSON.stringify({ st: infoBare.status, due: infoBare.json.amount_due, qr: infoBare.json.qr_payload }));
  process.env.PLATFORM_PROMPTPAY_ID = '0812345678';
  process.env.PLATFORM_BANK_ACCOUNT = 'KBank 123-4-56789-0 บจก. อินวิซิเบิล';
  const info = await inj('GET', '/api/billing/payment-info', lcLogin.json.token);
  ok('C: payment-info with envs → dynamic EMVCo PromptPay payload (THB, amount due) + QR image + bank details',
    info.status === 200 && String(info.json.qr_payload).startsWith('000201') && String(info.json.qr_payload).includes('5303764')
    && String(info.json.qr_payload).includes('54074900.00') && String(info.json.qr_image).startsWith('data:image/png')
    && info.json.bank_details.includes('KBank') && info.json.promptpay_id === '0812345678',
    String(info.json.qr_payload));
  const claim1 = await inj('POST', '/api/billing/payment-claims', lcLogin.json.token, { amount: 4900, period: '2026-08', slip_ref: 'TXN-778899', note: 'โอนจาก KBank' });
  ok('C: tenant files a slip claim (201 Pending)', claim1.status === 201 && claim1.json.status === 'Pending', JSON.stringify(claim1.json));
  const dupSlip = await inj('POST', '/api/billing/payment-claims', lcLogin.json.token, { amount: 4900, slip_ref: 'TXN-778899' });
  ok('C: refiling the same slip reference → 400 DUPLICATE_SLIP', dupSlip.status === 400 && dupSlip.json.error?.code === 'DUPLICATE_SLIP', `${dupSlip.status} ${dupSlip.json.error?.code}`);
  const otherClaims = await inj('GET', '/api/billing/payment-claims', qLogin.json.token);
  ok('C: another tenant lists ZERO of these claims (data-leak test)', otherClaims.status === 200 && (otherClaims.json.claims ?? []).length === 0, `n=${(otherClaims.json.claims ?? []).length}`);
  const claimsDenied = await inj('GET', '/api/admin/payment-claims', lcLogin.json.token);
  ok('C: a tenant admin cannot read the verify queue (403 — god-only)', claimsDenied.status === 403, `${claimsDenied.status}`);
  const queue = await inj('GET', '/api/admin/payment-claims?status=Pending', owner);
  const qRow = (queue.json.claims ?? []).find((c: any) => c.slip_ref === 'TXN-778899');
  ok('C: god verify queue lists the pending claim with the tenant name joined', queue.status === 200 && !!qRow && typeof qRow.tenant === 'string', JSON.stringify(qRow ?? queue.json).slice(0, 160));
  await pg.query(`UPDATE subscriptions SET status='PastDue' WHERE tenant_id=${lcTid2}`);
  const rcptMailsBefore = ((await inj('GET', '/api/admin/emails', owner)).json.emails ?? []).filter((m: any) => m.template === 'saas_receipt' && m.to_email === 'life@c.com').length;
  const appr = await inj('POST', `/api/admin/payment-claims/${claim1.json.id}/approve`, owner);
  const subAfter = (await pg.query(`SELECT status FROM subscriptions WHERE tenant_id=${lcTid2}`)).rows[0] as any;
  ok('C: approve → A4 receipt issued (RCPT-S, idempotent on claim:<id>) + subscription re-activated',
    appr.status === 200 && /^RCPT-S-\d{6}$/.test(appr.json.receipt_no) && subAfter.status === 'Active',
    JSON.stringify({ st: appr.status, r: appr.json.receipt_no, sub: subAfter.status }));
  const rcptRow = (await pg.query(`SELECT source, amount::numeric a FROM saas_receipts WHERE source_ref='claim:${claim1.json.id}'`)).rows[0] as any;
  const rcptMailsAfter = ((await inj('GET', '/api/admin/emails', owner)).json.emails ?? []).filter((m: any) => m.template === 'saas_receipt' && m.to_email === 'life@c.com').length;
  ok('C: the receipt row carries source bank_transfer + the claimed amount, and the customer is emailed',
    rcptRow?.source === 'bank_transfer' && Number(rcptRow?.a) === 4900 && rcptMailsAfter === rcptMailsBefore + 1,
    JSON.stringify({ rcptRow, before: rcptMailsBefore, after: rcptMailsAfter }));
  const reAppr = await inj('POST', `/api/admin/payment-claims/${claim1.json.id}/approve`, owner);
  ok('C: a decided claim cannot be re-decided (400 CLAIM_NOT_PENDING)', reAppr.status === 400 && reAppr.json.error?.code === 'CLAIM_NOT_PENDING', `${reAppr.status} ${reAppr.json.error?.code}`);
  const claim2 = await inj('POST', '/api/billing/payment-claims', lcLogin.json.token, { amount: 1500, slip_ref: 'TXN-BAD-1' });
  const payRej = await inj('POST', `/api/admin/payment-claims/${claim2.json.id}/reject`, owner, { reason: 'ไม่พบยอดเงินเข้าตามอ้างอิง' });
  const payRejMail = ((await inj('GET', '/api/admin/emails', owner)).json.emails ?? []).find((m: any) => m.template === 'payment_claim_rejected' && m.to_email === 'life@c.com');
  const myPayClaims = await inj('GET', '/api/billing/payment-claims', lcLogin.json.token);
  const myRej = (myPayClaims.json.claims ?? []).find((c: any) => c.slip_ref === 'TXN-BAD-1');
  ok('C: reject → reasoned email to the customer + the tenant sees status/reason on its own list',
    payRej.status === 200 && !!payRejMail && myRej?.status === 'Rejected' && myRej?.reject_reason === 'ไม่พบยอดเงินเข้าตามอ้างอิง',
    JSON.stringify({ st: payRej.status, mail: !!payRejMail, myRej: myRej?.status }));
  delete process.env.PLATFORM_PROMPTPAY_ID;
  delete process.env.PLATFORM_BANK_ACCOUNT;

  // ── 3g-septies. Wave D — console ops depth: (D1) god-inbox events pushed to PLATFORM_ALERT_EMAIL via
  //                the A1 outbox; (D2) full tenant data export (auto-discovered tenant-scoped tables);
  //                (D3) optional god hardening — IP allowlist + mandatory MFA (fail-closed 403s). ──
  process.env.PLATFORM_ALERT_EMAIL = 'god@platform.co';
  const alertClaim = await inj('POST', '/api/billing/payment-claims', lcLogin.json.token, { amount: 900, slip_ref: 'TXN-ALERT-1' });
  const alertMail = ((await inj('GET', '/api/admin/emails', owner)).json.emails ?? []).find((m: any) => m.template === 'platform_alert' && m.to_email === 'god@platform.co');
  ok('D1: a god-inbox event (payment claim) is ALSO pushed to PLATFORM_ALERT_EMAIL (platform_alert queued)',
    alertClaim.status === 201 && !!alertMail && String(alertMail.subject).includes('แจ้งโอนค่าบริการ'),
    JSON.stringify({ st: alertClaim.status, subj: alertMail?.subject }));
  delete process.env.PLATFORM_ALERT_EMAIL;

  const exportRes = await inj('GET', `/api/admin/tenants/${lcTid2}/export`, owner);
  const exportDoc = (() => { try { return JSON.parse(String(exportRes.body ?? '')); } catch { return exportRes.json; } })();
  ok('D2: full tenant export returns the tenant row + auto-discovered tenant-scoped tables (subscriptions + receipts present)',
    exportRes.status === 200 && exportDoc?.tenant?.id === lcTid2 && !!exportDoc.tables?.subscriptions && !!exportDoc.tables?.saas_receipts
    && exportDoc.table_count > 2 && exportDoc.row_total > 0,
    JSON.stringify({ st: exportRes.status, tables: exportDoc?.table_count, rows: exportDoc?.row_total }));
  const exportDenied = await inj('GET', `/api/admin/tenants/${lcTid2}/export`, lcLogin.json.token);
  ok('D2: a tenant admin cannot export (403 — god-only)', exportDenied.status === 403, `${exportDenied.status}`);

  process.env.PLATFORM_IP_ALLOWLIST = '203.0.113.0/24';
  const ipBlocked = await inj('GET', '/api/admin/payment-claims', owner);
  ok('D3: PLATFORM_IP_ALLOWLIST — a god from outside the allowlist is refused (403 PLATFORM_IP_BLOCKED)',
    ipBlocked.status === 403 && ipBlocked.json.error?.code === 'PLATFORM_IP_BLOCKED', `${ipBlocked.status} ${ipBlocked.json.error?.code}`);
  process.env.PLATFORM_IP_ALLOWLIST = '127.0.0.1, 203.0.113.0/24';
  const ipAllowed = await inj('GET', '/api/admin/payment-claims', owner);
  ok('D3: the loopback entry admits the harness god again (200)', ipAllowed.status === 200, `${ipAllowed.status}`);
  delete process.env.PLATFORM_IP_ALLOWLIST;

  process.env.PLATFORM_REQUIRE_MFA = 'true';
  const mfaBlocked = await inj('GET', '/api/admin/payment-claims', owner);
  ok('D3: PLATFORM_REQUIRE_MFA — a god WITHOUT TOTP enrolled is refused (403 PLATFORM_MFA_REQUIRED)',
    mfaBlocked.status === 403 && mfaBlocked.json.error?.code === 'PLATFORM_MFA_REQUIRED', `${mfaBlocked.status} ${mfaBlocked.json.error?.code}`);
  delete process.env.PLATFORM_REQUIRE_MFA;
  const mfaOffAgain = await inj('GET', '/api/admin/payment-claims', owner);
  ok('D3: with the knob off the god passes again (default behaviour unchanged)', mfaOffAgain.status === 200, `${mfaOffAgain.status}`);

  // ── 3g-octies. Slip pre-fill: the doc-ai slip extractor behind the /billing claim form — deterministic
  //               rules without an AI key (CI honesty ladder), perm `users` (same duty that files claims). ──
  const slipX = await inj('POST', '/api/doc-ai/slip-extract', lcLogin.json.token,
    { text: 'โอนเงินสำเร็จ\nจำนวนเงิน 4,900.00 บาท\nเลขที่รายการ: 014000601034578\n2026-07-21 14:02' });
  ok('Slip pre-fill: deterministic text extraction (amount + transfer ref + date, source rules)',
    slipX.status === 201 || slipX.status === 200
      ? slipX.json.source === 'rules' && slipX.json.fields?.amount === 4900 && slipX.json.fields?.transfer_ref === '014000601034578' && slipX.json.fields?.date === '2026-07-21'
      : false,
    JSON.stringify(slipX.json));
  const slipEmpty = await inj('POST', '/api/doc-ai/slip-extract', lcLogin.json.token,
    { data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' });
  ok('Slip pre-fill: an image without an AI key is honestly EMPTY (source none — never a guess)',
    (slipEmpty.status === 201 || slipEmpty.status === 200) && slipEmpty.json.source === 'none' && slipEmpty.json.fields?.amount === null,
    JSON.stringify(slipEmpty.json));
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
  // The 2026-07-13 INVISIBLE reset outage: a TENANTLESS line-item child (cust_pos_items has no tenant_id
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
  ok('Reset cleared the TENANTLESS FK child too (cust_pos_items via cust_pos_sales — the INVISIBLE blocker)', post.cs === 0 && post.ci === 0, JSON.stringify({ cs: post.cs, ci: post.ci }));
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
