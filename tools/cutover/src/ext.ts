/**
 * Extension validation — boot Nest app จริง in-process (PGlite) ยิง HTTP จำลอง ตรวจ module ใหม่:
 * customer-portal, marketing/loyalty/bom, reports (ExcelJS), SSE chat route. (Admin bypass RBAC,
 * tenant=HQ ผ่าน customerName.)  pnpm --filter @ierp/cutover ext
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ext-secret';
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

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  // seed
  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k, grp: grpOf(k) }))).onConflictDoNothing();
  for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((perms as string[]).map((perm) => ({ role: role as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }]).onConflictDoNothing();
  const hq = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq.id },
    { username: 'hqwh', passwordHash: await pw.hash('pw'), role: 'Warehouse', tenantId: hq.id }, // HQ-scoped, non-admin (alerts isolation)
  ]).onConflictDoNothing();
  // seed permissions + role→perm map so non-Admin (RLS-scoped) users can be permission-checked
  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: true, pointsPerBaht: '1.0', bahtPerPoint: '0.1' }).onConflictDoNothing();
  for (const [id, desc, qty] of [['A', 'Apple', 5], ['B', 'Banana', -2]] as [string, string, number][]) {
    await db.insert(s.items).values({ itemId: id, itemDescription: desc, uom: 'EA', unitPrice: '10' }).onConflictDoNothing();
    await db.insert(s.stockSnapshots).values({ generateDate: new Date(), itemId: id, itemDescription: desc, uom: 'EA', avQty: String(qty), totalStock: String(qty) });
  }
  // customer_inventory for HQ tenant (portal POS will decrement)
  await db.insert(s.customerInventory).values({ tenantId: hq.id, itemId: 'A', itemDescription: 'Apple', uom: 'EA', currentStock: '10', reorderPoint: '5', reorderQty: '20' });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const inj = async (method: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: method as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json, raw: res.rawPayload as Buffer };
  };

  const login = await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' });
  const token = login.json.token;
  ok('login 200', login.status === 200 && !!token);

  // ── GET smoke: route exists + DI + read query OK (200) ──
  const gets = [
    '/api/marketing/campaigns', '/api/marketing/segments', '/api/marketing/ab-tests', '/api/promotions', '/api/price-list', '/api/surveys',
    '/api/loyalty/config', '/api/loyalty/me',
    '/api/bom/master', '/api/bom/submissions',
    '/api/portal/dashboard', '/api/portal/inventory', '/api/portal/pending-orders', '/api/portal/track', '/api/portal/my/customers', '/api/portal/my/suppliers', '/api/portal/my/purchase-orders', '/api/portal/pos/sales',
  ];
  for (const ep of gets) {
    const r = await inj('GET', ep, token);
    ok(`GET ${ep} → 200`, r.status === 200, `status=${r.status}`);
  }

  // ── Promotion mint: two created back-to-back get distinct promo_id (same-second collision guard) ──
  const p1 = await inj('POST', '/api/promotions', token, { promo_name: 'Promo A', promo_type: 'Percent', discount_pct: 10 });
  const p2 = await inj('POST', '/api/promotions', token, { promo_name: 'Promo B', promo_type: 'Percent', discount_pct: 20 });
  ok('promotion #1 create 200/201', p1.status === 200 || p1.status === 201, `status=${p1.status} ${JSON.stringify(p1.json).slice(0, 120)}`);
  ok('promotion #2 create 200/201 (no same-second 409)', p2.status === 200 || p2.status === 201, `status=${p2.status} ${JSON.stringify(p2.json).slice(0, 120)}`);
  ok('back-to-back promotions get distinct PROMO- ids',
    /^PROMO-/.test(p1.json.promo_id ?? '') && /^PROMO-/.test(p2.json.promo_id ?? '') && p1.json.promo_id !== p2.json.promo_id,
    `${p1.json.promo_id} vs ${p2.json.promo_id}`);

  // ── ExcelJS report export → valid .xlsx (PK zip magic) ──
  const xlsx = await inj('GET', '/api/reports/stock-summary/export', token);
  ok('reports stock-summary/export → xlsx (PK magic)', xlsx.status === 200 && xlsx.raw && xlsx.raw[0] === 0x50 && xlsx.raw[1] === 0x4b, `status=${xlsx.status} bytes=${xlsx.raw?.length}`);

  // ── Portal POS sale: SALE- + VAT 7% + inventory decrement + loyalty ──
  const sale = await inj('POST', '/api/portal/pos/sales', token, { items: [{ item_id: 'A', qty: 2, unit_price: 50 }] });
  ok('portal POS sale → SALE- + total 107 (VAT 7%)', (sale.status === 200 || sale.status === 201) && /^SALE-/.test(sale.json.sale_no ?? sale.json.saleNo ?? '') && near(sale.json.total, 107), `status=${sale.status} ${JSON.stringify(sale.json).slice(0, 120)}`);
  const inv = (await db.select().from(s.customerInventory).where(and(eq(s.customerInventory.tenantId, hq.id), eq(s.customerInventory.itemId, 'A'))))[0];
  ok('portal sale decremented inventory 10→8', Number(inv?.currentStock) === 8, `stock=${inv?.currentStock}`);
  const lp = (await db.select().from(s.loyaltyPoints).where(eq(s.loyaltyPoints.tenantId, hq.id)))[0];
  ok('portal sale earned loyalty points', Number(lp?.balance) > 0, `balance=${lp?.balance}`);

  // ── Mini-ERP write: my/customers create + list ──
  const addC = await inj('POST', '/api/portal/my/customers', token, { customer_name: 'ลูกค้า ก' });
  ok('portal my/customers create 200/201', addC.status === 200 || addC.status === 201, `status=${addC.status}`);
  const listC = await inj('GET', '/api/portal/my/customers', token);
  ok('portal my/customers list has 1', Array.isArray(listC.json) ? listC.json.length >= 1 : (listC.json.customers?.length ?? listC.json.data?.length ?? 0) >= 1, JSON.stringify(listC.json).slice(0, 80));

  // ── SSE chat route exists (no AI key → stream yields a note, not 404) ──
  const sse = await inj('GET', '/api/chat/stream?message=hi', token);
  ok('GET /api/chat/stream exists (not 404)', sse.status !== 404, `status=${sse.status}`);

  // ── custom fields (UDFs) ──
  // a second tenant + admin to prove isolation
  await db.insert(s.tenants).values([{ code: 'CF2', name: 'CF Tenant 2' }]).onConflictDoNothing();
  const cf2 = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'CF2')))[0];
  // non-Admin role so the request is RLS-scoped (Admin bypasses isolation by design); Warehouse carries 'masterdata'
  await db.insert(s.users).values({ username: 'cfwh2', passwordHash: await pw.hash('pw2'), role: 'Warehouse', tenantId: cf2.id }).onConflictDoNothing();
  const token2 = (await inj('POST', '/api/login', undefined, { username: 'cfwh2', password: 'pw2' })).json.token;

  const defText = await inj('POST', '/api/custom-fields/defs', token, { entity: 'customer', label: 'Sales rep', data_type: 'text' });
  ok('Custom fields: define a text field (label → field_key slug)', (defText.status === 200 || defText.status === 201) && defText.json.field_key === 'sales_rep' && defText.json.entity === 'customer', `${defText.status} ${JSON.stringify(defText.json)}`);
  await inj('POST', '/api/custom-fields/defs', token, { entity: 'customer', label: 'Credit tier', data_type: 'select', options: ['A', 'B', 'C'], required: true });
  await inj('POST', '/api/custom-fields/defs', token, { entity: 'customer', label: 'Onboarded', data_type: 'date' });
  const defs = await inj('GET', '/api/custom-fields/defs?entity=customer', token);
  ok('Custom fields: list definitions for an entity', (defs.json.fields ?? []).length === 3 && (defs.json.fields ?? []).some((f: any) => f.field_key === 'credit_tier' && f.data_type === 'select' && f.required), `${(defs.json.fields ?? []).length}`);

  const setBad = await inj('PUT', '/api/custom-fields/values', token, { entity: 'customer', record_id: 'CUST-1', values: { sales_rep: 'Anan' } });
  ok('Custom fields: missing a required field is rejected (400 REQUIRED_FIELD)', setBad.status === 400 && setBad.json.error?.code === 'REQUIRED_FIELD', `${setBad.status} ${setBad.json.error?.code}`);
  const setOpt = await inj('PUT', '/api/custom-fields/values', token, { entity: 'customer', record_id: 'CUST-1', values: { sales_rep: 'Anan', credit_tier: 'Z' } });
  ok('Custom fields: an out-of-list select value is rejected (400 BAD_OPTION)', setOpt.status === 400 && setOpt.json.error?.code === 'BAD_OPTION', `${setOpt.status} ${setOpt.json.error?.code}`);
  const setUnknown = await inj('PUT', '/api/custom-fields/values', token, { entity: 'customer', record_id: 'CUST-1', values: { sales_rep: 'Anan', credit_tier: 'A', nope: 'x' } });
  ok('Custom fields: an undefined field key is rejected (400 UNKNOWN_FIELD)', setUnknown.status === 400 && setUnknown.json.error?.code === 'UNKNOWN_FIELD', `${setUnknown.status} ${setUnknown.json.error?.code}`);
  const setOk = await inj('PUT', '/api/custom-fields/values', token, { entity: 'customer', record_id: 'CUST-1', values: { sales_rep: 'Anan', credit_tier: 'A', onboarded: '2026-06-01' } });
  ok('Custom fields: valid values saved (typed + validated)', (setOk.status === 200 || setOk.status === 201) && setOk.json.values?.credit_tier === 'A', `${setOk.status} ${JSON.stringify(setOk.json.values ?? {})}`);
  const get = await inj('GET', '/api/custom-fields/values?entity=customer&record_id=CUST-1', token);
  const repField = (get.json.fields ?? []).find((f: any) => f.field_key === 'sales_rep');
  const dateField = (get.json.fields ?? []).find((f: any) => f.field_key === 'onboarded');
  ok('Custom fields: values returned typed alongside their definitions', repField?.value === 'Anan' && dateField?.value === '2026-06-01' && dateField?.data_type === 'date', `${JSON.stringify(get.json.fields ?? []).slice(0, 140)}`);
  const bulk = await inj('POST', '/api/custom-fields/values/bulk', token, { entity: 'customer', record_ids: ['CUST-1', 'CUST-2'] });
  ok('Custom fields: bulk value load keys by record (for list views)', bulk.json.records?.['CUST-1']?.sales_rep === 'Anan' && bulk.json.records?.['CUST-2'] === undefined, `${JSON.stringify(bulk.json.records ?? {})}`);
  const t2defs = await inj('GET', '/api/custom-fields/defs?entity=customer', token2);
  ok('Custom fields: definitions are tenant-isolated (T2 sees none of T1’s)', (t2defs.json.fields ?? []).length === 0, `T2 defs=${(t2defs.json.fields ?? []).length}`);

  // ── alert/notification rules engine (Phase 3) ──
  const hqwh = (await inj('POST', '/api/login', undefined, { username: 'hqwh', password: 'pw' })).json.token;
  // seed a below-reorder inventory row in cf2 so the low_stock metric trips for that tenant (RLS-scoped)
  await db.insert(s.customerInventory).values({ tenantId: cf2.id, itemId: 'LOW1', itemDescription: 'ของใกล้หมด', uom: 'EA', currentStock: '2', reorderPoint: '5', reorderQty: '20' });
  const metrics = await inj('GET', '/api/alerts/metrics', token2);
  ok('Alerts: metric catalog exposes built-in metrics + operators', (metrics.json.metrics ?? []).some((m: any) => m.key === 'low_stock_count') && (metrics.json.operators ?? []).includes('gte'), `${(metrics.json.metrics ?? []).length}`);
  const preview = await inj('GET', '/api/alerts/preview', token2);
  ok('Alerts: preview computes current metric values (low_stock_count ≥ 1 for the tenant)', (preview.json.values?.low_stock_count ?? 0) >= 1, `${JSON.stringify(preview.json.values ?? {})}`);
  const rule = await inj('POST', '/api/alerts/rules', token2, { name: 'สินค้าใกล้หมด', metric: 'low_stock_count', operator: 'gte', threshold: 1, channel: 'notification', target_role: 'Warehouse', severity: 'warning', cooldown_hours: 12 });
  ok('Alerts: create a rule (validated metric/operator/channel)', (rule.status === 200 || rule.status === 201) && !!rule.json.id, `${rule.status}`);
  const badMetric = await inj('POST', '/api/alerts/rules', token2, { name: 'x', metric: 'nope', operator: 'gte', threshold: 1, channel: 'notification' });
  ok('Alerts: an unknown metric is rejected (400 BAD_METRIC)', badMetric.status === 400 && badMetric.json.error?.code === 'BAD_METRIC', `${badMetric.status} ${badMetric.json.error?.code}`);
  const run1 = await inj('POST', '/api/alerts/run', token2);
  ok('Alerts: sweep fires the breached rule (writes a notification + event)', (run1.json.fired_count ?? 0) >= 1 && (run1.json.fired ?? []).some((f: any) => f.metric === 'low_stock_count'), `${JSON.stringify(run1.json)}`);
  const run2 = await inj('POST', '/api/alerts/run', token2);
  ok('Alerts: cooldown suppresses an immediate re-fire', (run2.json.fired_count ?? 0) === 0 && (run2.json.suppressed ?? 0) >= 1, `${JSON.stringify(run2.json)}`);
  const events = await inj('GET', '/api/alerts/events', token2);
  ok('Alerts: the fire is logged to the event feed', (events.json.events ?? []).some((e: any) => e.metric === 'low_stock_count' && e.value >= 1), `${(events.json.events ?? []).length}`);
  const hqRules = await inj('GET', '/api/alerts/rules', hqwh);
  ok('Alerts: rules are tenant-isolated (HQ sees none of cf2’s)', (hqRules.json.rules ?? []).every((r: any) => r.id !== rule.json.id), `HQ rules=${(hqRules.json.rules ?? []).length}`);

  await app.close();
  await pg.close();

  console.log('\n── Extensions e2e (portal / marketing / loyalty / bom / reports / sse) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} extension checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} extension checks passed`);
}

const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.01;
main().catch((e) => { console.error(e); process.exit(1); });
