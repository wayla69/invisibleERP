/**
 * ITGC-AC-17 ToE — POS-PIN quick-login + one-action "เปิดกะ" (open shift).
 * Boots the real Nest app over PGlite and asserts: a non-privileged cashier authenticates with username+PIN
 * (sets the same httpOnly+CSRF cookies as password login and returns resolved permissions); a wrong PIN is
 * rejected; a PRIVILEGED account is HARD-BLOCKED from PIN login even with a valid PIN (must use password+MFA);
 * a till-capable supervisor can chain open-shift; self-service set-PIN is step-up-gated by the current
 * password; access-admin set-PIN is refused for privileged targets; a malformed PIN is rejected by the DTO;
 * and clearing a PIN disables PIN quick-login. (The shared ITGC-AC-07 per-account lockout that a PIN
 * brute-force also trips is covered by the cookie-auth ToE; it relies on the raw-pg autocommit store that
 * the PGlite harness does not wire.)
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover pos-pin
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'pin-secret';
process.env.NODE_ENV = 'test';
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
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIG = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

function getCookie(setCookie: any, name: string): { value: string; httpOnly: boolean } | null {
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of arr) if (typeof c === 'string' && c.startsWith(name + '=')) return { value: decodeURIComponent(c.slice(name.length + 1).split(';')[0]), httpOnly: /HttpOnly/i.test(c) };
  return null;
}

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) await pg.exec(readFileSync(join(MIG, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();
  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'Shop One' }]).onConflictDoNothing();
  // A non-privileged cashier (pos_sell), a till-capable supervisor (pos_till), and a PRIVILEGED admin — all
  // with a PIN set, to prove the privileged block fires on the role, not on the absence of a PIN.
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), pinHash: await pw.hash('5555'), role: 'Admin', tenantId: 1 },
    { username: 'cashier1', passwordHash: await pw.hash('cashpw1'), pinHash: await pw.hash('1234'), role: 'Cashier', tenantId: 2 },
    { username: 'sup1', passwordHash: await pw.hash('suppw1'), pinHash: await pw.hash('4321'), role: 'PosSupervisor', tenantId: 2 },
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inject = (opts: any) => app.inject(opts);

  // 1. cashier PIN login → 200, sets httpOnly token + readable CSRF, returns permissions (incl pos_sell)
  const cashLogin = await inject({ method: 'POST', url: '/api/login/pin', payload: { username: 'cashier1', pin: '1234' } });
  const cTok = getCookie(cashLogin.headers['set-cookie'], 'ierp_token');
  const cCsrf = getCookie(cashLogin.headers['set-cookie'], 'ierp_csrf');
  const cashBody = cashLogin.json();
  ok('AC-17: cashier PIN login → 200 + httpOnly token + readable CSRF + permissions[]',
    cashLogin.statusCode === 200 && !!cTok?.httpOnly && !!cCsrf && !cCsrf.httpOnly && Array.isArray(cashBody?.permissions) && cashBody.permissions.includes('pos_sell'),
    `status=${cashLogin.statusCode} perms=${JSON.stringify(cashBody?.permissions)}`);

  // 2. wrong PIN → 401 UNAUTHORIZED (generic; no user-enumeration)
  const wrong = await inject({ method: 'POST', url: '/api/login/pin', payload: { username: 'cashier1', pin: '9999' } });
  ok('AC-17: wrong PIN → 401 UNAUTHORIZED', wrong.statusCode === 401 && wrong.json()?.error?.code === 'UNAUTHORIZED', `status=${wrong.statusCode} code=${wrong.json()?.error?.code}`);

  // 3. PRIVILEGED account with a valid PIN → 401 PIN_NOT_ALLOWED (second factor not bypassable)
  const adminPin = await inject({ method: 'POST', url: '/api/login/pin', payload: { username: 'admin', pin: '5555' } });
  ok('AC-17: privileged (admin) PIN login blocked → 401 PIN_NOT_ALLOWED', adminPin.statusCode === 401 && adminPin.json()?.error?.code === 'PIN_NOT_ALLOWED', `status=${adminPin.statusCode} code=${adminPin.json()?.error?.code}`);

  // 4. supervisor PIN login → 200, permissions include pos_till (till-capable)
  const supLogin = await inject({ method: 'POST', url: '/api/login/pin', payload: { username: 'sup1', pin: '4321' } });
  const supTok = getCookie(supLogin.headers['set-cookie'], 'ierp_token');
  const supCsrf = getCookie(supLogin.headers['set-cookie'], 'ierp_csrf');
  const supCookie = `ierp_token=${supTok?.value}; ierp_csrf=${supCsrf?.value}`;
  ok('AC-17: supervisor PIN login → 200 + pos_till in permissions', supLogin.statusCode === 200 && supLogin.json()?.permissions?.includes('pos_till'), `status=${supLogin.statusCode}`);

  // 5. one-action open-shift: no till open yet → current=null, then open → 200, then current=open
  const before = await inject({ method: 'GET', url: '/api/payments/till/current', headers: { cookie: supCookie } });
  const opened = await inject({ method: 'POST', url: '/api/payments/till/open', headers: { cookie: supCookie, 'x-csrf-token': supCsrf?.value ?? '' }, payload: { opening_float: 500 } });
  const after = await inject({ method: 'GET', url: '/api/payments/till/current', headers: { cookie: supCookie } });
  ok('AC-17: open-shift flow — current null → open → current open',
    before.statusCode === 200 && before.json()?.open === null && (opened.statusCode === 200 || opened.statusCode === 201) && after.json()?.open?.session_no,
    `before=${JSON.stringify(before.json())} open=${opened.statusCode} after=${JSON.stringify(after.json())}`);

  // 6. self-service set-PIN: correct current password → 200; wrong → 400 BAD_CURRENT_PASSWORD
  const cashCookie = `ierp_token=${cTok?.value}; ierp_csrf=${cCsrf?.value}`;
  const setOk = await inject({ method: 'POST', url: '/api/auth/me/pin', headers: { cookie: cashCookie, 'x-csrf-token': cCsrf?.value ?? '' }, payload: { current_password: 'cashpw1', pin: '246810' } });
  const setBad = await inject({ method: 'POST', url: '/api/auth/me/pin', headers: { cookie: cashCookie, 'x-csrf-token': cCsrf?.value ?? '' }, payload: { current_password: 'nope', pin: '777777' } });
  ok('AC-17: self set-PIN ok with current password, rejected without', setOk.statusCode === 200 && setBad.statusCode === 400 && setBad.json()?.error?.code === 'BAD_CURRENT_PASSWORD', `ok=${setOk.statusCode} bad=${setBad.statusCode}/${setBad.json()?.error?.code}`);
  // the rotated PIN authenticates
  const reLogin = await inject({ method: 'POST', url: '/api/login/pin', payload: { username: 'cashier1', pin: '246810' } });
  ok('AC-17: rotated PIN authenticates', reLogin.statusCode === 200, `status=${reLogin.statusCode}`);

  // 7. access-admin set-PIN: ok for a cashier, refused for a privileged target
  const adminLogin = await inject({ method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'admin123' } });
  const aTok = getCookie(adminLogin.headers['set-cookie'], 'ierp_token');
  const aCsrf = getCookie(adminLogin.headers['set-cookie'], 'ierp_csrf');
  const aCookie = `ierp_token=${aTok?.value}; ierp_csrf=${aCsrf?.value}`;
  const setForCashier = await inject({ method: 'POST', url: '/api/auth/users/cashier1/pin', headers: { cookie: aCookie, 'x-csrf-token': aCsrf?.value ?? '' }, payload: { pin: '135790' } });
  const setForAdmin = await inject({ method: 'POST', url: '/api/auth/users/admin/pin', headers: { cookie: aCookie, 'x-csrf-token': aCsrf?.value ?? '' }, payload: { pin: '112233' } });
  ok('AC-17: admin set-PIN ok for cashier, 400 PIN_NOT_ALLOWED for privileged target', setForCashier.statusCode === 200 && setForAdmin.statusCode === 400 && setForAdmin.json()?.error?.code === 'PIN_NOT_ALLOWED', `cashier=${setForCashier.statusCode} admin=${setForAdmin.statusCode}/${setForAdmin.json()?.error?.code}`);

  // 8. malformed PIN is rejected by the DTO (4–6 digits only) before any auth work
  const bad1 = await inject({ method: 'POST', url: '/api/login/pin', payload: { username: 'cashier1', pin: '12' } });
  const bad2 = await inject({ method: 'POST', url: '/api/login/pin', payload: { username: 'cashier1', pin: 'abcd' } });
  ok('AC-17: malformed PIN rejected by DTO (400)', bad1.statusCode === 400 && bad2.statusCode === 400, `short=${bad1.statusCode} alpha=${bad2.statusCode}`);

  // 9. access-admin clears a PIN → PIN quick-login is disabled (falls back to 401), password still works
  const cleared = await inject({ method: 'DELETE', url: '/api/auth/users/cashier1/pin', headers: { cookie: aCookie, 'x-csrf-token': aCsrf?.value ?? '' } });
  const afterClear = await inject({ method: 'POST', url: '/api/login/pin', payload: { username: 'cashier1', pin: '135790' } });
  const pwStillOk = await inject({ method: 'POST', url: '/api/login', payload: { username: 'cashier1', password: 'cashpw1' } });
  ok('AC-17: clear-PIN disables PIN login (401) but password login still works',
    cleared.statusCode === 200 && afterClear.statusCode === 401 && pwStillOk.statusCode === 200,
    `clear=${cleared.statusCode} pinAfter=${afterClear.statusCode} pw=${pwStillOk.statusCode}`);

  await app.close();
  console.log('\n── ITGC-AC-17 — POS-PIN quick-login + open-shift ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.log(`\n❌ ${failed}/${checks.length} pos-pin checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} pos-pin checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
