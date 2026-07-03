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

  // ── 3b. Platform-admin create-company (ITGC-AC-18): only a PLATFORM_ADMIN_USERNAMES user can
  //        POST /api/admin/tenants to provision a new company — the authenticated alternative to toggling
  //        public signup. Guard is enforced regardless of tenancy mode. ──
  process.env.PLATFORM_ADMIN_USERNAMES = ''; // owner1 is NOT a platform admin yet
  const createBody = { company_name: 'PlatCo', tenant_code: 'platco1', admin_username: 'platco_admin', admin_password: 'platco12345', email: 'p@c.com' };
  const denied = await inj('POST', '/api/admin/tenants', owner, createBody);
  ok('Create-company blocked for a non-platform-admin (403 PLATFORM_ADMIN_REQUIRED)', denied.status === 403 && denied.json.error?.code === 'PLATFORM_ADMIN_REQUIRED', `${denied.status} ${denied.json.error?.code}`);
  process.env.PLATFORM_ADMIN_USERNAMES = 'owner1'; // now owner1 is a platform owner
  const created = await inj('POST', '/api/admin/tenants', owner, createBody);
  ok('Platform-admin creates a new company via POST /api/admin/tenants (201)', created.status === 201 && !!created.json.tenant_id, `${created.status} tid=${created.json.tenant_id}`);
  const pcRows = (await pg.query(`SELECT (SELECT org_id FROM tenants WHERE id=${created.json.tenant_id}) AS t_org, (SELECT org_id FROM users WHERE username='platco_admin') AS u_org, (SELECT count(*)::int FROM fiscal_periods WHERE tenant_id=${created.json.tenant_id}) AS periods`)).rows as any[];
  ok('Platform-created company is org-isolated + fully provisioned (org_id=tenant id, 12 periods)', Number(pcRows[0].t_org) === Number(created.json.tenant_id) && Number(pcRows[0].u_org) === Number(created.json.tenant_id) && pcRows[0].periods === 12, JSON.stringify(pcRows[0]));
  const platLogin = await login('platco_admin', 'platco12345');
  ok('The newly platform-created Admin can log in', !!platLogin.json.token, `st=${platLogin.status}`);
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
