/**
 * Cutover check — Module flags + Master-data import/export + Asset/Inventory QR.
 * Boots the real Nest app on PGlite (HTTP via app.inject), proves the new endpoints.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover module-qr
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
import { ymd } from '../../../apps/api/dist/database/queries';
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
  // Seed an asset directly (bypass GL — this harness verifies QR, not depreciation posting).
  await db.insert(s.fixedAssets).values({
    tenantId: hq.id, assetNo: 'FA-TEST', name: 'Test Fridge', acquireDate: ymd(),
    acquireCost: '25000', usefulLifeMonths: 120, netBookValue: '25000', status: 'active', location: 'Kitchen',
  }).onConflictDoNothing();
}

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  await seed(db);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db))
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const inj = async (method: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: method as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {};
    try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json, body: res.body as string, ctype: String(res.headers['content-type'] ?? '') };
  };

  const login = await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' });
  ok('login 200 + token', login.status === 200 && !!login.json.token, `status=${login.status}`);
  const token = login.json.token;

  // ── 1. MODULE FLAGS ─────────────────────────────────────────────────────
  const mods = await inj('GET', '/api/admin/modules', token);
  ok('GET /admin/modules lists modules', mods.status === 200 && Array.isArray(mods.json.modules) && mods.json.modules.length === PERMISSIONS.length, `n=${mods.json.modules?.length}`);

  const eff = await inj('GET', '/api/modules/effective', token);
  ok('GET /api/modules/effective (nav, any role)', eff.status === 200 && Array.isArray(eff.json.disabled), `status=${eff.status}`);

  const mktBefore = await inj('GET', '/api/marketing/campaigns', token);
  ok('marketing route OK before disable', mktBefore.status === 200, `status=${mktBefore.status}`);

  const disable = await inj('POST', '/api/admin/modules', token, { key: 'marketing', enabled: false });
  ok('POST disable marketing → 201', (disable.status === 200 || disable.status === 201) && disable.json.enabled === false, `status=${disable.status}`);

  const mktAfter = await inj('GET', '/api/marketing/campaigns', token);
  ok('marketing route 403 MODULE_DISABLED after disable', mktAfter.status === 403 && mktAfter.json?.error?.code === 'MODULE_DISABLED', `status=${mktAfter.status} code=${mktAfter.json?.error?.code}`);

  const reenable = await inj('POST', '/api/admin/modules', token, { key: 'marketing', enabled: true });
  ok('re-enable marketing', (reenable.status === 200 || reenable.status === 201) && reenable.json.enabled === true);
  const mktReen = await inj('GET', '/api/marketing/campaigns', token);
  ok('marketing route OK after re-enable', mktReen.status === 200, `status=${mktReen.status}`);

  const lockUsers = await inj('POST', '/api/admin/modules', token, { key: 'users', enabled: false });
  ok("'users' module cannot be disabled", lockUsers.json?.note === 'always_on');
  ok('admin/modules still reachable (users always on)', (await inj('GET', '/api/admin/modules', token)).status === 200);

  // ── 2. MASTER-DATA IMPORT/EXPORT ────────────────────────────────────────
  const ents = await inj('GET', '/api/admin/master-data/entities', token);
  const keys = (ents.json.entities ?? []).map((e: any) => e.key);
  ok('entities include items+assets+vendors', ents.status === 200 && keys.includes('items') && keys.includes('assets') && keys.includes('vendors'), keys.join(','));

  const imp = await inj('POST', '/api/admin/master-data/items/import', token, { format: 'rows', mode: 'append', rows: [{ Item_ID: 'Z1', Item_Description: 'Zeta', UOM: 'EA', Unit_Price: 12 }] });
  ok('import items → 1 row', (imp.status === 200 || imp.status === 201) && imp.json.imported === 1, `status=${imp.status} imported=${imp.json.imported}`);

  const impCsv = await inj('POST', '/api/admin/master-data/items/import', token, { format: 'csv', mode: 'append', csv: 'Item_ID,Item_Description,UOM\nZ2,Zeta2,EA\nZ3,Zeta3,BOX\n' });
  ok('import items via CSV → 2 rows', impCsv.json.imported === 2, `imported=${impCsv.json.imported}`);

  const expCsv = await inj('GET', '/api/admin/master-data/items/export?format=csv', token);
  ok('export items CSV contains imported rows', expCsv.status === 200 && /Z1/.test(expCsv.body) && /Z3/.test(expCsv.body), `len=${expCsv.body?.length}`);

  const tpl = await inj('GET', '/api/admin/master-data/items/template', token);
  ok('items template is xlsx (PK zip magic)', tpl.status === 200 && tpl.body?.slice(0, 2) === 'PK', `ctype=${tpl.ctype}`);

  const missing = await inj('POST', '/api/admin/master-data/items/import', token, { format: 'rows', rows: [{ UOM: 'EA' }] });
  ok('import missing required cols → 400', missing.status === 400 && missing.json?.error?.code === 'MISSING_COLUMNS', `status=${missing.status}`);

  // ── 3. ASSET + INVENTORY QR ─────────────────────────────────────────────
  const aqr = await inj('GET', '/api/assets/FA-TEST/qr', token);
  ok('asset QR data-url png', aqr.status === 200 && typeof aqr.json.data_url === 'string' && aqr.json.data_url.startsWith('data:image/png'), `status=${aqr.status}`);
  ok('asset QR payload has ASSET_ID', typeof aqr.json.payload === 'string' && aqr.json.payload.includes('ASSET_ID:FA-TEST'));

  const scan = await inj('POST', '/api/assets/scan-update', token, { code: 'ASSET_ID:FA-TEST|DESC:Test Fridge', location: 'Room B', note: 'moved' });
  ok('asset scan-update sets location', (scan.status === 200 || scan.status === 201) && scan.json.location === 'Room B', `status=${scan.status} loc=${scan.json.location}`);

  const mv = await db.select().from(s.assetMovements).where(eq(s.assetMovements.assetNo, 'FA-TEST'));
  ok('asset movement logged', mv.length === 1 && mv[0].toLocation === 'Room B', `n=${mv.length}`);

  const aLabels = await inj('GET', '/api/assets/qr/labels', token);
  ok('asset labels respond (pdf or html)', aLabels.status === 200 && (aLabels.ctype.includes('pdf') || aLabels.ctype.includes('html')), `ctype=${aLabels.ctype}`);

  const iLabels = await inj('POST', '/api/inventory/qr/labels', token, { item_ids: ['A'] });
  ok('inventory item labels respond', (iLabels.status === 200 || iLabels.status === 201) && (iLabels.ctype.includes('pdf') || iLabels.ctype.includes('html')), `status=${iLabels.status} ctype=${iLabels.ctype}`);

  await app.close();
  await pg.close();

  console.log('\n── Module flags + Master-data + QR (real Nest app, PGlite) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
