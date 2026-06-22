/**
 * Cutover check — Stocktake + Goods Issue/Transfer (gap #3).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover stock-ops
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-secret';
process.env.NODE_ENV = 'test';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, and } from 'drizzle-orm';
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
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function seed(db: any) {
  const pw = new PasswordService();
  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k, grp: grpOf(k) }))).onConflictDoNothing();
  for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((perms as string[]).map((perm) => ({ role: role as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }]).onConflictDoNothing();
  const hq = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0];
  await db.insert(s.users).values({ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq.id }).onConflictDoNothing();
  await db.insert(s.items).values({ itemId: 'A', itemDescription: 'Apple', uom: 'EA', unitPrice: '10' }).onConflictDoNothing();
}

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  await seed(db);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const inj = async (method: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: method as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };

  const token = (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' })).json.token;
  ok('login', !!token);

  // ── Stocktake ──
  const st = await inj('POST', '/api/stocktake', token, { remarks: 'cycle', lines: [{ item_id: 'A', item_description: 'Apple', uom: 'EA', system_qty: 100, physical_qty: 95 }] });
  ok('create stocktake → ST- + 1 variance line', (st.status === 200 || st.status === 201) && /^ST-\d{8}-\d{3}$/.test(st.json.st_no) && st.json.variance_lines === 1, `status=${st.status} no=${st.json.st_no}`);
  const stNo = st.json.st_no;

  const stList = await inj('GET', '/api/stocktake', token);
  ok('list stocktakes includes new doc', stList.status === 200 && stList.json.stocktakes.some((x: any) => x.st_no === stNo));

  const stDet = await inj('GET', `/api/stocktake/${stNo}`, token);
  ok('stocktake detail difference = -5', stDet.status === 200 && stDet.json.lines[0].difference === -5, `diff=${stDet.json.lines?.[0]?.difference}`);

  const post1 = await inj('POST', `/api/stocktake/${stNo}/post`, token);
  ok('post stocktake → Posted + 1 variance movement', (post1.status === 200 || post1.status === 201) && post1.json.status === 'Posted' && post1.json.variance_movements === 1, JSON.stringify(post1.json));
  const post2 = await inj('POST', `/api/stocktake/${stNo}/post`, token);
  ok('re-post is idempotent (already)', post2.json.already === true);

  const so = await db.select().from(s.stockMovements).where(and(eq(s.stockMovements.refDoc, stNo), eq(s.stockMovements.moveType, 'Stock Out')));
  ok('variance movement Stock Out qty=5', so.length === 1 && Number(so[0].qty) === 5, `n=${so.length} qty=${so[0]?.qty}`);

  // ── Goods issue ──
  const iss = await inj('POST', '/api/inventory/issue', token, { from_location: 'WH-MAIN', ref_doc: 'WO-1', lines: [{ item_id: 'A', uom: 'EA', qty: 3 }] });
  ok('goods issue → MI-', (iss.status === 200 || iss.status === 201) && /^MI-\d{8}-\d{3}$/.test(iss.json.doc_no), `no=${iss.json.doc_no}`);
  const issRow = await db.select().from(s.stockMovements).where(eq(s.stockMovements.docNo, iss.json.doc_no));
  ok('issue stored as negative qty (audit, snapshot untouched)', issRow.length === 1 && Number(issRow[0].qty) === -3, `qty=${issRow[0]?.qty}`);

  // ── Transfer ──
  const trf = await inj('POST', '/api/inventory/transfer', token, { from_location: 'WH-MAIN', to_location: 'WH-2', lines: [{ item_id: 'A', uom: 'EA', qty: 2 }] });
  ok('transfer → TRF-', (trf.status === 200 || trf.status === 201) && /^TRF-\d{14}$/.test(trf.json.doc_no), `no=${trf.json.doc_no}`);
  const sameLoc = await inj('POST', '/api/inventory/transfer', token, { from_location: 'WH-1', to_location: 'WH-1', lines: [{ item_id: 'A', qty: 1 }] });
  ok('transfer same location → 400 SAME_LOCATION', sameLoc.status === 400 && sameLoc.json?.error?.code === 'SAME_LOCATION', `status=${sameLoc.status}`);

  // ── Movement history + snapshot untouched ──
  const mv = await inj('GET', '/api/inventory/movements', token);
  ok('movements history lists Issue+Transfer+Stock Out', mv.status === 200 && ['Issue', 'Transfer', 'Stock Out'].every((t) => mv.json.movements.some((m: any) => m.move_type === t)));
  const snaps = await db.select().from(s.stockSnapshots);
  ok('stock_snapshots untouched by ops (audit model)', snaps.length === 0);

  await app.close();
  await pg.close();

  console.log('\n── Stocktake + Goods Issue/Transfer (gap #3, PGlite) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
