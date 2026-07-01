/**
 * Extension validation — boot Nest app จริง in-process (PGlite) ยิง HTTP จำลอง ตรวจ module ใหม่:
 * customer-portal, marketing/loyalty/bom, reports (ExcelJS), SSE chat route. (Admin bypass RBAC,
 * tenant=HQ ผ่าน customerName.)  pnpm --filter @ierp/cutover ext
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ext-secret';
process.env.NODE_ENV = 'test';
// Cap the public-API per-key rate limit low so the harness can trip it deterministically.
process.env.PUBLIC_API_RATE_MAX = process.env.PUBLIC_API_RATE_MAX || '50';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, and } from 'drizzle-orm';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import * as s from '../../../apps/api/dist/database/schema/index';
import { AppModule } from '../../../apps/api/dist/app.module';
import { signHs256 } from '../../../apps/api/dist/modules/identity/jwt-hs256';
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

  // ── notification inbox (Phase #2) — per-user read state over the notifications table ──
  // The alert sweep above wrote a notification for cf2 + target_role 'Warehouse'. cfwh2
  // (Warehouse@cf2) must see it; hqwh (Warehouse@HQ) must NOT (the table isn't RLS-scoped,
  // so the inbox query filters by target_tenant_id explicitly).
  const inbox1 = await inj('GET', '/api/notifications/inbox', token2);
  ok('Inbox: the alert notification appears for the targeted (tenant,role) user', (inbox1.json.items ?? []).length >= 1 && (inbox1.json.unread_count ?? 0) >= 1, `items=${(inbox1.json.items ?? []).length} unread=${inbox1.json.unread_count}`);
  const hqInbox = await inj('GET', '/api/notifications/inbox', hqwh);
  ok('Inbox: tenant-isolated (HQ Warehouse sees none of cf2’s notifications)', (hqInbox.json.items ?? []).length === 0 && (hqInbox.json.unread_count ?? 0) === 0, `items=${(hqInbox.json.items ?? []).length}`);

  // broadcast (target_role NULL) is visible to ANY role in the tenant; a role-targeted note is not
  await db.insert(s.notifications).values({ targetTenantId: cf2.id, targetRole: null, message: 'ประกาศทั้งระบบ', messageEn: 'System broadcast' });
  await db.insert(s.notifications).values({ targetTenantId: cf2.id, targetRole: 'Planner', message: 'เฉพาะ Planner', messageEn: 'Planner only' });
  const wInbox = await inj('GET', '/api/notifications/inbox', token2);
  ok('Inbox: a tenant broadcast is visible to all roles; another role’s targeted note is hidden', (wInbox.json.items ?? []).some((i: any) => i.message_en === 'System broadcast') && !(wInbox.json.items ?? []).some((i: any) => i.message_en === 'Planner only'), `seen=${JSON.stringify((wInbox.json.items ?? []).map((i: any) => i.message_en))}`);

  // mark one read → unread count drops, and the unread_only filter then hides it
  const broadcast = (wInbox.json.items ?? []).find((i: any) => i.message_en === 'System broadcast');
  const beforeUnread = (await inj('GET', '/api/notifications/unread-count', token2)).json.unread_count;
  const markR = await inj('POST', `/api/notifications/${broadcast.id}/read`, token2);
  ok('Inbox: mark-read flips state and decrements the unread count', markR.json.ok === true && markR.json.unread_count === beforeUnread - 1, `${JSON.stringify(markR.json)} before=${beforeUnread}`);
  const unreadOnly = await inj('GET', '/api/notifications/inbox?unread_only=1', token2);
  ok('Inbox: the unread_only filter excludes a just-read item', !(unreadOnly.json.items ?? []).some((i: any) => i.id === broadcast.id), `ids=${JSON.stringify((unreadOnly.json.items ?? []).map((i: any) => i.id))}`);

  // a user cannot mark-read a notification not visible to them (the Planner-only one)
  const planOnly = (await db.select().from(s.notifications).where(eq(s.notifications.messageEn, 'Planner only')))[0];
  const sneaky = await inj('POST', `/api/notifications/${planOnly.id}/read`, token2);
  ok('Inbox: cannot mark-read a notification targeted at another role', sneaky.json.ok === false, `${JSON.stringify(sneaky.json)}`);

  // mark-all-read clears the badge for the caller only
  const markAll = await inj('POST', '/api/notifications/mark-all-read', token2);
  ok('Inbox: mark-all-read clears the caller’s unread count to 0', markAll.json.ok === true && markAll.json.unread_count === 0, `${JSON.stringify(markAll.json)}`);
  const finalCount = await inj('GET', '/api/notifications/unread-count', token2);
  ok('Inbox: unread-count is 0 after mark-all-read', finalCount.json.unread_count === 0, `${finalCount.json.unread_count}`);

  // ── scheduled-report execution engine (Phase 4) ──
  // Planner role carries 'exec' (the /api/bi gate) and is non-Admin → requests are RLS-scoped.
  await db.insert(s.users).values([
    { username: 'hqex', passwordHash: await pw.hash('pw'), role: 'Planner', tenantId: hq.id },
    { username: 'cf2ex', passwordHash: await pw.hash('pw'), role: 'Planner', tenantId: cf2.id },
  ]).onConflictDoNothing();
  // Planner role is now SoD-clean; hqex/cf2ex need 'exec' for BI subscriptions and dashboard layout
  // configuration — they keep the old bundled perms via per-user override.
  for (const un of ['hqex', 'cf2ex']) {
    const uid = Number((await db.select().from(s.users).where(eq(s.users.username, un)))[0].id);
    await db.insert(s.userPermissions).values(
      ['dashboard', 'exec', 'warehouse', 'procurement', 'planner', 'masterdata', 'approvals'].map((perm) => ({ userId: uid, perm })),
    ).onConflictDoNothing();
  }
  const hqex = (await inj('POST', '/api/login', undefined, { username: 'hqex', password: 'pw' })).json.token;
  const cf2ex = (await inj('POST', '/api/login', undefined, { username: 'cf2ex', password: 'pw' })).json.token;

  const rtypes = await inj('GET', '/api/bi/report-types', cf2ex);
  ok('Scheduled reports: report-type catalog exposes built-ins + frequencies', (rtypes.json.report_types ?? []).some((r: any) => r.key === 'kpi_board') && (rtypes.json.frequencies ?? []).includes('daily'), `${(rtypes.json.report_types ?? []).length}`);
  const subBadType = await inj('POST', '/api/bi/subscriptions', cf2ex, { name: 'x', report_type: 'nope', frequency: 'daily' });
  ok('Scheduled reports: unknown report_type rejected (400 BAD_REPORT_TYPE)', subBadType.status === 400 && subBadType.json.error?.code === 'BAD_REPORT_TYPE', `${subBadType.status} ${subBadType.json.error?.code}`);
  const subBadFreq = await inj('POST', '/api/bi/subscriptions', cf2ex, { name: 'x', report_type: 'kpi_board', frequency: 'hourly' });
  ok('Scheduled reports: bad frequency rejected (400 BAD_FREQUENCY)', subBadFreq.status === 400 && subBadFreq.json.error?.code === 'BAD_FREQUENCY', `${subBadFreq.status} ${subBadFreq.json.error?.code}`);
  const sub = await inj('POST', '/api/bi/subscriptions', cf2ex, { name: 'รายงาน KPI รายวัน', report_type: 'kpi_board', frequency: 'daily', recipients: [{ email: 'cfo@cf2.test' }] });
  ok('Scheduled reports: create a subscription (validated type + frequency)', (sub.status === 200 || sub.status === 201) && !!sub.json.id, `${sub.status}`);
  const sweep = await inj('POST', '/api/bi/subscriptions/run', cf2ex);
  ok('Scheduled reports: sweep runs due subscriptions (generates + records a run)', (sweep.json.ran_count ?? 0) >= 1 && (sweep.json.runs ?? []).some((r: any) => r.report_type === 'kpi_board' && r.status === 'success'), `${JSON.stringify(sweep.json).slice(0, 140)}`);
  const sweep2 = await inj('POST', '/api/bi/subscriptions/run', cf2ex);
  ok('Scheduled reports: a freshly-run subscription is no longer due (schedule advanced)', (sweep2.json.ran_count ?? 0) === 0, `${JSON.stringify(sweep2.json)}`);
  const runNow = await inj('POST', `/api/bi/subscriptions/${sub.json.id}/run`, cf2ex);
  ok('Scheduled reports: run-now executes a single subscription on demand', (runNow.status === 200 || runNow.status === 201) && runNow.json.status === 'success', `${runNow.status} ${runNow.json.status}`);
  const cfRuns = await inj('GET', '/api/bi/runs', cf2ex);
  ok('Scheduled reports: run history records the executions', (cfRuns.json.runs ?? []).filter((r: any) => r.report_type === 'kpi_board' && r.status === 'success').length >= 2, `runs=${(cfRuns.json.runs ?? []).length}`);
  const hqRuns = await inj('GET', '/api/bi/runs', hqex);
  ok('Scheduled reports: run history is tenant-isolated (HQ sees none of cf2’s)', (hqRuns.json.runs ?? []).every((r: any) => r.name !== 'รายงาน KPI รายวัน'), `HQ runs=${(hqRuns.json.runs ?? []).length}`);

  // ── saved views (Phase 4) ──
  // token2 = cfwh2 (Warehouse@CF2, non-admin), cf2ex = Planner@CF2 (same tenant), hqwh = Warehouse@HQ.
  const svPersonal = await inj('POST', '/api/saved-views', token2, { module: 'inventory', name: 'สต๊อกต่ำของฉัน', config: { filter: { low: true }, sort: 'qty' }, shared: false });
  ok('Saved views: create a personal view', (svPersonal.status === 200 || svPersonal.status === 201) && !!svPersonal.json.id && svPersonal.json.mine === true, `${svPersonal.status}`);
  const svShared = await inj('POST', '/api/saved-views', token2, { module: 'inventory', name: 'มุมมองรวม', config: {}, shared: true });
  ok('Saved views: create a shared view', (svShared.status === 200 || svShared.status === 201) && svShared.json.shared === true, `${svShared.status}`);
  const svMine = await inj('GET', '/api/saved-views?module=inventory', token2);
  ok('Saved views: owner sees both their personal and shared views', (svMine.json.views ?? []).some((v: any) => v.name === 'สต๊อกต่ำของฉัน') && (svMine.json.views ?? []).some((v: any) => v.name === 'มุมมองรวม'), `mine=${(svMine.json.views ?? []).length}`);
  const svOther = await inj('GET', '/api/saved-views?module=inventory', cf2ex);
  ok('Saved views: another tenant user sees shared views but not personal ones', (svOther.json.views ?? []).some((v: any) => v.name === 'มุมมองรวม') && (svOther.json.views ?? []).every((v: any) => v.name !== 'สต๊อกต่ำของฉัน'), `other=${(svOther.json.views ?? []).length}`);
  const svHq = await inj('GET', '/api/saved-views?module=inventory', hqwh);
  ok('Saved views: tenant-isolated (HQ sees none of cf2’s)', (svHq.json.views ?? []).length === 0, `HQ views=${(svHq.json.views ?? []).length}`);
  const svDelOther = await inj('DELETE', `/api/saved-views/${svPersonal.json.id}`, cf2ex);
  ok('Saved views: a non-owner cannot delete someone’s view (404)', svDelOther.status === 404, `${svDelOther.status}`);
  const svDel = await inj('DELETE', `/api/saved-views/${svPersonal.json.id}`, token2);
  ok('Saved views: the owner can delete their view', svDel.status === 200 && svDel.json.deleted === true, `${svDel.status}`);

  // ── role-based dashboard layouts (Phase 5) ──
  // ExecutiveViewer carries `dashboard` (can view the dashboard) but NOT `exec`/`ar`/`creditors` — perfect to
  // prove per-widget permission filtering. hqex (Planner) carries `exec` → can configure layouts.
  await db.insert(s.users).values({ username: 'hqev', passwordHash: await pw.hash('pw'), role: 'ExecutiveViewer', tenantId: hq.id }).onConflictDoNothing();
  const hqev = (await inj('POST', '/api/login', undefined, { username: 'hqev', password: 'pw' })).json.token;

  const catalog = await inj('GET', '/api/dashboard/widgets/catalog', hqex);
  ok('Dashboards: widget catalog + role list exposed', (catalog.json.widgets ?? []).some((w: any) => w.key === 'today_sales') && (catalog.json.roles ?? []).includes('ExecutiveViewer'), `${(catalog.json.widgets ?? []).length} widgets`);
  const badRole = await inj('PUT', '/api/dashboard/layouts/NotARole', hqex, { widgets: [] });
  ok('Dashboards: an unknown role is rejected (400 BAD_ROLE)', badRole.status === 400 && badRole.json.error?.code === 'BAD_ROLE', `${badRole.status} ${badRole.json.error?.code}`);
  const badWidget = await inj('PUT', '/api/dashboard/layouts/ExecutiveViewer', hqex, { widgets: ['nope'] });
  ok('Dashboards: an unknown widget key is rejected (400 BAD_WIDGET)', badWidget.status === 400 && badWidget.json.error?.code === 'BAD_WIDGET', `${badWidget.status} ${badWidget.json.error?.code}`);
  const setLayout = await inj('PUT', '/api/dashboard/layouts/ExecutiveViewer', hqex, { widgets: ['today_sales', 'open_ar', 'outstanding_ap', 'low_stock', 'open_pipeline'] });
  ok('Dashboards: admin sets a per-role layout', setLayout.status === 200 && (setLayout.json.widgets ?? []).length === 5, `${setLayout.status} ${(setLayout.json.widgets ?? []).length}`);
  const getLayout = await inj('GET', '/api/dashboard/layouts/ExecutiveViewer', hqex);
  ok('Dashboards: the configured layout reads back', getLayout.json.configured === true && (getLayout.json.widgets ?? []).length === 5, `${JSON.stringify(getLayout.json.widgets ?? [])}`);
  const mine = await inj('GET', '/api/dashboard/layout/me', hqev);
  const mineKeys = (mine.json.widgets ?? []).map((w: any) => w.key);
  ok('Dashboards: resolved layout is filtered to the viewer’s permissions (no AR/AP for ExecutiveViewer)',
    mineKeys.includes('today_sales') && mineKeys.includes('low_stock') && mineKeys.includes('open_pipeline') && !mineKeys.includes('open_ar') && !mineKeys.includes('outstanding_ap'),
    `keys=${JSON.stringify(mineKeys)}`);
  ok('Dashboards: each resolved widget carries a live numeric value', (mine.json.widgets ?? []).length > 0 && (mine.json.widgets ?? []).every((w: any) => typeof w.value === 'number'), `${JSON.stringify(mine.json.widgets ?? [])}`);
  const mineDefault = await inj('GET', '/api/dashboard/layout/me', hqex);
  ok('Dashboards: an unconfigured role falls back to the default layout', mineDefault.json.configured === false && (mineDefault.json.widgets ?? []).length >= 4, `configured=${mineDefault.json.configured} n=${(mineDefault.json.widgets ?? []).length}`);
  const t2Layout = await inj('GET', '/api/dashboard/layouts/ExecutiveViewer', cf2ex);
  ok('Dashboards: layouts are tenant-isolated (cf2 sees none of HQ’s)', t2Layout.json.configured === false && (t2Layout.json.widgets ?? []).length === 0, `configured=${t2Layout.json.configured}`);

  // ── audit-trail viewer (Phase 6) ──
  // AccessAdmin carries only `users` and is non-Admin → its reads are RLS-scoped (proves isolation).
  await db.insert(s.users).values([
    { username: 'hqaa', passwordHash: await pw.hash('pw'), role: 'AccessAdmin', tenantId: hq.id },
    { username: 'cf2aa', passwordHash: await pw.hash('pw'), role: 'AccessAdmin', tenantId: cf2.id },
  ]).onConflictDoNothing();
  const hqaa = (await inj('POST', '/api/login', undefined, { username: 'hqaa', password: 'pw' })).json.token;
  const cf2aa = (await inj('POST', '/api/login', undefined, { username: 'cf2aa', password: 'pw' })).json.token;
  // a guaranteed cf2-tenant mutation → one known audit row (actor cfwh2, tenant cf2)
  await inj('POST', '/api/saved-views', token2, { module: 'audit-probe', name: 'AUDITPROBE', config: {}, shared: false });

  const audit = await inj('GET', '/api/admin/audit?limit=10', token);
  ok('Audit viewer: paginated query returns rows + total', audit.status === 200 && Array.isArray(audit.json.rows) && audit.json.rows.length <= 10 && typeof audit.json.total === 'number' && audit.json.total > 0, `status=${audit.status} total=${audit.json.total}`);
  const byAction = await inj('GET', '/api/admin/audit?action=saved-views&limit=50', token);
  ok('Audit viewer: action filter matches (substring)', (byAction.json.rows ?? []).length >= 1 && (byAction.json.rows ?? []).every((r: any) => (r.action ?? '').includes('saved-views')), `n=${(byAction.json.rows ?? []).length}`);
  const byStatus = await inj('GET', '/api/admin/audit?status=success&limit=50', token);
  ok('Audit viewer: status filter matches', (byStatus.json.rows ?? []).length >= 1 && (byStatus.json.rows ?? []).every((r: any) => r.status === 'success'), `n=${(byStatus.json.rows ?? []).length}`);
  const badQ = await inj('GET', '/api/admin/audit?limit=abc', token);
  ok('Audit viewer: a non-numeric limit is rejected (400 BAD_QUERY)', badQ.status === 400 && badQ.json.error?.code === 'BAD_QUERY', `${badQ.status} ${badQ.json.error?.code}`);
  const csv = await inj('GET', '/api/admin/audit/export', token);
  ok('Audit viewer: CSV export with header row', csv.status === 200 && (csv.raw?.toString('utf8') ?? '').startsWith('id,ts,actor,tenant_id,action'), `status=${csv.status} head=${(csv.raw?.toString('utf8') ?? '').slice(0, 24)}`);
  const noPerm = await inj('GET', '/api/admin/audit', token2); // cfwh2 = Warehouse, lacks `users`
  ok('Audit viewer: gated by the users permission (403 without it)', noPerm.status === 403, `${noPerm.status}`);
  const cf2Audit = await inj('GET', '/api/admin/audit?limit=200', cf2aa);
  ok('Audit viewer: RLS-scoped — a tenant admin sees only its own tenant rows', (cf2Audit.json.rows ?? []).length >= 1 && (cf2Audit.json.rows ?? []).every((r: any) => r.tenant_id === cf2.id), `n=${(cf2Audit.json.rows ?? []).length}`);
  const hqAudit = await inj('GET', '/api/admin/audit?action=saved-views&limit=200', hqaa);
  ok('Audit viewer: no cross-tenant leakage (HQ admin never sees cf2 rows)', (hqAudit.json.rows ?? []).every((r: any) => r.tenant_id !== cf2.id), `n=${(hqAudit.json.rows ?? []).length}`);

  // ── validated bulk import/export (Phase 7) ──
  // admin holds `masterdata`. Items master is global (not tenant-scoped); vendors are tenant-scoped.
  const cnt = async (where?: any) => (await db.select().from(s.items).where(where)).length;
  const itemsBefore = await cnt();
  const badCsv = 'Item_ID,Item_Description,Unit_Price\nGOOD1,Good,5\n,NoId,5\nBAD2,,5\nBAD3,BadPrice,abc\nGOOD1,DupKey,7';
  const dry = await inj('POST', '/api/admin/master-data/items/import/validate', token, { format: 'csv', mode: 'append', csv: badCsv });
  const codes = (dry.json.errors ?? []).map((e: any) => e.code);
  ok('Bulk import: dry-run validate accumulates per-row errors (no first-fail)', dry.json.total === 5 && dry.json.valid === 1 && dry.json.invalid === 4 && codes.includes('REQUIRED_EMPTY') && codes.includes('BAD_NUMBER') && codes.includes('DUP_IN_FILE'), `${JSON.stringify({ total: dry.json.total, valid: dry.json.valid, invalid: dry.json.invalid, codes })}`);
  ok('Bulk import: dry-run touches nothing', (await cnt()) === itemsBefore, `items=${await cnt()} before=${itemsBefore}`);
  const blocked = await inj('POST', '/api/admin/master-data/items/import/checked', token, { format: 'csv', mode: 'append', csv: badCsv });
  ok('Bulk import: a file with errors imports nothing unless skip_errors', blocked.json.status === 'invalid' && blocked.json.imported === 0 && (await cnt()) === itemsBefore, `${JSON.stringify({ status: blocked.json.status, imported: blocked.json.imported })}`);
  const skipped = await inj('POST', '/api/admin/master-data/items/import/checked', token, { format: 'csv', mode: 'append', csv: badCsv, skip_errors: true });
  ok('Bulk import: skip_errors imports only the valid rows + reports the rest', skipped.json.status === 'partial' && skipped.json.imported === 1 && (await cnt(eq(s.items.itemId, 'GOOD1'))) === 1, `${JSON.stringify({ status: skipped.json.status, imported: skipped.json.imported })}`);

  const missCols = await inj('POST', '/api/admin/master-data/items/import/validate', token, { format: 'csv', mode: 'append', csv: 'Item_ID,Unit_Price\nX1,5' });
  ok('Bulk import: a missing required column is reported (MISSING_COLUMNS)', (missCols.json.errors ?? []).some((e: any) => e.code === 'MISSING_COLUMNS'), `${JSON.stringify(missCols.json.errors ?? [])}`);
  const cleanCsv = 'Item_ID,Item_Description,Unit_Price\nBULK1,Widget,10\nBULK2,Gadget,20';
  const good = await inj('POST', '/api/admin/master-data/items/import/checked', token, { format: 'csv', mode: 'append', csv: cleanCsv });
  ok('Bulk import: a clean file commits with status success', good.json.status === 'success' && good.json.imported === 2 && (await cnt(eq(s.items.itemId, 'BULK1'))) === 1, `${JSON.stringify({ status: good.json.status, imported: good.json.imported })}`);
  const reimport = await inj('POST', '/api/admin/master-data/items/import/checked', token, { format: 'csv', mode: 'append', csv: cleanCsv });
  ok('Bulk import: re-importing existing rows reports them as EXISTS (append, 0 new)', reimport.json.imported === 0 && (reimport.json.errors ?? []).every((e: any) => e.code === 'EXISTS') && (reimport.json.errors ?? []).length === 2, `${JSON.stringify({ imported: reimport.json.imported, errs: (reimport.json.errors ?? []).map((e: any) => e.code) })}`);

  // vendors are tenant-scoped: a Warehouse admin's import is stamped with their tenant
  const vend = await inj('POST', '/api/admin/master-data/vendors/import/checked', hqwh, { format: 'csv', mode: 'append', csv: 'Vendor_Code,Name\nV-BULK,Acme Co' });
  const vrow = (await db.select().from(s.vendors).where(eq(s.vendors.vendorCode, 'V-BULK')))[0];
  ok('Bulk import: tenant-scoped entity (vendors) is stamped with the importer’s tenant', vend.json.status === 'success' && vend.json.imported === 1 && Number(vrow?.tenantId) === Number(hq.id), `tenant=${vrow?.tenantId} hq=${hq.id}`);

  // ── outbound webhooks (Phase 8) ──
  // cf2aa / hqaa are AccessAdmin (hold `users`, non-Admin → tenant-scoped). Deliveries go to an unreachable
  // URL, so they're logged 'failed' — that still exercises registration, signed delivery, retry and isolation.
  const wEvents = await inj('GET', '/api/platform/webhooks/events', cf2aa);
  ok('Webhooks: event catalog exposes subscribable events', (wEvents.json.events ?? []).some((e: any) => e.key === 'alert.fired') && (wEvents.json.events ?? []).some((e: any) => e.key === 'po.approved'), `${(wEvents.json.events ?? []).length}`);
  // SSRF guard (M3): a loopback / cloud-metadata / RFC1918 target is rejected at registration (can't be used
  // to reach internal services). Use a public-but-unreachable TEST-NET-2 (RFC5737) address for the
  // delivery-failure path below so it passes the guard yet still fails to connect.
  const ssrfBlock = await inj('POST', '/api/platform/webhooks', cf2aa, { url: 'http://169.254.169.254/latest/meta-data/', events: [] });
  ok('Webhooks: SSRF guard blocks an internal/metadata URL at registration (SSRF_BLOCKED)', ssrfBlock.status === 400 && ssrfBlock.json?.error?.code === 'SSRF_BLOCKED', `${ssrfBlock.status} ${ssrfBlock.json?.error?.code}`);
  const reg = await inj('POST', '/api/platform/webhooks', cf2aa, { url: 'http://198.51.100.9:9/ierp-hook', events: [] });
  ok('Webhooks: register returns id + a one-time plaintext secret', (reg.status === 200 || reg.status === 201) && !!reg.json.id && /^[0-9a-f]{48}$/.test(reg.json.secret ?? ''), `${reg.status} secretLen=${(reg.json.secret ?? '').length}`);
  const wlist = await inj('GET', '/api/platform/webhooks', cf2aa);
  ok('Webhooks: list shows the endpoint without leaking the secret', (wlist.json ?? []).some((w: any) => w.id === reg.json.id) && (wlist.json ?? []).every((w: any) => w.secret === undefined), `n=${(wlist.json ?? []).length}`);
  const wlistHq = await inj('GET', '/api/platform/webhooks', hqaa);
  ok('Webhooks: endpoints are tenant-isolated (HQ admin sees none of cf2’s)', (wlistHq.json ?? []).every((w: any) => w.id !== reg.json.id), `n=${(wlistHq.json ?? []).length}`);

  // trigger a real emission: a fresh (non-cooldown) low-stock rule for cf2, then run the alert sweep
  await inj('POST', '/api/alerts/rules', cf2aa, { name: 'hook trip', metric: 'low_stock_count', operator: 'gte', threshold: 1, channel: 'notification', target_role: 'Warehouse' });
  const hookSweep = await inj('POST', '/api/alerts/run', cf2aa);
  ok('Webhooks: an alert fire emits to the subscribed endpoint', (hookSweep.json.fired_count ?? 0) >= 1, `fired=${hookSweep.json.fired_count}`);
  const dels = await inj('GET', '/api/platform/webhooks/deliveries', cf2aa);
  const hookDel = (dels.json.deliveries ?? []).find((d: any) => d.event === 'alert.fired' && d.webhook_id === reg.json.id);
  ok('Webhooks: the delivery is logged (attempted → failed against the unreachable URL)', !!hookDel && hookDel.status === 'failed' && hookDel.attempts === 1, `${JSON.stringify(hookDel ?? {})}`);
  const delsHq = await inj('GET', '/api/platform/webhooks/deliveries', hqaa);
  ok('Webhooks: the delivery log is tenant-isolated', (delsHq.json.deliveries ?? []).every((d: any) => d.webhook_id !== reg.json.id), `n=${(delsHq.json.deliveries ?? []).length}`);
  const redeliver = await inj('POST', `/api/platform/webhooks/deliveries/${hookDel.id}/redeliver`, cf2aa);
  ok('Webhooks: redeliver re-attempts a single delivery (attempt count advances)', redeliver.status === 200 && redeliver.json.status === 'failed', `${redeliver.status} ${redeliver.json.status}`);
  const dispatch = await inj('POST', '/api/platform/webhooks/dispatch', cf2aa);
  ok('Webhooks: dispatch re-runs failed deliveries under the retry cap', (dispatch.json.scanned ?? 0) >= 1, `${JSON.stringify(dispatch.json)}`);
  const wNoPerm = await inj('GET', '/api/platform/webhooks', token2); // cfwh2 = Warehouse, lacks `users`
  ok('Webhooks: management is gated by the users permission (403 without it)', wNoPerm.status === 403, `${wNoPerm.status}`);
  const wDel = await inj('DELETE', `/api/platform/webhooks/${reg.json.id}`, cf2aa);
  ok('Webhooks: an endpoint can be revoked (deleted)', wDel.status === 200 && wDel.json.deleted === true, `${wDel.status}`);

  // ── tenant branding (Phase 9) ──
  // hqaa (AccessAdmin@HQ, holds `users`) brands the HQ org; the earlier portal sale belongs to HQ, so its
  // receipt must render the logo + tagline. AccessAdmin/RLS scopes each admin to their own tenant row.
  const LOGO = 'https://cdn.example.com/hq-logo.png'; const TAG = 'พันธมิตรที่ไว้ใจได้';
  const brand = await inj('PATCH', '/api/tenant/profile', hqaa, { logo_url: LOGO, tagline: TAG, branding_prefs: { show_logo_on_receipt: true } });
  ok('Branding: a tenant admin sets logo + tagline on its own org', brand.status === 200 && brand.json.logo_url === LOGO && brand.json.tagline === TAG, `${brand.status}`);
  const brandGet = await inj('GET', '/api/tenant/profile', hqaa);
  ok('Branding: profile round-trips logo + tagline + prefs', brandGet.json.logo_url === LOGO && brandGet.json.tagline === TAG && brandGet.json.branding_prefs?.show_logo_on_receipt === true, `${JSON.stringify(brandGet.json.branding_prefs ?? {})}`);
  const rcpt = await inj('GET', `/api/print/receipt/${sale.json.sale_no}`, token);
  const rcptHtml = rcpt.raw?.toString('utf8') ?? '';
  ok('Branding: the logo + tagline are rendered on the receipt (genuinely consumed)', rcpt.status === 200 && rcptHtml.includes(LOGO) && rcptHtml.includes(TAG) && rcptHtml.includes('class="logo"'), `status=${rcpt.status} hasLogo=${rcptHtml.includes(LOGO)} hasTag=${rcptHtml.includes(TAG)}`);
  const badLogo = await inj('PATCH', '/api/tenant/profile', hqaa, { logo_url: 'ftp://nope/x.png' });
  ok('Branding: a non-https/non-data logo URL is rejected (400)', badLogo.status === 400, `${badLogo.status}`);
  // other tenant's branding is independent (RLS)
  await inj('PATCH', '/api/tenant/profile', cf2aa, { tagline: 'CF2 Brand' });
  const hqAfter = await inj('GET', '/api/tenant/profile', hqaa);
  const cf2After = await inj('GET', '/api/tenant/profile', cf2aa);
  ok('Branding: org branding is tenant-isolated', hqAfter.json.tagline === TAG && cf2After.json.tagline === 'CF2 Brand', `hq=${hqAfter.json.tagline} cf2=${cf2After.json.tagline}`);
  // turning the prefs flag off hides the logo on the receipt
  await inj('PATCH', '/api/tenant/profile', hqaa, { branding_prefs: { show_logo_on_receipt: false } });
  const rcpt2 = (await inj('GET', `/api/print/receipt/${sale.json.sale_no}`, token)).raw?.toString('utf8') ?? '';
  ok('Branding: show_logo_on_receipt=false suppresses the logo (tagline stays)', !rcpt2.includes('class="logo"') && rcpt2.includes(TAG), `hasLogo=${rcpt2.includes('class="logo"')}`);

  // ── document templates (Platform Phase 10 — A3) ──
  // hqaa/cf2aa = AccessAdmin (carry `users`, non-Admin → RLS-scoped). token2 = Warehouse (lacks users/exec).
  const jlBefore = (await db.select().from(s.journalLines)).length;
  const dtTypes = await inj('GET', '/api/document-templates/doc-types', hqaa);
  ok('Doc templates: catalog exposes the receipt type as live', (dtTypes.json.doc_types ?? []).some((d: any) => d.key === 'receipt' && d.status === 'live'), `${(dtTypes.json.doc_types ?? []).length}`);
  const dtCreate = await inj('POST', '/api/document-templates', hqaa, { doc_type: 'receipt', name: 'หน้าร้านสาขาหลัก', config: { header: { header_note: 'สมาชิกรับแต้มทุกบิล' }, body: { show_tax_id: false, accent_color: '#0F766E' }, footer: { thanks_text: 'ขอบคุณที่อุดหนุน', extra_lines: ['คืนสินค้าภายใน 7 วัน'] } } });
  ok('Doc templates: create a receipt template (first → becomes default)', (dtCreate.status === 200 || dtCreate.status === 201) && !!dtCreate.json.id && dtCreate.json.is_default === true, `${dtCreate.status} ${JSON.stringify(dtCreate.json)}`);
  const dtBadType = await inj('POST', '/api/document-templates', hqaa, { doc_type: 'nope', name: 'x' });
  ok('Doc templates: an unknown doc_type is rejected (400 BAD_DOC_TYPE)', dtBadType.status === 400 && dtBadType.json.error?.code === 'BAD_DOC_TYPE', `${dtBadType.status} ${dtBadType.json.error?.code}`);
  const dtDup = await inj('POST', '/api/document-templates', hqaa, { doc_type: 'receipt', name: 'หน้าร้านสาขาหลัก' });
  ok('Doc templates: duplicate name per (tenant, doc_type) rejected (400 NAME_EXISTS)', dtDup.status === 400 && dtDup.json.error?.code === 'NAME_EXISTS', `${dtDup.status} ${dtDup.json.error?.code}`);
  const dtActive = await inj('GET', '/api/document-templates/active?doc_type=receipt', hqaa);
  ok('Doc templates: active config resolves the default template', dtActive.json.config?.footer?.thanks_text === 'ขอบคุณที่อุดหนุน' && dtActive.json.config?.body?.show_tax_id === false, `${JSON.stringify(dtActive.json.config ?? {}).slice(0, 120)}`);
  // live preview: posted config is honored
  const dtPrev = await inj('POST', '/api/document-templates/preview', hqaa, { doc_type: 'receipt', config: { footer: { thanks_text: 'PREVIEW-XYZ' }, body: { show_tax_id: false } } });
  const prevHtml = typeof dtPrev.json.html === 'string' ? dtPrev.json.html : '';
  ok('Doc templates: preview renders the posted config', (dtPrev.status === 200 || dtPrev.status === 201) && prevHtml.includes('PREVIEW-XYZ'), `status=${dtPrev.status} len=${prevHtml.length}`);
  ok('Doc templates: preview honors the hide-tax-id toggle', prevHtml.length > 0 && !prevHtml.includes('เลขประจำตัวผู้เสียภาษี'), `hasTaxId=${prevHtml.includes('เลขประจำตัวผู้เสียภาษี')}`);
  // control: even an EMPTY template cannot blank the core — the total label + amount always render
  const dtMinimal = await inj('POST', '/api/document-templates/preview', hqaa, { doc_type: 'receipt', config: {} });
  const minHtml = typeof dtMinimal.json.html === 'string' ? dtMinimal.json.html : '';
  ok('Doc templates: core integrity — a minimal template still renders the total', minHtml.includes('รวมสุทธิ') && /\d/.test(minHtml), `len=${minHtml.length}`);
  // permission gate: Warehouse (no users/exec) is forbidden
  const dtNoPerm = await inj('GET', '/api/document-templates?doc_type=receipt', token2);
  ok('Doc templates: gated by users/exec (403 for Warehouse)', dtNoPerm.status === 403, `${dtNoPerm.status}`);
  // RLS isolation: cf2 admin sees none of HQ’s templates
  const dtIso = await inj('GET', '/api/document-templates?doc_type=receipt', cf2aa);
  ok('Doc templates: tenant-isolated (cf2 sees none of HQ’s)', (dtIso.json.templates ?? []).length === 0, `cf2 templates=${(dtIso.json.templates ?? []).length}`);
  // no GL impact: authoring templates posts no journal lines
  const jlAfter = (await db.select().from(s.journalLines)).length;
  ok('Doc templates: no GL impact (journal lines unchanged by template authoring)', jlAfter === jlBefore, `before=${jlBefore} after=${jlAfter}`);

  // ── custom objects (Platform Phase 11 — A1) ──
  // reuses Phase 1 custom-fields for typed values (entity = object_key). hqaa = HQ admin (RLS-scoped).
  const jlBefore2 = (await db.select().from(s.journalLines)).length;
  const coCreate = await inj('POST', '/api/custom-objects', hqaa, { label: 'Equipment', label_en: 'Equipment', icon: 'wrench' });
  ok('Custom objects: define an object (slugged key)', (coCreate.status === 200 || coCreate.status === 201) && coCreate.json.object_key === 'equipment', `${coCreate.status} ${JSON.stringify(coCreate.json)}`);
  const coDup = await inj('POST', '/api/custom-objects', hqaa, { label: 'Equipment' });
  ok('Custom objects: duplicate object rejected (400 OBJECT_EXISTS)', coDup.status === 400 && coDup.json.error?.code === 'OBJECT_EXISTS', `${coDup.status} ${coDup.json.error?.code}`);
  // define fields on the object via the Phase 1 custom-fields API (entity = object_key)
  await inj('POST', '/api/custom-fields/defs', hqaa, { entity: 'equipment', label: 'Asset name', data_type: 'text', required: true });
  await inj('POST', '/api/custom-fields/defs', hqaa, { entity: 'equipment', label: 'Serial', data_type: 'text' });
  await inj('POST', '/api/custom-fields/defs', hqaa, { entity: 'equipment', label: 'Status', data_type: 'select', options: ['active', 'repair', 'retired'] });
  const coGet = await inj('GET', '/api/custom-objects/equipment', hqaa);
  ok('Custom objects: object carries its field defs', (coGet.json.fields ?? []).length === 3 && (coGet.json.fields ?? []).some((f: any) => f.field_key === 'asset_name' && f.required), `${(coGet.json.fields ?? []).length}`);
  const coRec = await inj('POST', '/api/custom-objects/equipment/records', hqaa, { values: { asset_name: 'เครื่องชงกาแฟ', serial: 'CM-001', status: 'active' } });
  ok('Custom objects: create a record → id + display name', (coRec.status === 200 || coRec.status === 201) && !!coRec.json.record_id && coRec.json.display_name === 'เครื่องชงกาแฟ', `${coRec.status} ${JSON.stringify(coRec.json)}`);
  const coBadOpt = await inj('POST', '/api/custom-objects/equipment/records', hqaa, { values: { asset_name: 'X', status: 'broken' } });
  ok('Custom objects: record validation reuses custom-fields (400 BAD_OPTION)', coBadOpt.status === 400 && coBadOpt.json.error?.code === 'BAD_OPTION', `${coBadOpt.status} ${coBadOpt.json.error?.code}`);
  const coReq = await inj('POST', '/api/custom-objects/equipment/records', hqaa, { values: { serial: 'no-name' } });
  ok('Custom objects: required field enforced on records (400 REQUIRED_FIELD)', coReq.status === 400 && coReq.json.error?.code === 'REQUIRED_FIELD', `${coReq.status} ${coReq.json.error?.code}`);
  const coList = await inj('GET', '/api/custom-objects/equipment/records', hqaa);
  ok('Custom objects: list records with typed values + display', (coList.json.records ?? []).length === 1 && coList.json.records[0].values?.status === 'active' && coList.json.records[0].display_name === 'เครื่องชงกาแฟ', `${JSON.stringify(coList.json.records ?? []).slice(0, 140)}`);
  const recId = coRec.json.record_id;
  const coUpd = await inj('PUT', `/api/custom-objects/equipment/records/${recId}`, hqaa, { values: { asset_name: 'เครื่องชงกาแฟ (ใหม่)', status: 'repair' } });
  ok('Custom objects: update a record (display recomputed)', (coUpd.status === 200 || coUpd.status === 201) && coUpd.json.display_name === 'เครื่องชงกาแฟ (ใหม่)', `${coUpd.status} ${JSON.stringify(coUpd.json)}`);
  const coGetRec = await inj('GET', `/api/custom-objects/equipment/records/${recId}`, hqaa);
  ok('Custom objects: get a record returns typed fields', (coGetRec.json.fields ?? []).find((f: any) => f.field_key === 'status')?.value === 'repair', `${JSON.stringify(coGetRec.json.fields ?? []).slice(0, 140)}`);
  const coIso = await inj('GET', '/api/custom-objects', cf2aa);
  ok('Custom objects: tenant-isolated (cf2 sees none of HQ’s)', (coIso.json.objects ?? []).every((o: any) => o.object_key !== 'equipment'), `cf2 objects=${(coIso.json.objects ?? []).length}`);
  const coDel = await inj('DELETE', `/api/custom-objects/equipment/records/${recId}`, hqaa);
  ok('Custom objects: soft-delete a record', (coDel.status === 200 || coDel.status === 201) && coDel.json.active === false, `${coDel.status}`);
  const coListAfter = await inj('GET', '/api/custom-objects/equipment/records', hqaa);
  ok('Custom objects: deleted record drops out of the list', (coListAfter.json.records ?? []).length === 0, `${(coListAfter.json.records ?? []).length}`);
  const jlAfter2 = (await db.select().from(s.journalLines)).length;
  ok('Custom objects: no GL impact (journal lines unchanged)', jlAfter2 === jlBefore2, `before=${jlBefore2} after=${jlAfter2}`);

  // ── object layouts (Platform Phase 12 — A2) ──
  const jlBefore3 = (await db.select().from(s.journalLines)).length;
  const olBuiltin = await inj('GET', '/api/object-layouts/resolve?object_key=equipment', hqaa);
  ok('Object layouts: resolve falls back to a built-in layout', olBuiltin.json.source === 'builtin' && (olBuiltin.json.sections ?? []).length === 1 && (olBuiltin.json.sections[0].fields ?? []).length >= 3, `${olBuiltin.json.source} secs=${(olBuiltin.json.sections ?? []).length}`);
  const olCreate = await inj('POST', '/api/object-layouts', hqaa, { object_key: 'equipment', name: 'ฟอร์มหลัก', config: { sections: [{ title: 'หลัก', columns: 2, fields: ['asset_name', 'status'] }], hidden: ['serial'] } });
  ok('Object layouts: create a layout (first → default)', (olCreate.status === 200 || olCreate.status === 201) && olCreate.json.is_default === true, `${olCreate.status} ${JSON.stringify(olCreate.json)}`);
  const olDup = await inj('POST', '/api/object-layouts', hqaa, { object_key: 'equipment', name: 'ฟอร์มหลัก' });
  ok('Object layouts: duplicate name rejected (400 NAME_EXISTS)', olDup.status === 400 && olDup.json.error?.code === 'NAME_EXISTS', `${olDup.status} ${olDup.json.error?.code}`);
  const olRes = await inj('GET', '/api/object-layouts/resolve?object_key=equipment', hqaa);
  const sec0 = (olRes.json.sections ?? [])[0] ?? {};
  ok('Object layouts: resolve applies sections + hides a field', olRes.json.source === 'object' && sec0.title === 'หลัก' && sec0.columns === 2 && (sec0.fields ?? []).some((f: any) => f.field_key === 'asset_name') && !(sec0.fields ?? []).some((f: any) => f.field_key === 'serial') && (olRes.json.hidden ?? []).some((f: any) => f.field_key === 'serial'), `${JSON.stringify(olRes.json).slice(0, 160)}`);
  // a field added AFTER the layout was saved still surfaces (appended) — never lost
  await inj('POST', '/api/custom-fields/defs', hqaa, { entity: 'equipment', label: 'Location', data_type: 'text' });
  const olRes2 = await inj('GET', '/api/object-layouts/resolve?object_key=equipment', hqaa);
  const allKeys = (olRes2.json.sections ?? []).flatMap((x: any) => (x.fields ?? []).map((f: any) => f.field_key));
  ok('Object layouts: a newly-added field auto-surfaces in the layout', allKeys.includes('location'), `${JSON.stringify(allKeys)}`);
  const olPrev = await inj('POST', '/api/object-layouts/preview', hqaa, { object_key: 'equipment', config: { sections: [{ title: 'ทุกฟิลด์', columns: 1, fields: ['asset_name', 'serial', 'status'] }], hidden: [] } });
  ok('Object layouts: preview resolves a posted config (no save)', olPrev.json.source === 'preview' && (olPrev.json.sections ?? [])[0]?.title === 'ทุกฟิลด์', `${(olPrev.json.sections ?? [])[0]?.title}`);
  const olList = await inj('GET', '/api/object-layouts?object_key=equipment', hqaa);
  ok('Object layouts: list shows the tenant’s layouts', (olList.json.layouts ?? []).length >= 1, `${(olList.json.layouts ?? []).length}`);
  const olIso = await inj('GET', '/api/object-layouts?object_key=equipment', cf2aa);
  ok('Object layouts: tenant-isolated (cf2 sees none of HQ’s)', (olIso.json.layouts ?? []).length === 0, `cf2=${(olIso.json.layouts ?? []).length}`);
  const jlAfter3 = (await db.select().from(s.journalLines)).length;
  ok('Object layouts: no GL impact (journal lines unchanged)', jlAfter3 === jlBefore3, `before=${jlBefore3} after=${jlAfter3}`);

  // ── Public REST API v1 (Phase #3) — versioned, API-key-only, scope-gated, rate-limited ──
  // Seed one cf2-scoped order + invoice so the tenant-isolation assertions over /orders, /invoices are real.
  await db.insert(s.orders).values({ orderNo: 'SO-PUB-CF2', orderDate: '2026-06-01', tenantId: cf2.id, status: 'Pending' });
  await db.insert(s.arInvoices).values({ invoiceNo: 'INV-PUB-CF2', invoiceDate: '2026-06-01', tenantId: cf2.id, orderNo: 'SO-PUB-CF2', amount: '100', paidAmount: '30', status: 'Unpaid' });

  // OpenAPI doc + discovery root are open (no key).
  const oapi = await inj('GET', '/api/v1/openapi.json');
  ok('Public API: OpenAPI 3.1 doc is served openly (no key)', oapi.status === 200 && oapi.json.openapi === '3.1.0' && !!oapi.json.paths?.['/items'] && !!oapi.json.paths?.['/invoices'], `status=${oapi.status} v=${oapi.json.openapi}`);
  const v1root = await inj('GET', '/api/v1');
  ok('Public API: discovery root advertises v1 + endpoints', v1root.status === 200 && v1root.json.version === 'v1' && Array.isArray(v1root.json.endpoints), `status=${v1root.status}`);

  // Issue keys: full HQ + full cf2 + a catalog-only cf2 key + a throwaway key for the rate test.
  const hqKeyR = await inj('POST', '/api/platform/api-keys', token, { name: 'pub-hq', scopes: ['*'] });
  const hqKey = hqKeyR.json.key;
  ok('Public API: an API key is issued (ierp_) for the public surface', /^ierp_/.test(hqKey ?? ''), `${hqKeyR.status}`);
  const cf2Key = (await inj('POST', '/api/platform/api-keys', cf2aa, { name: 'pub-cf2', scopes: ['*'] })).json.key;
  const catKey = (await inj('POST', '/api/platform/api-keys', cf2aa, { name: 'pub-cat', scopes: ['catalog:read'] })).json.key;
  const rateKey = (await inj('POST', '/api/platform/api-keys', token, { name: 'pub-rate', scopes: ['*'] })).json.key;

  // /me identifies the key (tenant + granted scopes).
  const me1 = await inj('GET', '/api/v1/me', hqKey);
  ok('Public API: /me returns the key principal, tenant + scopes', me1.status === 200 && me1.json.tenant_id === hq.id && (me1.json.scopes ?? []).includes('*') && String(me1.json.principal).startsWith('apikey:'), `${JSON.stringify(me1.json)}`);

  // Key-only: a human JWT (admin) is rejected from the public surface.
  const humanReject = await inj('GET', '/api/v1/items', token);
  ok('Public API: human JWTs are rejected (API_KEY_REQUIRED)', humanReject.status === 403 && humanReject.json.error?.code === 'API_KEY_REQUIRED', `${humanReject.status} ${humanReject.json.error?.code}`);
  // No token at all → 401 from the global auth guard.
  const noTok = await inj('GET', '/api/v1/me');
  ok('Public API: a missing key is 401 (global auth)', noTok.status === 401, `${noTok.status}`);

  // Catalog read works; the shared item catalog is returned.
  const itemsR = await inj('GET', '/api/v1/items', hqKey);
  ok('Public API: GET /items returns the catalog envelope (data + pagination)', itemsR.status === 200 && Array.isArray(itemsR.json.data) && itemsR.json.data.length >= 2 && itemsR.json.pagination?.limit === 50, `n=${(itemsR.json.data ?? []).length}`);
  const itemsPaged = await inj('GET', '/api/v1/items?limit=1', hqKey);
  ok('Public API: limit is honoured (pagination)', itemsPaged.json.data?.length === 1 && itemsPaged.json.pagination?.limit === 1, `n=${(itemsPaged.json.data ?? []).length}`);

  // Tenant isolation via inventory: HQ sees item A (seeded for HQ); cf2 sees LOW1, never A.
  const hqInv = await inj('GET', '/api/v1/inventory', hqKey);
  const cf2Inv = await inj('GET', '/api/v1/inventory', cf2Key);
  const hqItems = (hqInv.json.data ?? []).map((r: any) => r.item_id);
  const cf2Items = (cf2Inv.json.data ?? []).map((r: any) => r.item_id);
  ok('Public API: /inventory is RLS tenant-scoped (HQ↔cf2 do not bleed)', hqItems.includes('A') && !hqItems.includes('LOW1') && cf2Items.includes('LOW1') && !cf2Items.includes('A'), `hq=${JSON.stringify(hqItems)} cf2=${JSON.stringify(cf2Items)}`);

  // Tenant isolation via orders + invoices: the cf2 row is visible to cf2's key, not HQ's.
  const cf2Orders = (await inj('GET', '/api/v1/orders', cf2Key)).json.data ?? [];
  const hqOrders = (await inj('GET', '/api/v1/orders', hqKey)).json.data ?? [];
  ok('Public API: /orders is tenant-scoped', cf2Orders.some((o: any) => o.order_no === 'SO-PUB-CF2') && !hqOrders.some((o: any) => o.order_no === 'SO-PUB-CF2'), `cf2=${cf2Orders.length} hq=${hqOrders.length}`);
  const cf2Inv2 = (await inj('GET', '/api/v1/invoices', cf2Key)).json.data ?? [];
  const theInv = cf2Inv2.find((i: any) => i.invoice_no === 'INV-PUB-CF2');
  ok('Public API: /invoices returns typed amounts + computed outstanding', !!theInv && theInv.amount === 100 && theInv.outstanding === 70, `${JSON.stringify(theInv ?? {})}`);

  // ── Loyalty write API (Phase C2): enrol / earn / redeem via API key + loyalty webhooks ──
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: true, pointsPerBaht: '1', bahtPerPoint: '0.1', minRedeem: '0' })
    .onConflictDoUpdate({ target: s.loyaltyConfig.id, set: { enabled: true, pointsPerBaht: '1', bahtPerPoint: '0.1', minRedeem: '0' } });
  await db.insert(s.webhooks).values({ tenantId: hq.id, url: 'https://example.invalid/hook', events: 'loyalty.earned,loyalty.enrolled', secret: 'whsec', active: true, createdBy: 'test' });

  const enr = await inj('POST', '/api/v1/loyalty/enroll', hqKey, { phone: '0899990000', name: 'API Member' });
  ok('Public API loyalty: enroll returns a member (scope loyalty:write)', enr.status === 201 && enr.json.id > 0 && /^M-/.test(enr.json.member_code ?? ''), `${enr.status} ${enr.json.member_code}`);
  const earn = await inj('POST', '/api/v1/loyalty/earn', hqKey, { member_id: enr.json.id, net_spend: 100 });
  ok('Public API loyalty: earn credits points + returns balance', earn.status === 200 && earn.json.points_earned === 100 && earn.json.balance === 100, JSON.stringify(earn.json));
  const rdm = await inj('POST', '/api/v1/loyalty/redeem', hqKey, { member_id: enr.json.id, points: 40 });
  ok('Public API loyalty: redeem debits points (balance 100→60)', rdm.status === 200 && rdm.json.points_redeemed === 40 && rdm.json.balance === 60, JSON.stringify(rdm.json));
  const memRead = await inj('GET', '/api/v1/loyalty/member?phone=0899990000', hqKey);
  ok('Public API loyalty: member read returns the balance (scope loyalty:read)', memRead.status === 200 && memRead.json.balance === 60, `bal=${memRead.json.balance}`);
  const noScope = await inj('POST', '/api/v1/loyalty/earn', catKey, { member_id: enr.json.id, net_spend: 10 });
  ok('Public API loyalty: earn requires loyalty:write scope (catalog-only key → 403)', noScope.status === 403, `${noScope.status}`);
  const whDeliveries = await db.select().from(s.webhookDeliveries).where(eq(s.webhookDeliveries.event, 'loyalty.earned'));
  ok('Public API loyalty: earn fired a loyalty.earned webhook delivery', whDeliveries.length >= 1, `n=${whDeliveries.length}`);

  // Scope enforcement: a catalog-only key reads /items but is denied /orders.
  const catItems = await inj('GET', '/api/v1/items', catKey);
  ok('Public API: a catalog:read key may read /items', catItems.status === 200, `${catItems.status}`);
  const catOrders = await inj('GET', '/api/v1/orders', catKey);
  ok('Public API: a catalog:read key is denied /orders (INSUFFICIENT_SCOPE)', catOrders.status === 403 && catOrders.json.error?.code === 'INSUFFICIENT_SCOPE', `${catOrders.status} ${catOrders.json.error?.code}`);

  // Per-key rate limit: hammer the throwaway key past the cap (50) → at least one 429 RATE_LIMITED.
  let got429 = false; let rlCode = '';
  for (let i = 0; i < 55; i++) {
    const r = await inj('GET', '/api/v1/me', rateKey);
    if (r.status === 429) { got429 = true; rlCode = r.json.error?.code; break; }
  }
  ok('Public API: per-key rate limit trips (429 RATE_LIMITED)', got429 && rlCode === 'RATE_LIMITED', `got429=${got429} code=${rlCode}`);
  // A different key is unaffected by another key's exhausted window.
  const otherKeyOk = await inj('GET', '/api/v1/me', cf2Key);
  ok('Public API: the rate limit is per-key (a fresh key still passes)', otherKeyOk.status === 200, `${otherKeyOk.status}`);

  // ── Enterprise identity: OIDC SSO + SCIM 2.0 (Phase #4) ──
  // cf2aa (AccessAdmin@cf2, holds `users`) configures its tenant's IdP + SCIM.
  const SECRET = 'cf2-oidc-secret'; const ISSUER = 'https://idp.cf2.example'; const CLIENT = 'cf2-client-id';
  const cfgPut = await inj('PUT', '/api/platform/identity', cf2aa, { sso_enabled: true, oidc_issuer: ISSUER, oidc_client_id: CLIENT, oidc_client_secret: SECRET, oidc_redirect_uri: 'https://app.example/sso/cb', default_role: 'Customer' });
  ok('Identity: tenant admin configures OIDC SSO', cfgPut.status === 200 && cfgPut.json.sso_enabled === true && cfgPut.json.has_client_secret === true, `${cfgPut.status} ${JSON.stringify(cfgPut.json).slice(0,120)}`);
  ok('Identity: the client secret is write-only (never returned)', !('oidc_client_secret' in (cfgPut.json ?? {})) && cfgPut.json.oidc_client_secret === undefined, `keys=${Object.keys(cfgPut.json ?? {}).join(',')}`);
  const cfgGated = await inj('PUT', '/api/platform/identity', token2, { sso_enabled: true }); // cfwh2 = Warehouse, lacks `users`
  ok('Identity: config is gated by the users permission (403)', cfgGated.status === 403, `${cfgGated.status}`);

  // SSO authorize → IdP redirect URL.
  const authz = await inj('GET', '/api/auth/sso/authorize?tenant=CF2', undefined);
  ok('SSO: authorize returns the IdP URL with client_id + state', authz.status === 200 && String(authz.json.authorization_url).includes(CLIENT) && String(authz.json.authorization_url).startsWith(ISSUER) && !!authz.json.state, `${authz.status} ${String(authz.json.authorization_url).slice(0,80)}`);
  const authzHq = await inj('GET', '/api/auth/sso/authorize?tenant=HQ', undefined);
  ok('SSO: authorize is 503 for a tenant without SSO configured', authzHq.status === 503 && authzHq.json.error?.code === 'SSO_NOT_CONFIGURED', `${authzHq.status} ${authzHq.json.error?.code}`);

  // Mint an HS256 id_token (signed with the client secret) and complete the callback → JIT provision + JWT.
  // C1: `state` is now single-use and server-persisted, so each callback must present a FRESH state minted by
  // authorize() (a forged/replayed/expired state is rejected — see the BAD_STATE check below).
  const mkIdToken = (over: any = {}) => signHs256({ iss: ISSUER, aud: CLIENT, sub: 'idp-user-1', email: 'alice@cf2.example', exp: Math.floor(Date.now() / 1000) + 3600, ...over }, SECRET);
  const freshState = async (): Promise<string> => (await inj('GET', '/api/auth/sso/authorize?tenant=CF2', undefined)).json.state as string;
  const cbForged = await inj('POST', '/api/auth/sso/callback', undefined, { state: 'CF2.forged-never-issued', id_token: mkIdToken() });
  ok('SSO: a forged/unknown state is rejected (BAD_STATE — login-CSRF defence)', cbForged.status === 400 && cbForged.json.error?.code === 'BAD_STATE', `${cbForged.status} ${cbForged.json.error?.code}`);
  const reuseState = await freshState();
  const cb1 = await inj('POST', '/api/auth/sso/callback', undefined, { state: reuseState, id_token: mkIdToken() });
  ok('SSO: callback verifies the id_token and mints a session (JIT-provisioned user)', cb1.status === 200 && !!cb1.json.token && cb1.json.role === 'Customer', `${cb1.status} ${JSON.stringify(cb1.json).slice(0,100)}`);
  const cbReplay = await inj('POST', '/api/auth/sso/callback', undefined, { state: reuseState, id_token: mkIdToken() });
  ok('SSO: a consumed state cannot be replayed (single-use — BAD_STATE)', cbReplay.status === 400 && cbReplay.json.error?.code === 'BAD_STATE', `${cbReplay.status} ${cbReplay.json.error?.code}`);
  const ssoMe = await inj('GET', '/api/auth/me', cb1.json.token);
  ok('SSO: the minted session works (auth/me) and is scoped to the SSO user', ssoMe.status === 200 && ssoMe.json.username === cb1.json.username, `${ssoMe.status} ${ssoMe.json.username}`);
  const cb2 = await inj('POST', '/api/auth/sso/callback', undefined, { state: await freshState(), id_token: mkIdToken() });
  ok('SSO: a repeat login reuses the same user (idempotent JIT by sso_subject)', cb2.status === 200 && cb2.json.username === cb1.json.username, `${cb1.json.username} vs ${cb2.json.username}`);
  const cbBadSig = await inj('POST', '/api/auth/sso/callback', undefined, { state: await freshState(), id_token: mkIdToken() + 'x' });
  ok('SSO: a tampered id_token is rejected (401 BAD_ID_TOKEN)', cbBadSig.status === 401 && cbBadSig.json.error?.code === 'BAD_ID_TOKEN', `${cbBadSig.status} ${cbBadSig.json.error?.code}`);
  const cbBadAud = await inj('POST', '/api/auth/sso/callback', undefined, { state: await freshState(), id_token: mkIdToken({ aud: 'someone-else' }) });
  ok('SSO: a wrong-audience id_token is rejected (401 BAD_AUDIENCE)', cbBadAud.status === 401 && cbBadAud.json.error?.code === 'BAD_AUDIENCE', `${cbBadAud.status} ${cbBadAud.json.error?.code}`);

  // SCIM: rotate a token, then provision/list/deactivate.
  const scimTok = (await inj('POST', '/api/platform/identity/scim-token', cf2aa)).json.token;
  ok('SCIM: a per-tenant bearer token is issued (scim_)', /^scim_/.test(scimTok ?? ''), `${String(scimTok).slice(0,12)}`);
  const scimNoAuth = await inj('GET', '/scim/v2/Users', undefined);
  ok('SCIM: a request without a token is 401', scimNoAuth.status === 401 && scimNoAuth.json.error?.code === 'SCIM_UNAUTHORIZED', `${scimNoAuth.status}`);
  const spc = await inj('GET', '/scim/v2/ServiceProviderConfig', scimTok);
  ok('SCIM: ServiceProviderConfig advertises patch + filter', spc.status === 200 && spc.json.patch?.supported === true && spc.json.filter?.supported === true, `${spc.status}`);
  const scimCreate = await inj('POST', '/scim/v2/Users', scimTok, { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'scim.user@cf2', externalId: 'idp-sub-42', active: true });
  ok('SCIM: provision a user (201, active, externalId linked)', scimCreate.status === 201 && scimCreate.json.active === true && scimCreate.json.externalId === 'idp-sub-42' && !!scimCreate.json.id, `${scimCreate.status} ${JSON.stringify(scimCreate.json).slice(0,120)}`);
  const scimId = scimCreate.json.id;
  const scimDup = await inj('POST', '/scim/v2/Users', scimTok, { userName: 'scim.user@cf2' });
  ok('SCIM: a duplicate userName is rejected (reuses the admin create path → 409)', scimDup.status === 409, `${scimDup.status}`);
  const scimFilter = await inj('GET', '/scim/v2/Users?filter=userName eq "scim.user@cf2"', scimTok);
  ok('SCIM: filter by userName returns the ListResponse', scimFilter.status === 200 && scimFilter.json.totalResults === 1 && scimFilter.json.Resources?.[0]?.id === scimId, `${scimFilter.status} total=${scimFilter.json.totalResults}`);
  const scimDeact = await inj('PATCH', `/scim/v2/Users/${scimId}`, scimTok, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }] });
  ok('SCIM: PATCH active=false deprovisions (deactivate, not delete)', scimDeact.status === 200 && scimDeact.json.active === false, `${scimDeact.status} active=${scimDeact.json.active}`);
  const scimDelete = await inj('DELETE', `/scim/v2/Users/${scimId}`, scimTok);
  ok('SCIM: DELETE soft-deactivates (204) and the row survives', scimDelete.status === 204 && (await inj('GET', `/scim/v2/Users/${scimId}`, scimTok)).json.active === false, `${scimDelete.status}`);

  // SCIM tenant isolation: HQ's SCIM token must not see cf2's users.
  await inj('PUT', '/api/platform/identity', hqaa, { default_role: 'Customer' });
  const hqScimTok = (await inj('POST', '/api/platform/identity/scim-token', hqaa)).json.token;
  const hqSees = await inj('GET', '/scim/v2/Users?filter=userName eq "scim.user@cf2"', hqScimTok);
  ok('SCIM: tenant isolation — HQ’s token cannot see cf2’s users (RLS)', hqSees.status === 200 && hqSees.json.totalResults === 0, `total=${hqSees.json.totalResults}`);

  // is_active gates password login: deactivate a seeded user directly, then login must fail.
  await db.insert(s.users).values({ username: 'deact1', passwordHash: await pw.hash('pw'), role: 'Sales', tenantId: hq.id, isActive: false });
  const deactLogin = await inj('POST', '/api/login', undefined, { username: 'deact1', password: 'pw' });
  ok('Identity: a deactivated account cannot log in (401 USER_DEACTIVATED)', deactLogin.status === 401 && deactLogin.json.error?.code === 'USER_DEACTIVATED', `${deactLogin.status} ${deactLogin.json.error?.code}`);

  // ── automation rules engine (Platform Phase 13 — A4) ──
  const jlBeforeAu = (await db.select().from(s.journalLines)).length;
  const auCat = await inj('GET', '/api/automation/events', hqaa);
  ok('Automation: event catalog exposes alert.fired + action types', (auCat.json.events ?? []).some((e: any) => e.key === 'alert.fired') && (auCat.json.action_types ?? []).includes('notification'), `${(auCat.json.events ?? []).length}`);
  const auBadEvent = await inj('POST', '/api/automation/rules', hqaa, { name: 'x', event_type: 'nope', action: { type: 'log' } });
  ok('Automation: unknown event rejected (400 BAD_EVENT)', auBadEvent.status === 400 && auBadEvent.json.error?.code === 'BAD_EVENT', `${auBadEvent.status} ${auBadEvent.json.error?.code}`);
  const auBadAction = await inj('POST', '/api/automation/rules', hqaa, { name: 'x', event_type: 'alert.fired', action: { type: 'explode' } });
  ok('Automation: unknown action rejected (400 BAD_ACTION)', auBadAction.status === 400 && auBadAction.json.error?.code === 'BAD_ACTION', `${auBadAction.status} ${auBadAction.json.error?.code}`);
  const auCreate = await inj('POST', '/api/automation/rules', hqaa, { name: 'แจ้งเมื่อ critical', event_type: 'alert.fired', condition: { field: 'severity', op: 'eq', value: 'critical' }, action: { type: 'notification', message: 'critical alert!' } });
  ok('Automation: create a rule (event + condition + action)', (auCreate.status === 200 || auCreate.status === 201) && !!auCreate.json.id, `${auCreate.status} ${JSON.stringify(auCreate.json)}`);
  const auMatch = await inj('POST', '/api/automation/run-event', hqaa, { event: 'alert.fired', payload: { severity: 'critical', name: 'low stock', value: 9 } });
  ok('Automation: run-event executes a matching rule', (auMatch.json.matched ?? 0) >= 1 && (auMatch.json.executed ?? 0) >= 1, `${JSON.stringify(auMatch.json)}`);
  const auSkip = await inj('POST', '/api/automation/run-event', hqaa, { event: 'alert.fired', payload: { severity: 'warning' } });
  ok('Automation: a non-matching condition is skipped (executed 0)', (auSkip.json.executed ?? 0) === 0, `${JSON.stringify(auSkip.json)}`);
  const auExecs = await inj('GET', '/api/automation/executions', hqaa);
  ok('Automation: executions are logged (executed + skipped)', (auExecs.json.executions ?? []).some((e: any) => e.status === 'executed') && (auExecs.json.executions ?? []).some((e: any) => e.status === 'skipped'), `${(auExecs.json.executions ?? []).length}`);
  const auIso = await inj('GET', '/api/automation/rules', cf2aa);
  ok('Automation: rules are tenant-isolated (cf2 sees none of HQ’s)', (auIso.json.rules ?? []).length === 0, `cf2 rules=${(auIso.json.rules ?? []).length}`);
  const jlAfterAu = (await db.select().from(s.journalLines)).length;
  ok('Automation: no GL impact (journal lines unchanged)', jlAfterAu === jlBeforeAu, `before=${jlBeforeAu} after=${jlAfterAu}`);

  // ── semantic layer + report/pivot builder (Platform Phase 14 — A5) ──
  // hqwh / cfwh2 are Warehouse (carry `masterdata`), non-Admin → RLS-scoped reads.
  const hqwhT = (await inj('POST', '/api/login', undefined, { username: 'hqwh', password: 'pw' })).json.token;
  await db.insert(s.custPosSales).values([
    { saleNo: 'Q-HQ-1', saleDate: '2026-06-01', tenantId: hq.id, subtotal: '500', discount: '0', taxAmount: '35', total: '500', paymentMethod: 'Cash', status: 'Completed' },
    { saleNo: 'Q-HQ-2', saleDate: '2026-06-02', tenantId: hq.id, subtotal: '300', discount: '0', taxAmount: '21', total: '300', paymentMethod: 'PromptPay', status: 'Completed' },
  ]).onConflictDoNothing();
  const qModel = await inj('GET', '/api/query/model', hqwhT);
  ok('Query: semantic model exposes measures + dimensions', (qModel.json.measures ?? []).some((m: any) => m.key === 'sales_total') && (qModel.json.dimensions ?? []).some((d: any) => d.key === 'payment_method'), `${(qModel.json.measures ?? []).length}x${(qModel.json.dimensions ?? []).length}`);
  const qRun = await inj('POST', '/api/query/run', hqwhT, { dimension: 'payment_method' });
  const qTotal = (qRun.json.rows ?? []).reduce((a: number, r: any) => a + Number(r.sales_total || 0), 0);
  ok('Query: run aggregates the tenant’s POS sales by dimension', (qRun.status === 200 || qRun.status === 201) && (qRun.json.rows ?? []).length >= 2 && qTotal >= 800, `status=${qRun.status} rows=${(qRun.json.rows ?? []).length} total=${qTotal}`);
  const qBad = await inj('POST', '/api/query/run', hqwhT, { dimension: 'nope' });
  ok('Query: an unknown dimension is rejected (400 BAD_DIMENSION)', qBad.status === 400 && qBad.json.error?.code === 'BAD_DIMENSION', `${qBad.status} ${qBad.json.error?.code}`);
  const qIso = await inj('POST', '/api/query/run', token2, { dimension: 'payment_method' });
  const qIsoTotal = (qIso.json.rows ?? []).reduce((a: number, r: any) => a + Number(r.sales_total || 0), 0);
  ok('Query: RLS-scoped — another tenant does not see these sales', qIsoTotal === 0, `cf2 total=${qIsoTotal}`);

  // ── B1 embedded copilot (Platform Phase 15) ──
  // Local fallback embedder is whitespace bag-of-words, so the doc + question must share word tokens.
  await inj('POST', '/api/ai/kb/documents', token, { title: 'Refund policy', content: 'Refund policy: customers can return products within 7 days with a receipt. Refunds go to the original payment method.' });
  const cpAsk = await inj('POST', '/api/copilot/ask', token, { question: 'refund policy return products' });
  ok('Copilot: grounds an answer in the knowledge base (cite)', (cpAsk.status === 200 || cpAsk.status === 201) && cpAsk.json.grounded === true && (cpAsk.json.citations ?? []).length >= 1, `grounded=${cpAsk.json.grounded} cites=${(cpAsk.json.citations ?? []).length} src=${cpAsk.json.source}`);
  ok('Copilot: no-key fallback returns a KB-cited answer (source=kb)', (cpAsk.json.answer ?? '').length > 0 && cpAsk.json.source === 'kb', `src=${cpAsk.json.source} len=${(cpAsk.json.answer ?? '').length}`);

  // ── B2 document-AI intake (Platform Phase 16) ──
  const docEx = await inj('POST', '/api/doc-ai/extract', token, { text: 'ACME Supplies Co.\nInvoice INV-9001\nDate 2026-06-15\nSubtotal 1,401.87\nVAT 98.13\nGrand Total 1,500.00' });
  ok('Doc-AI: extracts invoice no / amount / date (regex fallback)', (docEx.status === 200 || docEx.status === 201) && docEx.json.fields?.invoice_no === 'INV-9001' && Number(docEx.json.fields?.amount) === 1500 && docEx.json.fields?.invoice_date === '2026-06-15', `${JSON.stringify(docEx.json.fields ?? {})}`);

  // ── B3 NL analytics (Platform Phase 17) — over the A5 semantic layer (HQ has seeded sales) ──
  const nlPay = await inj('POST', '/api/nl-analytics/ask', hqwhT, { question: 'sales by payment method' });
  ok('NL analytics: maps NL → governed query + runs it', (nlPay.status === 200 || nlPay.status === 201) && nlPay.json.resolved?.dimension === 'payment_method' && (nlPay.json.result?.rows ?? []).length >= 1, `dim=${nlPay.json.resolved?.dimension} rows=${(nlPay.json.result?.rows ?? []).length}`);
  const nlBranch = await inj('POST', '/api/nl-analytics/ask', hqwhT, { question: 'ยอดขายแยกตามสาขา' });
  ok('NL analytics: Thai keywords map to the branch dimension', nlBranch.json.resolved?.dimension === 'branch', `dim=${nlBranch.json.resolved?.dimension}`);

  // ── B4 AI configuration assistant (Platform Phase 18) ──
  const cfgTargets = await inj('GET', '/api/ai-config/targets', hqwhT);
  ok('AI config: target catalog exposes custom_object', (cfgTargets.json.targets ?? []).includes('custom_object'), `${JSON.stringify(cfgTargets.json.targets ?? [])}`);
  const cfgObj = await inj('POST', '/api/ai-config/suggest', hqwhT, { target: 'custom_object', description: 'equipment maintenance log' });
  ok('AI config: proposes a custom-object config (template fallback)', (cfgObj.status === 200 || cfgObj.status === 201) && !!cfgObj.json.proposal?.label && (cfgObj.json.proposal?.fields ?? []).length >= 1, `${JSON.stringify(cfgObj.json.proposal ?? {}).slice(0, 120)}`);
  const cfgAlert = await inj('POST', '/api/ai-config/suggest', hqwhT, { target: 'alert', description: 'แจ้งเตือนเมื่อสต๊อกต่ำ low stock' });
  ok('AI config: alert suggestion picks the low_stock metric', cfgAlert.json.proposal?.metric === 'low_stock_count', `${cfgAlert.json.proposal?.metric}`);
  const cfgBad = await inj('POST', '/api/ai-config/suggest', hqwhT, { target: 'nope', description: 'x' });
  ok('AI config: unknown target rejected (400 BAD_TARGET)', cfgBad.status === 400 && cfgBad.json.error?.code === 'BAD_TARGET', `${cfgBad.status} ${cfgBad.json.error?.code}`);

  // ── B5 continuous controls monitoring (Platform Phase 19) ──
  const jlBeforeCtl = (await db.select().from(s.journalLines)).length;
  await db.insert(s.apTransactions).values([
    { txnNo: 'AP-CTL-1', tenantId: cf2.id, vendorName: 'ACME', invoiceNo: 'DUP-1', amount: '1000', status: 'Unpaid' },
    { txnNo: 'AP-CTL-2', tenantId: cf2.id, vendorName: 'ACME', invoiceNo: 'DUP-1', amount: '1000', status: 'Unpaid' },
  ]).onConflictDoNothing();
  await db.insert(s.vendors).values([
    { tenantId: cf2.id, vendorCode: 'GV-A', name: 'Foo A', taxId: '9999999999999' },
    { tenantId: cf2.id, vendorCode: 'GV-B', name: 'Foo B', taxId: '9999999999999' },
  ]).onConflictDoNothing();
  const ctlCat = await inj('GET', '/api/controls/catalog', cf2aa);
  ok('Controls: catalog exposes the detectors', (ctlCat.json.controls ?? []).some((c: any) => c.key === 'duplicate_invoice'), `${(ctlCat.json.controls ?? []).length}`);
  const ctlScan = await inj('POST', '/api/controls/scan', cf2aa);
  ok('Controls: scan detects red flags', (ctlScan.status === 200 || ctlScan.status === 201) && (ctlScan.json.candidates ?? 0) >= 2, `candidates=${ctlScan.json.candidates}`);
  const ctlFind = await inj('GET', '/api/controls/findings', cf2aa);
  const ctlKeys = (ctlFind.json.findings ?? []).map((f: any) => f.control_key);
  ok('Controls: duplicate-invoice + ghost-vendor findings raised', ctlKeys.includes('duplicate_invoice') && ctlKeys.includes('ghost_vendor'), `${JSON.stringify(ctlKeys)}`);
  const ctlRev = await inj('POST', `/api/controls/findings/${(ctlFind.json.findings ?? [])[0]?.id}/review`, cf2aa, { status: 'reviewed' });
  ok('Controls: a finding can be reviewed', (ctlRev.status === 200 || ctlRev.status === 201) && ctlRev.json.status === 'reviewed', `${ctlRev.status} ${ctlRev.json.status}`);
  await inj('POST', '/api/controls/scan', hqaa);
  const hqFind = await inj('GET', '/api/controls/findings', hqaa);
  ok('Controls: RLS-scoped — HQ never sees cf2’s findings', (hqFind.json.findings ?? []).every((f: any) => !String(f.entity_ref ?? '').includes('ACME') && !String(f.entity_ref ?? '').includes('9999999999999')), `hq findings=${(hqFind.json.findings ?? []).length}`);
  const jlAfterCtl = (await db.select().from(s.journalLines)).length;
  ok('Controls: no GL impact (journal lines unchanged)', jlAfterCtl === jlBeforeCtl, `before=${jlBeforeCtl} after=${jlAfterCtl}`);

  // ── C1 i18n / locale framework (Platform Phase 20) ──
  const locs = await inj('GET', '/api/i18n/locales', hqaa);
  ok('i18n: locale catalog lists the supported locales', (locs.json.locales ?? []).length >= 5 && (locs.json.locales ?? []).some((l: any) => l.code === 'th'), `${(locs.json.locales ?? []).length}`);
  await inj('PUT', '/api/i18n/me', hqaa, { locale: 'en' });
  const meEn = await inj('GET', '/api/i18n/me', hqaa);
  ok('i18n: a user can set their own locale (resolves to user)', meEn.json.locale === 'en' && meEn.json.source === 'user', `${meEn.json.locale}/${meEn.json.source}`);
  const badLoc = await inj('PUT', '/api/i18n/me', hqaa, { locale: 'xx' });
  ok('i18n: an unsupported locale is rejected (400 BAD_LOCALE)', badLoc.status === 400 && badLoc.json.error?.code === 'BAD_LOCALE', `${badLoc.status} ${badLoc.json.error?.code}`);
  const meCf2 = await inj('GET', '/api/i18n/me', cf2aa);
  ok('i18n: per-user — another user is unaffected by HQ’s choice', meCf2.json.locale !== 'en' || meCf2.json.source !== 'user', `${meCf2.json.locale}/${meCf2.json.source}`);

  // ── E4 white-label theming (Platform Phase 29) ──
  const th0 = await inj('GET', '/api/tenant/theme', hqaa);
  ok('Theme: default theme exposes an in-gamut oklch primary', /^oklch\(/.test(th0.json.theme?.primary_css ?? ''), `${th0.json.theme?.primary_css}`);
  const thPut = await inj('PUT', '/api/tenant/theme', hqaa, { primary_hue: 200, radius: 'lg', brand_name: 'HQ Brand', tagline: 'x' });
  ok('Theme: a tenant sets its brand tokens', (thPut.status === 200 || thPut.status === 201) && thPut.json.theme?.primary_hue === 200 && String(thPut.json.theme?.primary_css ?? '').includes('200'), `hue=${thPut.json.theme?.primary_hue}`);
  const badHue = await inj('PUT', '/api/tenant/theme', hqaa, { primary_hue: 400, radius: 'md' });
  ok('Theme: out-of-range hue rejected (400 BAD_HUE)', badHue.status === 400 && badHue.json.error?.code === 'BAD_HUE', `${badHue.status} ${badHue.json.error?.code}`);
  const badRad = await inj('PUT', '/api/tenant/theme', hqaa, { primary_hue: 10, radius: 'huge' });
  ok('Theme: bad radius rejected (400 BAD_RADIUS)', badRad.status === 400 && badRad.json.error?.code === 'BAD_RADIUS', `${badRad.status} ${badRad.json.error?.code}`);
  const thCf2 = await inj('GET', '/api/tenant/theme', cf2aa);
  ok('Theme: RLS-scoped — another tenant keeps its own theme (not HQ’s)', thCf2.json.theme?.primary_hue !== 200, `cf2 hue=${thCf2.json.theme?.primary_hue}`);

  // ── E1 onboarding + industry packs (Platform Phase 26) ──
  const ob0 = await inj('GET', '/api/onboarding', hqaa);
  ok('Onboarding: checklist exposes steps + percent', (ob0.json.steps ?? []).length >= 5 && typeof ob0.json.percent === 'number', `steps=${(ob0.json.steps ?? []).length} pct=${ob0.json.percent}`);
  await inj('POST', '/api/onboarding/steps/branding/complete', hqaa, {});
  const ob1 = await inj('GET', '/api/onboarding', hqaa);
  ok('Onboarding: completing a step advances progress', (ob1.json.steps ?? []).find((s: any) => s.key === 'branding')?.done === true && ob1.json.percent > 0, `pct=${ob1.json.percent}`);
  const obBadStep = await inj('POST', '/api/onboarding/steps/nope/complete', hqaa, {});
  ok('Onboarding: unknown step rejected (400 BAD_STEP)', obBadStep.status === 400 && obBadStep.json.error?.code === 'BAD_STEP', `${obBadStep.status} ${obBadStep.json.error?.code}`);
  const obApply = await inj('POST', '/api/onboarding/apply-pack', hqaa, { pack: 'restaurant' });
  ok('Onboarding: applying an industry pack seeds custom objects', (obApply.status === 200 || obApply.status === 201) && (obApply.json.objects_created ?? 0) >= 1, `created=${obApply.json.objects_created}`);
  const obApply2 = await inj('POST', '/api/onboarding/apply-pack', hqaa, { pack: 'restaurant' });
  ok('Onboarding: re-applying a pack is idempotent (0 new)', obApply2.json.objects_created === 0, `created=${obApply2.json.objects_created}`);
  const obBadPack = await inj('POST', '/api/onboarding/apply-pack', hqaa, { pack: 'nope' });
  ok('Onboarding: unknown pack rejected (400 BAD_PACK)', obBadPack.status === 400 && obBadPack.json.error?.code === 'BAD_PACK', `${obBadPack.status} ${obBadPack.json.error?.code}`);
  const coCf2 = await inj('GET', '/api/custom-objects', cf2aa);
  const cf2objs = Array.isArray(coCf2.json) ? coCf2.json : (coCf2.json?.objects ?? []);
  ok('Onboarding: RLS — the seeded objects do not leak to another tenant', !cf2objs.some((o: any) => (o.object_key ?? o.objectKey) === 'menu_recipe'), `cf2 objects=${cf2objs.length}`);

  // ── D1 API maturity / developer portal (Platform Phase 23) ──
  const dp0 = await inj('GET', '/api/developer/portal', hqaa);
  ok('Developer: portal exposes scopes / endpoints / tiers', (dp0.json.scopes ?? []).length >= 4 && (dp0.json.endpoints ?? []).length >= 4 && (dp0.json.tiers ?? []).length >= 3, `s=${(dp0.json.scopes ?? []).length} e=${(dp0.json.endpoints ?? []).length} t=${(dp0.json.tiers ?? []).length}`);
  await inj('POST', '/api/platform/api-keys', hqaa, { name: 'dev-test', scopes: ['catalog:read'] });
  const dp1 = await inj('GET', '/api/developer/portal', hqaa);
  const devKey = (dp1.json.keys ?? []).find((k: any) => k.name === 'dev-test') ?? (dp1.json.keys ?? [])[0];
  const setTier = await inj('PUT', `/api/developer/keys/${devKey?.id}/tier`, hqaa, { tier: 'partner' });
  ok('Developer: set a key rate tier', (setTier.status === 200 || setTier.status === 201) && setTier.json.tier === 'partner', `${setTier.status} ${setTier.json.tier}`);
  const badTier = await inj('PUT', `/api/developer/keys/${devKey?.id}/tier`, hqaa, { tier: 'gold' });
  ok('Developer: bad tier rejected (400 BAD_TIER)', badTier.status === 400 && badTier.json.error?.code === 'BAD_TIER', `${badTier.status} ${badTier.json.error?.code}`);
  const dpCf2 = await inj('GET', '/api/developer/portal', cf2aa);
  ok('Developer: RLS — another tenant does not see HQ’s keys', !(dpCf2.json.keys ?? []).some((k: any) => k.name === 'dev-test'), `cf2 keys=${(dpCf2.json.keys ?? []).length}`);

  // ── D2 connector framework (Platform Phase 24) ──
  const connCat = await inj('GET', '/api/connectors/catalog', hqaa);
  ok('Connectors: catalog lists line / shopee / bank_csv', (connCat.json.connectors ?? []).length >= 3 && (connCat.json.connectors ?? []).some((c: any) => c.type === 'shopee'), `${(connCat.json.connectors ?? []).length}`);
  const connBad = await inj('POST', '/api/connectors', hqaa, { type: 'nope' });
  ok('Connectors: unknown type rejected (400 BAD_CONNECTOR)', connBad.status === 400 && connBad.json.error?.code === 'BAD_CONNECTOR', `${connBad.status} ${connBad.json.error?.code}`);
  const connReg = await inj('POST', '/api/connectors', hqaa, { type: 'shopee' });
  const sync1 = await inj('POST', `/api/connectors/${connReg.json.id}/sync`, hqaa, {});
  ok('Connectors: first sync pulls + records a canonical batch', (sync1.status === 200 || sync1.status === 201) && sync1.json.pulled === 2 && sync1.json.created === 2, `pulled=${sync1.json.pulled} new=${sync1.json.created}`);
  const sync2 = await inj('POST', `/api/connectors/${connReg.json.id}/sync`, hqaa, {});
  ok('Connectors: re-sync is idempotent (0 new)', sync2.json.created === 0 && sync2.json.duplicates === 2, `new=${sync2.json.created} dup=${sync2.json.duplicates}`);
  const bankReg = await inj('POST', '/api/connectors', hqaa, { type: 'bank_csv' });
  const bankSync = await inj('POST', `/api/connectors/${bankReg.json.id}/sync`, hqaa, { csv: '2026-06-01,1500.00,deposit\n2026-06-02,-220.00,payment' });
  ok('Connectors: bank-CSV import parses statement lines', bankSync.json.pulled === 2 && bankSync.json.created === 2, `pulled=${bankSync.json.pulled}`);
  const cf2conn = await inj('POST', '/api/connectors', cf2aa, { type: 'shopee' });
  const cf2sync = await inj('POST', `/api/connectors/${cf2conn.json.id}/sync`, cf2aa, {});
  ok('Connectors: RLS — idempotency is per-tenant (cf2 syncs the same fixtures fresh)', cf2sync.json.created === 2, `cf2 new=${cf2sync.json.created}`);

  // ── E2 data-migration toolkit (Platform Phase 27) ──
  const migSrc = await inj('GET', '/api/migration/sources', hqaa);
  ok('Migration: source + entity catalogs exposed', (migSrc.json.sources ?? []).length >= 3 && (migSrc.json.entities ?? []).length >= 2, `s=${(migSrc.json.sources ?? []).length} e=${(migSrc.json.entities ?? []).length}`);
  const migRun = await inj('POST', '/api/migration/dry-run', hqaa, { source: 'loyverse', entity: 'products', rows: [{ sku: 'A1', item_name: 'Coffee' }, { sku: 'A2' }] });
  ok('Migration: dry-run maps source fields + flags invalid rows', (migRun.status === 200 || migRun.status === 201) && migRun.json.total === 2 && migRun.json.valid === 1 && (migRun.json.errors ?? []).length === 1, `total=${migRun.json.total} valid=${migRun.json.valid} err=${(migRun.json.errors ?? []).length}`);
  const migBadSrc = await inj('POST', '/api/migration/dry-run', hqaa, { source: 'nope', entity: 'products', rows: [] });
  ok('Migration: unknown source rejected (400 BAD_SOURCE)', migBadSrc.status === 400 && migBadSrc.json.error?.code === 'BAD_SOURCE', `${migBadSrc.status} ${migBadSrc.json.error?.code}`);
  const migBadEnt = await inj('POST', '/api/migration/dry-run', hqaa, { source: 'csv', entity: 'nope', rows: [] });
  ok('Migration: unknown entity rejected (400 BAD_ENTITY)', migBadEnt.status === 400 && migBadEnt.json.error?.code === 'BAD_ENTITY', `${migBadEnt.status} ${migBadEnt.json.error?.code}`);
  const migJobs = await inj('GET', '/api/migration/jobs', hqaa);
  ok('Migration: a dry-run is recorded as a job', (migJobs.json.jobs ?? []).length >= 1, `jobs=${(migJobs.json.jobs ?? []).length}`);
  const migJobsCf2 = await inj('GET', '/api/migration/jobs', cf2aa);
  ok('Migration: RLS — another tenant does not see HQ’s jobs', !(migJobsCf2.json.jobs ?? []).some((j: any) => j.source === 'loyverse'), `cf2 jobs=${(migJobsCf2.json.jobs ?? []).length}`);

  // ── C2 country localization packs (Platform Phase 21) ──
  const locPacks = await inj('GET', '/api/localization/packs', hqaa);
  ok('Localization: packs list TH (certified) + a draft country', (locPacks.json.packs ?? []).some((p: any) => p.country === 'TH' && p.status === 'certified') && (locPacks.json.packs ?? []).some((p: any) => p.status === 'draft'), `${(locPacks.json.packs ?? []).length}`);
  const locApply = await inj('POST', '/api/localization/apply', hqaa, { country: 'TH' });
  const locActive = await inj('GET', '/api/localization', hqaa);
  ok('Localization: applying a pack sets the active country + locale', (locApply.status === 200 || locApply.status === 201) && locApply.json.locale === 'th' && locActive.json.active?.country === 'TH', `${locActive.json.active?.country}`);
  const locBad = await inj('POST', '/api/localization/apply', hqaa, { country: 'ZZ' });
  ok('Localization: unsupported country rejected (400 BAD_COUNTRY)', locBad.status === 400 && locBad.json.error?.code === 'BAD_COUNTRY', `${locBad.status} ${locBad.json.error?.code}`);
  const locCf2 = await inj('GET', '/api/localization', cf2aa);
  ok('Localization: RLS — another tenant has its own (no HQ leak)', locCf2.json.active === null, `cf2 active=${locCf2.json.active?.country ?? 'none'}`);

  // ── C3 pluggable e-invoicing engine (Platform Phase 22) ──
  const eiProv = await inj('GET', '/api/einvoice/providers', token);
  ok('e-Invoice: provider catalog exposes stub + country adapters', (eiProv.json.providers ?? []).length >= 3 && (eiProv.json.providers ?? []).some((p: any) => p.key === 'stub'), `${(eiProv.json.providers ?? []).length}`);
  const eiSubmit = await inj('POST', '/api/einvoice/submit', token, { doc: { doc_ref: 'EINV-T1', seller: 'My Co', buyer: 'Customer', total: 1500 } });
  ok('e-Invoice: submit validates + returns an accepted ref (stub)', (eiSubmit.status === 200 || eiSubmit.status === 201) && eiSubmit.json.status === 'accepted' && String(eiSubmit.json.ref ?? '').startsWith('EINV-'), `${eiSubmit.json.status} ${eiSubmit.json.ref}`);
  const eiDup = await inj('POST', '/api/einvoice/submit', token, { doc: { doc_ref: 'EINV-T1', seller: 'My Co', buyer: 'Customer', total: 1500 } });
  ok('e-Invoice: re-submitting the same doc is idempotent', eiDup.json.idempotent === true && eiDup.json.ref === eiSubmit.json.ref, `idem=${eiDup.json.idempotent}`);
  const eiBad = await inj('POST', '/api/einvoice/submit', token, { doc: { doc_ref: 'EINV-T2', seller: 'My Co', buyer: 'Customer' } });
  ok('e-Invoice: an invalid document is rejected (400 BAD_DOC)', eiBad.status === 400 && eiBad.json.error?.code === 'BAD_DOC', `${eiBad.status} ${eiBad.json.error?.code}`);

  // ── E5 scale interfaces / ops (Platform Phase 30) ──
  const opsM = await inj('GET', '/api/ops/metrics', hqaa);
  ok('Ops: metrics expose uptime + cache + scale posture', typeof opsM.json.uptime_s === 'number' && opsM.json.cache?.provider === 'memory' && !!opsM.json.scale?.cache_provider, `cache=${opsM.json.cache?.provider}`);
  const st1 = await inj('GET', '/api/ops/cache-selftest', hqaa);
  const st2 = await inj('GET', '/api/ops/cache-selftest', hqaa);
  ok('Ops: CacheService round-trips (2nd read is a cache hit)', st1.json.ok === true && st1.json.cached === false && st2.json.cached === true, `first=${st1.json.cached} second=${st2.json.cached}`);

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
