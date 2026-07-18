/**
 * docs/52 Phase 1 — business-type POS feature profile. `GET /api/pos/profile` derives the register/checkout
 * feature set from `tenants.industry`: a restaurant gets tables/KDS/courses + SALE.FOOD; retail/distribution/
 * general get a clean generic register + SALE.GOODS; services get SALE.SERVICE; an unset industry falls back
 * to the restaurant profile (non-breaking). Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover pos-profile
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'pp-secret';
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
  // one tenant per business type + one with NO industry set (backward-compat fallback).
  await db.insert(s.tenants).values([
    { code: 'REST', name: 'ร้านอาหาร', industry: 'restaurant' },
    { code: 'SHOP', name: 'ร้านค้าปลีก', industry: 'retail' },
    { code: 'DIST', name: 'ค้าส่ง', industry: 'distribution' },
    { code: 'SVC', name: 'บริการ', industry: 'services' },
    { code: 'GEN', name: 'ทั่วไป', industry: 'general' },
    { code: 'NONE', name: 'ยังไม่ตั้ง', industry: null },
  ]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  for (const c of ['REST', 'SHOP', 'DIST', 'SVC', 'GEN', 'NONE']) {
    await db.insert(s.users).values({ username: `u_${c}`, passwordHash: await pw.hash('pw1'), role: 'Admin', tenantId: await tid(c) }).onConflictDoNothing();
  }
  // a POS cashier (pos_sell only) and a non-POS user (Warehouse) in the retail shop for the access checks.
  await db.insert(s.users).values([
    { username: 'cashier', passwordHash: await pw.hash('pw1'), role: 'Cashier', tenantId: await tid('SHOP') },
    { username: 'wh', passwordHash: await pw.hash('pw1'), role: 'Warehouse', tenantId: await tid('SHOP') },
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p = 'pw1') => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const profileFor = async (u: string) => (await inj('GET', '/api/pos/profile', await login(u))).json;

  // ── restaurant → full restaurant surfaces + SALE.FOOD ──
  const rest = await profileFor('u_REST');
  ok('restaurant → tables/kds/courses/buffet + recipe + restaurant path + SALE.FOOD',
    rest.business_type === 'restaurant' && rest.tables === true && rest.kds === true && rest.courses === true && rest.buffet === true && rest.recipe_deduction === true && rest.sale_path === 'restaurant' && rest.revenue_event === 'SALE.FOOD',
    JSON.stringify(rest));

  // ── retail → clean generic register (no tables/kitchen), no recipe, SALE.GOODS ──
  const shop = await profileFor('u_SHOP');
  ok('retail → NO tables/kds/courses/buffet, no recipe, generic path, SALE.GOODS',
    shop.business_type === 'retail' && shop.tables === false && shop.kds === false && shop.courses === false && shop.buffet === false && shop.recipe_deduction === false && shop.sale_path === 'generic' && shop.revenue_event === 'SALE.GOODS',
    JSON.stringify(shop));

  // ── distribution + general → same generic/goods profile ──
  const dist = await profileFor('u_DIST');
  const gen = await profileFor('u_GEN');
  ok('distribution + general → generic register + SALE.GOODS',
    dist.sale_path === 'generic' && dist.revenue_event === 'SALE.GOODS' && dist.tables === false &&
    gen.sale_path === 'generic' && gen.revenue_event === 'SALE.GOODS' && gen.business_type === 'general',
    JSON.stringify({ dist: dist.business_type, gen: gen.business_type }));

  // ── services → generic register + SALE.SERVICE ──
  const svc = await profileFor('u_SVC');
  ok('services → generic register, no kitchen, SALE.SERVICE',
    svc.business_type === 'services' && svc.sale_path === 'generic' && svc.kds === false && svc.recipe_deduction === false && svc.revenue_event === 'SALE.SERVICE',
    JSON.stringify(svc));

  // ── no industry set → restaurant profile (backward-compatible fallback) ──
  const none = await profileFor('u_NONE');
  ok('unset industry → restaurant profile (non-breaking fallback)',
    none.business_type === 'restaurant' && none.sale_path === 'restaurant' && none.revenue_event === 'SALE.FOOD',
    JSON.stringify(none));

  // ── a pos_sell-only cashier can read the profile (the register needs it) ──
  const cashierP = await inj('GET', '/api/pos/profile', await login('cashier'));
  ok('pos_sell cashier can read the profile', (cashierP.status === 200) && cashierP.json.revenue_event === 'SALE.GOODS', `${cashierP.status} ${cashierP.json.revenue_event}`);

  // ── a non-POS user (Warehouse) is denied ──
  const whP = await inj('GET', '/api/pos/profile', await login('wh'));
  ok('non-POS user (Warehouse) → 403', whP.status === 403, `${whP.status}`);

  // ── the neutral revenue events resolve to a real COA account (boot invariant already asserts this; the
  //    app booting proves SALE.GOODS/SALE.SERVICE are registered — assert both surface via a profile). ──
  ok('SALE.GOODS + SALE.SERVICE are live posting events (app booted with the invariant)',
    shop.revenue_event === 'SALE.GOODS' && svc.revenue_event === 'SALE.SERVICE', 'booted');

  console.log('\n── docs/52 Phase 1 — business-type POS profile (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} pos-profile checks failed` : `\n✅ All ${checks.length} pos-profile checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
