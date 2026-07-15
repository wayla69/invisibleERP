/**
 * SME single-user edition ToE (docs/49, control SME-01) — mirrors UAT-ADM-157..160.
 * Enterprise maker-checker stays byte-identical (403 SOD_VIOLATION, reason or not); an 'sme' tenant may
 * self-approve WITH a logged justification (self_approvals evidence + the sme_self_approval_review report);
 * god provisions SME companies + platform SME defaults; transition is UPGRADE-ONLY; public signup can never
 * mint an SME tenant.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover sme
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sme-secret';
process.env.NODE_ENV = 'test';
// The platform owner ("god") — set BEFORE app bootstrap so the guard sees it from the first request.
process.env.PLATFORM_ADMIN_USERNAMES = 'god1';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
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
  // god1 (platform owner) lives in HQ
  await db.insert(s.users).values([{ username: 'god1', passwordHash: await pw.hash('admin123'), role: 'Admin' }]).onConflictDoNothing();

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
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const year = new Date().getFullYear();
  const god = await login('god1', 'admin123');

  const postJe = (token: string, amount: number) =>
    inj('POST', '/api/ledger/journal', token, { date: `${year}-06-15`, source: 'TEST', lines: [{ account_code: '1000', debit: amount }, { account_code: '4000', credit: amount }] });
  // Run a BI report type once and return { run, data } — data comes from the recorded report_runs row
  // (the run response carries only the string summary; report.data is persisted in report_runs.summary).
  const runReport = async (token: string, report_type: string) => {
    const sub = await inj('POST', '/api/bi/subscriptions', token, { name: `ToE ${report_type}`, report_type, frequency: 'monthly' });
    const run = await inj('POST', `/api/bi/subscriptions/${sub.json.id}/run`, token, {});
    const rows = (await pg.query(`SELECT summary FROM report_runs WHERE id=${Number(run.json.run_id) || 0}`)).rows as any[];
    return { run, data: rows[0]?.summary as any };
  };

  // ── 1. Enterprise regression (UAT-ADM-157): maker ≠ checker binds exactly as before ──
  const entCreate = await inj('POST', '/api/admin/tenants', god, {
    company_name: 'EntCo', tenant_code: 'entco1', admin_username: 'ent_admin', admin_password: 'admin123', email: 'ent@x.co',
  });
  ok('God provisions a default company → 201 control_profile=enterprise', entCreate.status === 201 && entCreate.json.control_profile === 'enterprise', `${entCreate.status} ${entCreate.json.control_profile}`);
  const entTid = Number(entCreate.json.tenant_id);
  // a second (different) approver in the same enterprise company, seeded directly
  await db.insert(s.users).values([{ username: 'ent_approver', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: entTid, orgId: entTid }]);
  const entAdmin = await login('ent_admin', 'admin123');
  const entApprover = await login('ent_approver', 'admin123');
  const entJe = await postJe(entAdmin, 1000);
  const entJeNo = entJe.json.entry_no;
  const entSelf = await inj('POST', `/api/ledger/journal/${entJeNo}/approve`, entAdmin);
  ok('Enterprise: maker approving own JE (no body) → 403 SOD_VIOLATION', entSelf.status === 403 && entSelf.json.error?.code === 'SOD_VIOLATION', `${entSelf.status} ${entSelf.json.error?.code}`);
  const entSelfReason = await inj('POST', `/api/ledger/journal/${entJeNo}/approve`, entAdmin, { self_approval_reason: 'x' });
  ok('Enterprise: a self_approval_reason does NOT unlock self-approval (still 403 SOD_VIOLATION)', entSelfReason.status === 403 && entSelfReason.json.error?.code === 'SOD_VIOLATION', `${entSelfReason.status} ${entSelfReason.json.error?.code}`);
  const entOther = await inj('POST', `/api/ledger/journal/${entJeNo}/approve`, entApprover);
  ok('Enterprise: a DIFFERENT user approves fine (200 Posted)', entOther.status === 200 && entOther.json.status === 'Posted', `${entOther.status} ${entOther.json.status}`);

  // ── 2. God provisions an SME company (UAT-ADM-158) ──
  const setDefaults = await inj('POST', '/api/admin/sme-defaults', god, { hidden_nav_groups: ['nav.group.projects'], accountant_email: 'acc@x.co' });
  const getDefaults = await inj('GET', '/api/admin/sme-defaults', god);
  ok('God sets platform SME defaults (hidden nav groups + accountant) → readable back',
    setDefaults.status === 200 && getDefaults.status === 200 && (getDefaults.json.hidden_nav_groups ?? []).includes('nav.group.projects') && getDefaults.json.accountant_email === 'acc@x.co',
    JSON.stringify(getDefaults.json).slice(0, 120));
  const smeCreate = await inj('POST', '/api/admin/tenants', god, {
    company_name: 'ร้านเจ้าของคนเดียว', tenant_code: 'smeco1', admin_username: 'sme_owner', admin_password: 'admin123', email: 'sme@x.co', control_profile: 'sme',
  });
  ok('God provisions an SME company (control_profile=sme) → 201', smeCreate.status === 201 && smeCreate.json.control_profile === 'sme', `${smeCreate.status} ${smeCreate.json.control_profile}`);
  const smeTid = Number(smeCreate.json.tenant_id);
  // docs/49/docs/36 item 5 — an SME company with no explicit plan_code defaults to the 'sme' single-operator plan.
  const smeSub = (await pg.query(`SELECT plan_code FROM subscriptions WHERE tenant_id=${smeTid} LIMIT 1`)).rows as any[];
  ok('SME company defaults onto the sme plan (edition-aware provisioning)', smeSub[0]?.plan_code === 'sme', `plan=${smeSub[0]?.plan_code}`);
  const smeOwner = await login('sme_owner', 'admin123');
  const smeMe = await inj('GET', '/api/auth/me', smeOwner);
  ok('SME admin /api/auth/me carries control_profile=sme + the stamped hidden nav groups',
    smeMe.json.control_profile === 'sme' && (smeMe.json.sme_hidden_nav_groups ?? []).includes('nav.group.projects'),
    JSON.stringify({ cp: smeMe.json.control_profile, nav: smeMe.json.sme_hidden_nav_groups }));

  // ── 3. SME self-approval (UAT-ADM-158): allowed ONLY with a justification, always evidenced ──
  const smeJe = await postJe(smeOwner, 750);
  const smeJeNo = smeJe.json.entry_no;
  ok('SME owner posts a manual JE as Draft (GL-05 unchanged at posting time)', /^JE-/.test(smeJeNo ?? '') && smeJe.json.pending === true, `${smeJe.status} ${smeJeNo}`);
  const smeNoReason = await inj('POST', `/api/ledger/journal/${smeJeNo}/approve`, smeOwner);
  ok('SME: self-approval with NO reason → 400 SELF_APPROVAL_REASON_REQUIRED', smeNoReason.status === 400 && smeNoReason.json.error?.code === 'SELF_APPROVAL_REASON_REQUIRED', `${smeNoReason.status} ${smeNoReason.json.error?.code}`);
  const smeWithReason = await inj('POST', `/api/ledger/journal/${smeJeNo}/approve`, smeOwner, { self_approval_reason: 'เจ้าของอนุมัติเอง' });
  ok('SME: self-approval WITH a reason → 200 Posted', smeWithReason.status === 200 && smeWithReason.json.status === 'Posted', `${smeWithReason.status} ${smeWithReason.json.status}`);
  const evid = (await pg.query(`SELECT event, ref, username, reason, amount FROM self_approvals WHERE tenant_id=${smeTid}`)).rows as any[];
  ok('SME-01 evidence row written (event gl.je.approve, ref=JE no, username, reason)',
    evid.length === 1 && evid[0].event === 'gl.je.approve' && evid[0].ref === smeJeNo && evid[0].username === 'sme_owner' && evid[0].reason === 'เจ้าของอนุมัติเอง' && Number(evid[0].amount) === 750,
    JSON.stringify(evid[0] ?? {}));

  // ── 4. SME-01 report: sme_self_approval_review delivers every logged self-approval ──
  const smeReport = await runReport(smeOwner, 'sme_self_approval_review');
  ok('sme_self_approval_review runs success for the SME admin', smeReport.run.json.status === 'success', JSON.stringify({ s: smeReport.run.json.status, e: smeReport.run.json.error }).slice(0, 120));
  ok('SME-01 report data: count>=1 and items[0] carries the reason',
    Number(smeReport.data?.count) >= 1 && smeReport.data?.items?.[0]?.reason === 'เจ้าของอนุมัติเอง' && smeReport.data?.items?.[0]?.ref === smeJeNo,
    JSON.stringify({ count: smeReport.data?.count, item0: smeReport.data?.items?.[0] }).slice(0, 160));

  // ── 4b. docs/49 v1.2 (audit G2/H1): SME-01 operates BY DESIGN — auto-scheduled at birth; per-tenant edit re-points it ──
  // NB filter by the provisioning-stamped NAME — §4's runReport helper creates its own ad-hoc subscription
  // of the same type, and this check must see exactly the auto-provisioned one.
  const autoSub = (await pg.query(`SELECT report_type, frequency, is_active, recipients FROM report_subscriptions WHERE tenant_id=${smeTid} AND report_type='sme_self_approval_review' AND name='ทบทวนการอนุมัติด้วยตนเอง (SME-01)'`)).rows as any[];
  ok('G2: an ACTIVE monthly sme_self_approval_review subscription exists from provisioning, recipient = stamped accountant',
    autoSub.length === 1 && autoSub[0].frequency === 'monthly' && autoSub[0].is_active === true && JSON.stringify(autoSub[0].recipients).includes('acc@x.co'),
    JSON.stringify(autoSub[0] ?? {}));
  const prefsEdit = await inj('POST', `/api/admin/tenants/${smeTid}/sme-prefs`, god, { accountant_email: 'new-acc@x.co' });
  const subAfter = (await pg.query(`SELECT recipients FROM report_subscriptions WHERE tenant_id=${smeTid} AND report_type='sme_self_approval_review' AND name='ทบทวนการอนุมัติด้วยตนเอง (SME-01)'`)).rows as any[];
  ok('H1: editing the tenant accountant (POST admin/tenants/:id/sme-prefs) re-points the SME-01 recipient',
    prefsEdit.status === 200 && JSON.stringify(subAfter[0]?.recipients ?? []).includes('new-acc@x.co'),
    `${prefsEdit.status} ${JSON.stringify(subAfter[0]?.recipients ?? [])}`);
  const prefsOnEnt = await inj('POST', `/api/admin/tenants/${entTid}/sme-prefs`, god, { accountant_email: 'x@x.co' });
  ok('H1: sme-prefs on an ENTERPRISE company → 403 NOT_SME_TENANT',
    prefsOnEnt.status === 403 && prefsOnEnt.json.error?.code === 'NOT_SME_TENANT', `${prefsOnEnt.status} ${prefsOnEnt.json.error?.code}`);

  // ── 4c. docs/49 v1.2 (audit G1): PROJ-27 benefit confirm rides the seam — 2nd event, DTO pattern, 400 contract ──
  await pg.query(`INSERT INTO projects (tenant_id, project_code, name, program_code) VALUES (${smeTid}, 'SMEPRJ1', 'SME project', 'PRG-SME')`);
  const declared = await inj('POST', '/api/projects/programs/PRG-SME/benefits', smeOwner, { name: 'ลดต้นทุนโปรแกรม', target_value: 100 });
  const benefitId = Number(declared.json?.benefits?.[0]?.id ?? 0);
  ok('G1 setup: SME owner declares a program benefit', declared.status === 201 || declared.status === 200, `${declared.status} id=${benefitId}`);
  const confNoReason = await inj('POST', `/api/projects/benefits/${benefitId}/confirm`, smeOwner, { result: 'realized' });
  ok('G1: SME self-confirm with NO reason → 400 SELF_APPROVAL_REASON_REQUIRED (was a hard 400 SOD_SELF_APPROVAL)',
    confNoReason.status === 400 && confNoReason.json.error?.code === 'SELF_APPROVAL_REASON_REQUIRED', `${confNoReason.status} ${confNoReason.json.error?.code}`);
  const confWithReason = await inj('POST', `/api/projects/benefits/${benefitId}/confirm`, smeOwner, { result: 'realized', self_approval_reason: 'เจ้าของยืนยันเอง' });
  const benefitEvid = (await pg.query(`SELECT event, ref, reason FROM self_approvals WHERE tenant_id=${smeTid} AND event='proj.benefit.confirm'`)).rows as any[];
  ok('G1: SME self-confirm WITH a reason → success (200/201) + proj.benefit.confirm evidence row',
    (confWithReason.status === 200 || confWithReason.status === 201) && benefitEvid.length === 1 && benefitEvid[0].ref === String(benefitId) && benefitEvid[0].reason === 'เจ้าของยืนยันเอง',
    `${confWithReason.status} ${JSON.stringify(benefitEvid[0] ?? {})}`);
  await pg.query(`INSERT INTO projects (tenant_id, project_code, name, program_code) VALUES (${entTid}, 'ENTPRJ1', 'Ent project', 'PRG-ENT')`);
  const entDeclared = await inj('POST', '/api/projects/programs/PRG-ENT/benefits', entAdmin, { name: 'ent benefit', target_value: 50 });
  const entBenefitId = Number(entDeclared.json?.benefits?.[0]?.id ?? 0);
  const entConf = await inj('POST', `/api/projects/benefits/${entBenefitId}/confirm`, entAdmin, { result: 'realized', self_approval_reason: 'x' });
  ok('G1 enterprise regression: self-confirm stays a hard 400 SOD_SELF_APPROVAL (reason or not)',
    entConf.status === 400 && entConf.json.error?.code === 'SOD_SELF_APPROVAL', `${entConf.status} ${entConf.json.error?.code}`);

  // ── 4d. docs/49 v1.3 (item 4): the setup-wizard's load-bearing backend chain — setting tax_id (a G15
  //    maker-checker field) STAGES a change; a solo SME owner then self-approves it WITH a reason so the
  //    wizard completes without a second person (evidence via SME-01). Enterprise still needs a distinct approver. ──
  const smePatch = await inj('PATCH', '/api/tenant/profile', smeOwner, { legal_name: 'ร้านเจ้าของคนเดียว จำกัด', tax_id: '1234567890123', address_line1: '1 ถนนหลัก', province: 'กรุงเทพฯ' });
  const stagedReq = smePatch.json?.pending_change?.req_no;
  ok('Item 4: SME owner sets tax_id via the wizard → staged (G15 maker-checker) pending_change returned',
    smePatch.status === 200 && !!stagedReq && (smePatch.json.pending_change.fields ?? []).includes('tax_id'), `${smePatch.status} ${JSON.stringify(smePatch.json?.pending_change ?? {})}`);
  const stagedNoReason = await inj('POST', `/api/tenant/profile-approvals/${stagedReq}/approve`, smeOwner);
  ok('Item 4: SME owner self-approving the staged tax_id with NO reason → 400 SELF_APPROVAL_REASON_REQUIRED',
    stagedNoReason.status === 400 && stagedNoReason.json.error?.code === 'SELF_APPROVAL_REASON_REQUIRED', `${stagedNoReason.status} ${stagedNoReason.json.error?.code}`);
  const stagedApprove = await inj('POST', `/api/tenant/profile-approvals/${stagedReq}/approve`, smeOwner, { self_approval_reason: 'การตั้งค่าเริ่มต้นบริษัทผ่านตัวช่วย' });
  const smeProfile = await inj('GET', '/api/tenant/profile', smeOwner);
  ok('Item 4: SME owner self-approves the tax_id WITH a reason → applied, setup_complete=true (wizard done)',
    stagedApprove.status === 200 && smeProfile.json.tax_id === '1234567890123' && smeProfile.json.setup_complete === true, `${stagedApprove.status} setup=${smeProfile.json.setup_complete}`);
  const smeWizEvid = (await pg.query(`SELECT count(*)::int n FROM self_approvals WHERE tenant_id=${smeTid} AND event='tenant.profile-change.approve'`)).rows as any[];
  ok('Item 4: the wizard tax_id self-approval left an SME-01 evidence row (audit trail preserved)', smeWizEvid[0].n === 1, `n=${smeWizEvid[0].n}`);

  // ── 5. Cross-tenant boundary: the enterprise tenant's review sees ZERO SME rows ──
  const entReport = await runReport(entAdmin, 'sme_self_approval_review');
  ok('Cross-tenant: enterprise admin\'s sme_self_approval_review → count 0 (no leakage of the SME tenant\'s rows)',
    entReport.run.json.status === 'success' && Number(entReport.data?.count) === 0 && (entReport.data?.items ?? []).length === 0,
    JSON.stringify({ count: entReport.data?.count, items: (entReport.data?.items ?? []).length }));

  // ── 6. Upgrade-only transition (UAT-ADM-159): sme → enterprise, never back ──
  const downgrade = await inj('POST', `/api/admin/tenants/${entTid}/control-profile`, god, { control_profile: 'sme' });
  ok('Downgrade attempt {control_profile:sme} → 400 (zod: only literal enterprise accepted)', downgrade.status === 400, `${downgrade.status} ${downgrade.json.error?.code}`);
  const upgrade = await inj('POST', `/api/admin/tenants/${smeTid}/control-profile`, god, { control_profile: 'enterprise' });
  ok('Upgrade sme → enterprise → 200 changed:true', upgrade.status === 200 && upgrade.json.changed === true && upgrade.json.control_profile === 'enterprise', `${upgrade.status} ${JSON.stringify(upgrade.json)}`);
  const smeJe2 = await postJe(smeOwner, 300);
  const upgradedSelf = await inj('POST', `/api/ledger/journal/${smeJe2.json.entry_no}/approve`, smeOwner, { self_approval_reason: 'พยายามอนุมัติเองหลังอัปเกรด' });
  ok('After upgrade the owner\'s self-approval is BLOCKED like any enterprise (403 SOD_VIOLATION, reason or not)',
    upgradedSelf.status === 403 && upgradedSelf.json.error?.code === 'SOD_VIOLATION', `${upgradedSelf.status} ${upgradedSelf.json.error?.code}`);
  const upgradeAgain = await inj('POST', `/api/admin/tenants/${smeTid}/control-profile`, god, { control_profile: 'enterprise' });
  ok('Re-upgrading an enterprise company → 200 changed:false (idempotent)', upgradeAgain.status === 200 && upgradeAgain.json.changed === false, `${upgradeAgain.status} ${JSON.stringify(upgradeAgain.json)}`);
  // Three ALLOWED self-approvals exist by now (gl.je.approve §3 + proj.benefit.confirm §4c +
  // tenant.profile-change.approve §4d) — the blocked post-upgrade attempt must not have added a fourth.
  const evidAfter = (await pg.query(`SELECT count(*)::int n FROM self_approvals WHERE tenant_id=${smeTid}`)).rows as any[];
  ok('The blocked post-upgrade attempt wrote NO new evidence row (evidence only on ALLOWED self-approvals)', evidAfter[0].n === 3, `n=${evidAfter[0].n}`);

  // ── 7. Public signup NEVER honours control_profile (UAT-ADM-160) ──
  const su = await inj('POST', '/api/auth/signup', undefined, {
    company_name: 'SneakySME', tenant_code: 'sneaky1', admin_username: 'sneaky_admin', admin_password: 'admin123', email: 'sn@x.co', control_profile: 'sme',
  });
  const suRow = (await pg.query(`SELECT control_profile FROM tenants WHERE id=${Number(su.json.tenant_id) || 0}`)).rows as any[];
  ok('Public signup with control_profile=sme → provisioned tenant is ENTERPRISE', su.status === 201 && suRow[0]?.control_profile === 'enterprise', `${su.status} ${suRow[0]?.control_profile}`);
  const sneaky = await login('sneaky_admin', 'admin123');
  const sneakyMe = await inj('GET', '/api/auth/me', sneaky);
  ok('Signup admin /api/auth/me carries NO sme profile (no self-approval relaxation)', sneakyMe.status === 200 && sneakyMe.json.control_profile !== 'sme', `cp=${sneakyMe.json.control_profile}`);

  console.log('\n── SME single-user edition (docs/49, SME-01) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} sme checks failed` : `\n✅ All ${checks.length} sme checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
