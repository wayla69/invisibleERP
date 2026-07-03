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
import { PERMISSIONS, PERM_GROUPS, DEFAULT_ROLE_PERMISSIONS, MODULE_KEYS } from '@ierp/shared';

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
  // A second tenant + its admin — for the per-tenant menu/module isolation checks.
  await db.insert(s.tenants).values([{ code: 'T2', name: 'Tenant Two' }]).onConflictDoNothing();
  const t2 = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'T2')))[0];
  await db.insert(s.users).values({ username: 'admin2', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t2.id }).onConflictDoNothing();
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
  const login2 = await inj('POST', '/api/login', undefined, { username: 'admin2', password: 'admin123' });
  const token2 = login2.json.token; // a DIFFERENT tenant's admin (for isolation checks)

  // ── 1. MODULE FLAGS ─────────────────────────────────────────────────────
  const mods = await inj('GET', '/api/admin/modules', token);
  // /admin/modules lists MODULE_KEYS (feature toggles), which diverged from PERMISSIONS once
  // granular sub-permissions (pos_sell, wh_count, …) were added. Assert against MODULE_KEYS.
  ok('GET /admin/modules lists modules', mods.status === 200 && Array.isArray(mods.json.modules) && mods.json.modules.length === MODULE_KEYS.length, `n=${mods.json.modules?.length} expected=${MODULE_KEYS.length}`);

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

  // ── 1b. MENU VISIBILITY (nav:<href> overrides — chrome only, distinct from module flags) ──
  const hideNav = await inj('POST', '/api/admin/modules/nav', token, { hrefs: ['/reservations'], enabled: false });
  ok('POST hide menu /reservations → updated 1', (hideNav.status === 200 || hideNav.status === 201) && hideNav.json.updated === 1, `status=${hideNav.status} updated=${hideNav.json?.updated}`);

  const modsAfterHide = await inj('GET', '/api/admin/modules', token);
  ok('admin/modules navDisabled includes /reservations', Array.isArray(modsAfterHide.json.navDisabled) && modsAfterHide.json.navDisabled.includes('/reservations'), `navDisabled=${JSON.stringify(modsAfterHide.json.navDisabled)}`);

  const effHide = await inj('GET', '/api/modules/effective', token);
  ok('effective navDisabled includes /reservations (nav hides for all)', Array.isArray(effHide.json.navDisabled) && effHide.json.navDisabled.includes('/reservations'));

  // Hiding a menu is visibility only — a nav:<href> row must NOT enter the permission guard's disabled set,
  // so gated APIs keep working (contrast with a disabled module, asserted above to return 403).
  const apiStillOk = await inj('GET', '/api/marketing/campaigns', token);
  ok('hidden menu does NOT block APIs (visibility ≠ permission)', apiStillOk.status === 200, `status=${apiStillOk.status}`);

  const lockNav = await inj('POST', '/api/admin/modules/nav', token, { hrefs: ['/settings', '/admin/users'], enabled: false });
  ok('lockout-critical menus cannot be hidden', lockNav.json?.updated === 0 && lockNav.json?.skipped === 2, `updated=${lockNav.json?.updated} skipped=${lockNav.json?.skipped}`);

  const showNav = await inj('POST', '/api/admin/modules/nav', token, { hrefs: ['/reservations'], enabled: true });
  ok('re-show menu /reservations', (showNav.status === 200 || showNav.status === 201) && showNav.json.updated === 1);
  const effShow = await inj('GET', '/api/modules/effective', token);
  ok('effective navDisabled cleared after re-show', !((effShow.json.navDisabled ?? []).includes('/reservations')));

  // ── 1c. CATEGORY ORDER (system-wide sidebar group ordering, migration 0230) ──
  const order1 = ['nav.group.finance', 'nav.group.overview', 'nav.group.crm'];
  const setOrd = await inj('POST', '/api/admin/modules/nav-order', token, { order: order1 });
  ok('POST nav-order → echoes order', (setOrd.status === 200 || setOrd.status === 201) && JSON.stringify(setOrd.json.groupOrder) === JSON.stringify(order1), `groupOrder=${JSON.stringify(setOrd.json?.groupOrder)}`);

  const modsOrd = await inj('GET', '/api/admin/modules', token);
  ok('admin/modules returns groupOrder', JSON.stringify(modsOrd.json.groupOrder) === JSON.stringify(order1), `groupOrder=${JSON.stringify(modsOrd.json?.groupOrder)}`);

  const effOrd = await inj('GET', '/api/modules/effective', token);
  ok('effective returns groupOrder (order applies for all)', JSON.stringify(effOrd.json.groupOrder) === JSON.stringify(order1));

  // Full-replace semantics: a new order supersedes the old and drops keys no longer present.
  const order2 = ['nav.group.crm', 'nav.group.finance'];
  await inj('POST', '/api/admin/modules/nav-order', token, { order: order2 });
  const effOrd2 = await inj('GET', '/api/modules/effective', token);
  ok('nav-order full-replaces (stale keys dropped)', JSON.stringify(effOrd2.json.groupOrder) === JSON.stringify(order2), `groupOrder=${JSON.stringify(effOrd2.json?.groupOrder)}`);

  // ── 1c-ii. ITEM ORDER within a container (scope = group/sub-section title) ──
  const itemOrd1 = ['/tips', '/pos', '/pos/register'];
  const setItem = await inj('POST', '/api/admin/modules/nav-item-order', token, { scope: 'nav.group.pos_sales', order: itemOrd1 });
  ok('POST nav-item-order → echoes order', (setItem.status === 200 || setItem.status === 201) && JSON.stringify(setItem.json.itemOrder) === JSON.stringify(itemOrd1), `itemOrder=${JSON.stringify(setItem.json?.itemOrder)}`);

  const effItem = await inj('GET', '/api/modules/effective', token);
  ok('effective returns itemOrder keyed by scope', JSON.stringify(effItem.json.itemOrder?.['nav.group.pos_sales']) === JSON.stringify(itemOrd1), `itemOrder=${JSON.stringify(effItem.json?.itemOrder)}`);

  // Group order and item order are independent (they share the table but not the namespace).
  await inj('POST', '/api/admin/modules/nav-order', token, { order: ['nav.group.crm', 'nav.group.finance'] });
  const effBoth = await inj('GET', '/api/modules/effective', token);
  ok('group-order change preserves item-order', JSON.stringify(effBoth.json.itemOrder?.['nav.group.pos_sales']) === JSON.stringify(itemOrd1) && JSON.stringify(effBoth.json.groupOrder) === JSON.stringify(['nav.group.crm', 'nav.group.finance']), `order=${JSON.stringify(effBoth.json?.groupOrder)} item=${JSON.stringify(effBoth.json?.itemOrder)}`);

  // ── 1d. RESET menu arrangement (clears visibility + order; leaves module flags) ──
  await inj('POST', '/api/admin/modules/nav', token, { hrefs: ['/tips'], enabled: false }); // hide something first
  const reset = await inj('POST', '/api/admin/modules/nav-reset', token, {});
  ok('POST nav-reset → reset:true', (reset.status === 200 || reset.status === 201) && reset.json.reset === true, `status=${reset.status}`);
  const effReset = await inj('GET', '/api/modules/effective', token);
  ok('reset clears navDisabled + groupOrder + itemOrder', (effReset.json.navDisabled ?? []).length === 0 && (effReset.json.groupOrder ?? []).length === 0 && Object.keys(effReset.json.itemOrder ?? {}).length === 0, `nav=${JSON.stringify(effReset.json?.navDisabled)} order=${JSON.stringify(effReset.json?.groupOrder)} item=${JSON.stringify(effReset.json?.itemOrder)}`);
  ok('reset leaves module flags intact (marketing still enabled)', effReset.json.modules?.find((m: any) => m.key === 'marketing')?.enabled === true);

  // ── 1e. PER-TENANT ISOLATION (migration 0231 — each tenant configures its OWN menu + modules) ──
  // HQ disables marketing and hides /reservations; tenant T2 must be completely unaffected.
  await inj('POST', '/api/admin/modules', token, { key: 'marketing', enabled: false });
  await inj('POST', '/api/admin/modules/nav', token, { hrefs: ['/reservations'], enabled: false });

  const hqBlocked = await inj('GET', '/api/marketing/campaigns', token);
  ok('per-tenant module: HQ disabled → HQ 403', hqBlocked.status === 403 && hqBlocked.json?.error?.code === 'MODULE_DISABLED', `hq=${hqBlocked.status}`);
  const t2Ok = await inj('GET', '/api/marketing/campaigns', token2);
  ok('per-tenant module ISOLATION: T2 unaffected → 200', t2Ok.status === 200, `t2=${t2Ok.status}`);

  const effHQ = await inj('GET', '/api/modules/effective', token);
  const effT2 = await inj('GET', '/api/modules/effective', token2);
  ok('per-tenant nav ISOLATION: HQ hides /reservations, T2 does not',
    (effHQ.json.navDisabled ?? []).includes('/reservations') && !((effT2.json.navDisabled ?? []).includes('/reservations')),
    `hq=${JSON.stringify(effHQ.json?.navDisabled)} t2=${JSON.stringify(effT2.json?.navDisabled)}`);
  ok('per-tenant module ISOLATION (list): HQ marketing off, T2 on',
    effHQ.json.modules?.find((m: any) => m.key === 'marketing')?.enabled === false && effT2.json.modules?.find((m: any) => m.key === 'marketing')?.enabled === true);

  // Restore HQ so the master-data/QR sections below run clean.
  await inj('POST', '/api/admin/modules', token, { key: 'marketing', enabled: true });
  await inj('POST', '/api/admin/modules/nav-reset', token, {});

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
