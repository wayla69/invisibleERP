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
import { PERMISSIONS, PERM_GROUPS, DEFAULT_ROLE_PERMISSIONS, MODULE_KEYS, parseQrPayload, scanCodeId, unwrapQrUrl } from '@ierp/shared';
// The web app keeps a deliberate local mirror of the payload helpers (apps/web/src/lib/qr.ts — "kept
// local so web has no extra workspace dep"); imported here relatively to lock the two copies together.
import { parseQrPayload as webParseQrPayload, scanCodeId as webScanCodeId, unwrapQrUrl as webUnwrapQrUrl } from '../../../apps/web/src/lib/qr';

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
  // A second HQ user — the independent approver for the FA-11 custody maker-checker (approver ≠ requester).
  await db.insert(s.users).values({ username: 'checker', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq.id }).onConflictDoNothing();
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
  // An OLD asset, acquired long ago and never scan-verified — a deterministic FA-12 verification exception.
  await db.insert(s.fixedAssets).values({
    tenantId: hq.id, assetNo: 'FA-OLD', name: 'Old Cabinet', acquireDate: '2020-01-01',
    acquireCost: '1000', usefulLifeMonths: 120, netBookValue: '1000', status: 'active', location: 'Storage',
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

  // ── 3a. SCAN-UPDATE = FA-11 custody-change maker-checker ──────────────────
  const checkerLogin = await inj('POST', '/api/login', undefined, { username: 'checker', password: 'admin123' });
  const checkerTok = checkerLogin.json.token; // a DIFFERENT HQ user — the independent approver

  const scan = await inj('POST', '/api/assets/scan-update', token, { code: 'ASSET_ID:FA-TEST|DESC:Test Fridge', location: 'Room B', note: 'moved' });
  ok('scan-update change → PENDING custody request (no immediate move)', (scan.status === 200 || scan.status === 201) && scan.json.status === 'pending' && typeof scan.json.request_no === 'string', `status=${scan.status} st=${scan.json.status} req=${scan.json.request_no}`);
  const reqNo = scan.json.request_no;
  const preA = (await db.select().from(s.fixedAssets).where(eq(s.fixedAssets.assetNo, 'FA-TEST')))[0];
  ok('register NOT moved before approval', preA.location === 'Kitchen', `loc=${preA.location}`);

  const selfApprove = await inj('POST', `/api/assets/custody/${reqNo}/approve`, token);
  ok('self-approve custody → 403 SOD_VIOLATION (binds even Admin)', selfApprove.status === 403 && selfApprove.json?.error?.code === 'SOD_VIOLATION', `status=${selfApprove.status} code=${selfApprove.json?.error?.code}`);

  const approve = await inj('POST', `/api/assets/custody/${reqNo}/approve`, checkerTok);
  ok('different user approves → register moves to Room B', (approve.status === 200 || approve.status === 201) && approve.json.location === 'Room B' && approve.json.approved_by === 'checker', `status=${approve.status} loc=${approve.json.location} by=${approve.json.approved_by}`);

  const mv = await db.select().from(s.assetMovements).where(eq(s.assetMovements.assetNo, 'FA-TEST'));
  ok('Scan Update movement logged only on approval', mv.filter((m: any) => m.moveType === 'Scan Update' && m.toLocation === 'Room B').length === 1, `n=${mv.length}`);
  const postA = (await db.select().from(s.fixedAssets).where(eq(s.fixedAssets.assetNo, 'FA-TEST')))[0];
  ok('register location now Room B', postA.location === 'Room B', `loc=${postA.location}`);

  const verify = await inj('POST', '/api/assets/scan-update', token, { code: 'ASSET_ID:FA-TEST', location: 'Room B' });
  ok('scan-update same location → verified (no approval)', (verify.status === 200 || verify.status === 201) && verify.json.status === 'verified', `st=${verify.json.status}`);
  const vmv = await db.select().from(s.assetMovements).where(eq(s.assetMovements.assetNo, 'FA-TEST'));
  ok('Scan Verify movement logged for a presence confirmation', vmv.filter((m: any) => m.moveType === 'Scan Verify').length >= 1);

  const aLabels = await inj('GET', '/api/assets/qr/labels', token);
  ok('asset labels respond (pdf or html)', aLabels.status === 200 && (aLabels.ctype.includes('pdf') || aLabels.ctype.includes('html')), `ctype=${aLabels.ctype}`);

  const iLabels = await inj('POST', '/api/inventory/qr/labels', token, { item_ids: ['A'] });
  ok('inventory item labels respond', (iLabels.status === 200 || iLabels.status === 201) && (iLabels.ctype.includes('pdf') || iLabels.ctype.includes('html')), `status=${iLabels.status} ctype=${iLabels.ctype}`);

  // ── 3b. DEEP-LINK PAYLOAD (URL carrier) — same code works raw or as a /q?d=… URL ──────────
  const wrapped = `https://erp.example/q?d=${encodeURIComponent('ASSET_ID:FA-TEST|DESC:Test Fridge')}`;
  ok('parseQrPayload unwraps a /q?d= deep-link URL', parseQrPayload(wrapped).ASSET_ID === 'FA-TEST', `got=${parseQrPayload(wrapped).ASSET_ID}`);
  ok('parseQrPayload still handles a raw payload', parseQrPayload('ITEM_ID:A|DESC:Apple').ITEM_ID === 'A');
  ok('scanCodeId falls back to ASSET_ID (was dropped before)', scanCodeId('ASSET_ID:FA-9|DESC:x') === 'FA-9', `got=${scanCodeId('ASSET_ID:FA-9|DESC:x')}`);
  ok('scanCodeId reads a bare code', scanCodeId('P001') === 'P001');

  // scan-update accepts the URL-wrapped code end-to-end → raises a custody request (move to Zone C).
  const scanUrl = await inj('POST', '/api/assets/scan-update', token, { code: wrapped, location: 'Zone C' });
  ok('URL-wrapped scan-update → pending custody request', (scanUrl.status === 200 || scanUrl.status === 201) && scanUrl.json.status === 'pending' && scanUrl.json.asset_no === 'FA-TEST', `status=${scanUrl.status} st=${scanUrl.json.status} asset=${scanUrl.json.asset_no}`);
  const rej = await inj('POST', `/api/assets/custody/${scanUrl.json.request_no}/reject`, checkerTok, { reason: 'test' });
  ok('reject custody request', (rej.status === 200 || rej.status === 201) && rej.json.status === 'rejected', `st=${rej.json.status}`);

  // ── 3c. RESOLVE ENDPOINT (powers the /q resolver page) ───────────────────────────────────
  const resA = await inj('GET', `/api/scan/sessions/resolve?d=${encodeURIComponent('ASSET_ID:FA-TEST')}`, token);
  ok('resolve asset → kind=asset,id=FA-TEST', resA.status === 200 && resA.json.kind === 'asset' && resA.json.id === 'FA-TEST', `kind=${resA.json.kind} id=${resA.json.id}`);
  const resI = await inj('GET', '/api/scan/sessions/resolve?d=A', token);
  ok('resolve item → kind=item,id=A', resI.status === 200 && resI.json.kind === 'item' && resI.json.id === 'A', `kind=${resI.json.kind} id=${resI.json.id}`);
  const resUrl = await inj('GET', `/api/scan/sessions/resolve?d=${encodeURIComponent(wrapped)}`, token);
  ok('resolve accepts a URL-wrapped code', resUrl.status === 200 && resUrl.json.kind === 'asset' && resUrl.json.id === 'FA-TEST', `kind=${resUrl.json.kind} id=${resUrl.json.id}`);
  const resNone = await inj('GET', '/api/scan/sessions/resolve?d=NOPE-404', token);
  ok('resolve unknown code → kind=unknown', resNone.status === 200 && resNone.json.kind === 'unknown', `kind=${resNone.json.kind}`);

  // ── 3d. AUDIT-BY-SCAN (physical count → reconcile → raise custody requests) ──────────
  const openAudit = await inj('POST', '/api/assets/audits', token, { location: 'Room B' });
  ok('open audit → expected includes FA-TEST at Room B', (openAudit.status === 200 || openAudit.status === 201) && openAudit.json.expected_count === 1 && typeof openAudit.json.audit_no === 'string', `exp=${openAudit.json.expected_count}`);
  const auditNo = openAudit.json.audit_no;
  const sFound = await inj('POST', `/api/assets/audits/${auditNo}/scan`, token, { code: 'ASSET_ID:FA-TEST', client_uuid: 'u1' });
  ok('audit scan → Found (asset at audited location)', sFound.json.result === 'Found', `r=${sFound.json.result}`);
  const sDup = await inj('POST', `/api/assets/audits/${auditNo}/scan`, token, { code: 'ASSET_ID:FA-TEST', client_uuid: 'u1' });
  ok('audit scan offline replay deduped (client_uuid)', sDup.json.deduped === true, `dedup=${sDup.json.deduped}`);
  const sUnknown = await inj('POST', `/api/assets/audits/${auditNo}/scan`, token, { code: 'ASSET_ID:NOPE', client_uuid: 'u2' });
  ok('audit scan unknown code → Unknown', sUnknown.json.result === 'Unknown', `r=${sUnknown.json.result}`);
  const recon = await inj('GET', `/api/assets/audits/${auditNo}`, token);
  ok('audit reconcile: found 1, missing 0, unknown 1', recon.json.summary?.found === 1 && recon.json.summary?.missing === 0 && recon.json.summary?.unknown === 1, `sum=${JSON.stringify(recon.json.summary)}`);

  // A DIFFERENT-location audit → FA-TEST (register: Room B) reads Misplaced; closing raises a custody request.
  const audit2 = await inj('POST', '/api/assets/audits', token, { location: 'Room C' });
  const audit2No = audit2.json.audit_no;
  const sMis = await inj('POST', `/api/assets/audits/${audit2No}/scan`, token, { code: 'ASSET_ID:FA-TEST' });
  ok('audit scan at wrong location → Misplaced', sMis.json.result === 'Misplaced' && sMis.json.register_location === 'Room B', `r=${sMis.json.result} reg=${sMis.json.register_location}`);
  const close2 = await inj('POST', `/api/assets/audits/${audit2No}/close`, token);
  ok('close audit raises a custody request for the misplaced asset', (close2.status === 200 || close2.status === 201) && close2.json.custody_requests_raised === 1, `raised=${close2.json.custody_requests_raised}`);
  const custList = await inj('GET', '/api/assets/custody?status=PendingApproval', token);
  ok('audit-raised custody request pending (source=audit → Room C)', Array.isArray(custList.json.requests) && custList.json.requests.some((r: any) => r.asset_no === 'FA-TEST' && r.source === 'audit' && r.to_location === 'Room C'), `n=${custList.json.count}`);

  // ── 3e. BI SURFACES — audit results report + "not verified in N days" exception ──────────
  const unver = await inj('GET', '/api/assets/unverified?days=90', token);
  ok('unverified exceptions include the old never-scanned asset', unver.status === 200 && Array.isArray(unver.json.exceptions) && unver.json.exceptions.some((e: any) => e.asset_no === 'FA-OLD' && e.ever_verified === false), `count=${unver.json.count}`);
  ok('recently-verified asset is NOT an exception', !unver.json.exceptions.some((e: any) => e.asset_no === 'FA-TEST'), `fa-test present=${unver.json.exceptions.some((e: any) => e.asset_no === 'FA-TEST')}`);

  const auditRep = await inj('GET', '/api/assets/audit-report', token);
  ok('audit-report returns audits + custody exceptions', auditRep.status === 200 && Array.isArray(auditRep.json.audits) && auditRep.json.audits.length >= 2 && auditRep.json.totals.pending_custody >= 1, `audits=${auditRep.json.audits?.length} pending=${auditRep.json.totals?.pending_custody}`);

  const rtypes = await inj('GET', '/api/bi/report-types', token);
  const rkeys = (rtypes.json.report_types ?? []).map((r: any) => r.key);
  ok('BI report-types include asset_audit + asset_verification_exceptions', rkeys.includes('asset_audit') && rkeys.includes('asset_verification_exceptions'), `has=${rkeys.filter((k: string) => k.startsWith('asset_')).join(',')}`);

  // Schedule + run the exception report through the BI scheduler (proves it's a real schedulable report type).
  const sub = await inj('POST', '/api/bi/subscriptions', token, { name: 'Unverified assets', report_type: 'asset_verification_exceptions', frequency: 'monthly', filters: { days: 90 } });
  ok('create asset_verification_exceptions subscription', (sub.status === 200 || sub.status === 201) && sub.json.id != null, `status=${sub.status}`);
  const runRep = await inj('POST', `/api/bi/subscriptions/${sub.json.id}/run`, token);
  ok('run exception report → success + summary counts the exception', (runRep.status === 200 || runRep.status === 201) && runRep.json.status === 'success' && /not verified/.test(runRep.json.summary ?? ''), `status=${runRep.json.status} sum=${runRep.json.summary}`);

  // ── 3f. QR PAYLOAD HELPERS — pure-function checks + shared↔web mirror parity ──────────
  // Every carrier a scanned code arrives as: raw payload, ASSET_ID tag, bare code, deep-link URL
  // (?d=/&code=/#payload=), '+'-as-space, malformed % sequences, empty input.
  {
    const p = parseQrPayload('ITEM_ID:P001|DESC:Rice 5kg|UOM:BAG|PRICE:120|CAT:Dry');
    ok('parseQrPayload raw item payload', p.ITEM_ID === 'P001' && p.DESC === 'Rice 5kg' && p.UOM === 'BAG' && p.PRICE === '120' && p.CAT === 'Dry', JSON.stringify(p));
    ok('scanCodeId prefers ITEM_ID', scanCodeId('ITEM_ID:P001|DESC:x') === 'P001');
    ok('scanCodeId falls back to ASSET_ID', scanCodeId('ASSET_ID:FA-9|DESC:x') === 'FA-9');
    ok('scanCodeId treats a bare code as an item id', scanCodeId('8850001234570') === '8850001234570');
    ok('scanCodeId empty/null-ish input → undefined', scanCodeId('') === undefined && scanCodeId(null) === undefined && scanCodeId(undefined) === undefined);
    ok('unwrapQrUrl ?d= deep link', unwrapQrUrl('https://x/q?d=ITEM_ID%3AA%7CDESC%3AApple') === 'ITEM_ID:A|DESC:Apple');
    ok('unwrapQrUrl &code= param', unwrapQrUrl('https://x/p?x=1&code=ITEM_ID%3AB') === 'ITEM_ID:B');
    ok('unwrapQrUrl #payload= fragment', unwrapQrUrl('https://x/p#payload=ITEM_ID%3AC') === 'ITEM_ID:C');
    ok('unwrapQrUrl decodes + as space', unwrapQrUrl('/q?d=ITEM_ID%3AA%7CDESC%3AGreen+Tea').includes('DESC:Green Tea'));
    ok('unwrapQrUrl malformed % falls back to the raw param', unwrapQrUrl('/q?d=100%zz') === '100%zz');
    ok('unwrapQrUrl non-URL text passes through', unwrapQrUrl('ITEM_ID:A|DESC:x') === 'ITEM_ID:A|DESC:x');

    const MIRROR_INPUTS: (string | null | undefined)[] = [
      'ITEM_ID:P001|DESC:Rice 5kg|UOM:BAG|PRICE:120|CAT:Dry',
      'ASSET_ID:FA-9|DESC:Fridge|LOC:Kitchen',
      '8850001234570',
      'https://x/q?d=ITEM_ID%3AA%7CDESC%3AApple',
      'https://x/p?x=1&code=ITEM_ID%3AB',
      'https://x/p#payload=ITEM_ID%3AC',
      '/q?d=ITEM_ID%3AA%7CDESC%3AGreen+Tea',
      '/q?d=100%zz',
      '  ITEM_ID:T |DESC: spaced ',
      '', null, undefined,
    ];
    const mirrorOk = MIRROR_INPUTS.every((i) =>
      JSON.stringify(parseQrPayload(i)) === JSON.stringify(webParseQrPayload(i)) &&
      scanCodeId(i) === webScanCodeId(i) &&
      unwrapQrUrl(i) === webUnwrapQrUrl(i));
    ok('web qr.ts mirror stays byte-identical to @ierp/shared over all carriers', mirrorOk);
  }

  await app.close();
  await pg.close();

  console.log('\n── Module flags + Master-data + QR (real Nest app, PGlite) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
