/**
 * Cutover check — portal pages backends: BoM (cust_bom) + customer Survey (survey perm).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover portal-extra
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-secret';
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
import { PERMISSIONS, PERM_GROUPS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const grpOf = (k: string) => Object.entries(PERM_GROUPS).find(([, ks]) => (ks as string[]).includes(k))?.[0] ?? null;
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, c: boolean, d = '') => checks.push({ name, ok: c, detail: d });

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();
  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k, grp: grpOf(k) }))).onConflictDoNothing();
  for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((perms as string[]).map((perm) => ({ role: role as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }]).onConflictDoNothing();
  const hq = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0];
  await db.insert(s.users).values({ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq.id }).onConflictDoNothing();
  await db.insert(s.items).values({ itemId: 'A', itemDescription: 'Apple', uom: 'EA', unitPrice: '10' }).onConflictDoNothing();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const token = (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' })).json.token;
  ok('login', !!token);

  // ── Portal BoM ──
  const bc = await inj('POST', '/api/portal/bom', token, { bom_code: 'BC1', product_name: 'Sauce', yield_qty: 10, yield_uom: 'Jar', lines: [{ item_id: 'A', use_uom: 'g', qty_use_uom: 50, unit_cost: 0.2 }] });
  ok('portal BoM create', bc.status === 200 || bc.status === 201, `status=${bc.status} ${JSON.stringify(bc.json).slice(0, 80)}`);
  const bl = await inj('GET', '/api/portal/bom', token);
  const boms = bl.json.boms ?? bl.json.bom ?? bl.json.items ?? [];
  ok('portal BoM list includes BC1', bl.status === 200 && boms.some((b: any) => (b.bom_code ?? b.bomCode) === 'BC1'), `n=${boms.length}`);
  const br = await inj('POST', '/api/portal/bom/BC1/production-runs', token, { batch_qty: 5 });
  ok('portal BoM production run', br.status === 200 || br.status === 201, `status=${br.status}`);

  // ── Customer survey ──
  const sv = await inj('POST', '/api/surveys', token, { survey_name: 'CSAT' });
  ok('create survey (admin)', (sv.status === 200 || sv.status === 201) && !!sv.json.survey_id, `id=${sv.json.survey_id}`);
  const ps = await inj('GET', '/api/portal/surveys', token);
  ok('portal surveys list', ps.status === 200 && Array.isArray(ps.json.surveys) && ps.json.surveys.length >= 1);
  const resp = await inj('POST', `/api/portal/surveys/${sv.json.survey_id}/responses`, token, { nps_score: 9, comments: 'great', q1: 'fast', q2: 'none' });
  ok('portal survey response submitted', resp.status === 200 || resp.status === 201, `status=${resp.status}`);

  await app.close();
  await pg.close();
  console.log('\n── Portal pages backends (BoM + Survey) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
