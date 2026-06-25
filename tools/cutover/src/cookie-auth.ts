/**
 * ITGC-AC-07 ToE — cookie-based web session auth + CSRF (P1 hardening).
 * Boots the real Nest app over PGlite and asserts: login sets an httpOnly JWT cookie + a readable CSRF
 * cookie; a cookie alone authenticates; a cookie-authenticated mutation is rejected without a matching
 * X-CSRF-Token (double-submit) and accepted with it; Bearer-authenticated requests are CSRF-exempt
 * (so machine/API-key/harness clients are unaffected); logout clears the cookies; anonymous → 401.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover cookie-auth
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cookie-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }]).onConflictDoNothing();
  await db.insert(s.users).values([{ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: 1 }]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  // 1. login sets the cookies
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'admin123' } });
  const tok = getCookie(login.headers['set-cookie'], 'ierp_token');
  const csrf = getCookie(login.headers['set-cookie'], 'ierp_csrf');
  ok('AC-07: login sets httpOnly ierp_token + readable ierp_csrf', login.statusCode === 200 && !!tok?.httpOnly && !!csrf && !csrf.httpOnly, `status=${login.statusCode} tokHttpOnly=${tok?.httpOnly} csrfReadable=${csrf && !csrf.httpOnly}`);
  const cookieHdr = `ierp_token=${tok?.value}; ierp_csrf=${csrf?.value}`;

  // 2. cookie alone authenticates (no Authorization header)
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieHdr } });
  ok('AC-07: cookie-only request authenticates (GET /api/auth/me → 200)', me.statusCode === 200 && me.json()?.username === 'admin', `status=${me.statusCode} user=${me.json()?.username}`);

  // 3. cookie-auth mutation WITHOUT X-CSRF-Token → 403 CSRF
  const noCsrf = await app.inject({ method: 'POST', url: '/api/auth/mfa/setup', headers: { cookie: cookieHdr } });
  ok('AC-07: cookie mutation without X-CSRF-Token → 403 CSRF', noCsrf.statusCode === 403 && noCsrf.json()?.error?.code === 'CSRF', `status=${noCsrf.statusCode} code=${noCsrf.json()?.error?.code}`);

  // 4. with matching X-CSRF-Token → not CSRF-blocked
  const withCsrf = await app.inject({ method: 'POST', url: '/api/auth/mfa/setup', headers: { cookie: cookieHdr, 'x-csrf-token': csrf?.value ?? '' } });
  ok('AC-07: cookie mutation with X-CSRF-Token → not blocked', withCsrf.statusCode !== 403, `status=${withCsrf.statusCode}`);

  // 5. Bearer (machine/harness) mutation is CSRF-exempt
  const bearer = await app.inject({ method: 'POST', url: '/api/auth/mfa/setup', headers: { authorization: `Bearer ${login.json().token}` } });
  ok('AC-07: Bearer mutation is CSRF-exempt (machine clients unaffected)', bearer.statusCode !== 403, `status=${bearer.statusCode}`);

  // 6. logout clears the cookies
  const lo = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: cookieHdr } });
  const loSc = (Array.isArray(lo.headers['set-cookie']) ? lo.headers['set-cookie'] : [String(lo.headers['set-cookie'])]).join('|');
  ok('AC-07: logout clears cookies (Max-Age=0)', lo.statusCode === 200 && /ierp_token=;.*Max-Age=0/i.test(loSc), `status=${lo.statusCode}`);

  // 7. anonymous → 401
  const anon = await app.inject({ method: 'GET', url: '/api/auth/me' });
  ok('AC-07: no cookie / no bearer → 401', anon.statusCode === 401, `status=${anon.statusCode}`);

  // 8. default cookie attributes are single-origin safe: SameSite=Lax, no Domain (regression guard).
  const defCookie = String((Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'] : [login.headers['set-cookie']]).find((c) => typeof c === 'string' && c.startsWith('ierp_token=')));
  ok('AC-07: default cookie is SameSite=Lax with no Domain (single-origin)', /SameSite=Lax/i.test(defCookie) && !/Domain=/i.test(defCookie), defCookie);

  // 9. cross-origin deploy config (AUTH_COOKIE_DOMAIN + SameSite=None) is honoured so web/API on different
  //    hosts can share the session — None must force Secure. Config is read per-request, so set → login → restore.
  process.env.AUTH_COOKIE_DOMAIN = '.example.test';
  process.env.AUTH_COOKIE_SAMESITE = 'None';
  const xo = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'admin123' } });
  const xoCookie = String((Array.isArray(xo.headers['set-cookie']) ? xo.headers['set-cookie'] : [xo.headers['set-cookie']]).find((c) => typeof c === 'string' && c.startsWith('ierp_token=')));
  ok('AC-07: cross-origin env sets Domain + SameSite=None; Secure', /Domain=\.example\.test/i.test(xoCookie) && /SameSite=None/i.test(xoCookie) && /Secure/i.test(xoCookie), xoCookie);
  delete process.env.AUTH_COOKIE_DOMAIN;
  delete process.env.AUTH_COOKIE_SAMESITE;

  await app.close();
  console.log('\n── ITGC-AC-07 — cookie-based web session auth + CSRF ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.log(`\n❌ ${failed}/${checks.length} cookie-auth checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} cookie-auth checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
