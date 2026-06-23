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

  // ── 4. A5 — seeded admin forced to change password ──
  const a1 = await login('admin', 'admin123');
  ok('Seeded admin login → must_change_password=true', a1.json.must_change_password === true, JSON.stringify({ mcp: a1.json.must_change_password }));
  const adminTok = a1.json.token;
  const badChange = await inj('POST', '/api/auth/change-password', adminTok, { current_password: 'wrong', new_password: 'newpass12' });
  ok('Change-password with wrong current → 400', badChange.status === 400 && badChange.json.error?.code === 'BAD_CURRENT_PASSWORD', `${badChange.status} ${badChange.json.error?.code}`);
  const change = await inj('POST', '/api/auth/change-password', adminTok, { current_password: 'admin123', new_password: 'newadminpass1' });
  ok('Change-password (correct current) → 200 ok', change.status === 200 && change.json.ok === true, `${change.status}`);
  const a2 = await login('admin', 'newadminpass1');
  ok('Re-login with new password → must_change_password cleared', a2.status === 200 && a2.json.must_change_password === false, JSON.stringify({ st: a2.status, mcp: a2.json.must_change_password }));
  const oldLogin = await login('admin', 'admin123');
  ok('Old password no longer works (401)', oldLogin.status === 401, `${oldLogin.status}`);

  console.log('\n── A4+A5 — Onboarding / provisioning / password ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} onboarding checks failed` : `\n✅ All ${checks.length} onboarding checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
