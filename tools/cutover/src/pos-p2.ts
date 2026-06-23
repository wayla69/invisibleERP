/**
 * Cutover check — POS world-class P2: multi-terminal locking + auto-86 (P2a), delivery-aggregator
 * adapters (P2b), tiered loyalty + house accounts + gift-card PIN/reload + labor (P2c).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover pos-p2
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

  // seed: table, menu item + recipe + ingredient, member + ledger, gift card, employee
  const [tbl] = await db.insert(s.diningTables).values({ tenantId: hq.id, tableNo: 'T1' }).returning({ id: s.diningTables.id });
  const [mi] = await db.insert(s.menuItems).values({ tenantId: hq.id, sku: 'PADTHAI', name: 'Pad Thai', type: 'food', price: '60', trackStock: true, isAvailable: true }).returning({ id: s.menuItems.id });
  const [rec] = await db.insert(s.menuRecipes).values({ tenantId: hq.id, menuItemId: mi.id, sku: 'PADTHAI', active: true }).returning({ id: s.menuRecipes.id });
  await db.insert(s.menuRecipeLines).values({ tenantId: hq.id, recipeId: rec.id, ingredientItemId: 'NOODLE', ingredientDescription: 'Noodle', qtyPer: '1', uom: 'EA' });
  await db.insert(s.customerInventory).values({ tenantId: hq.id, itemId: 'NOODLE', itemDescription: 'Noodle', currentStock: '0', reorderPoint: '0', uom: 'EA' });
  const [mem] = await db.insert(s.posMembers).values({ tenantId: hq.id, memberCode: 'M-1', name: 'Som', balance: '800', lifetime: '1500', tier: 'Standard' }).returning({ id: s.posMembers.id });
  const old = new Date(Date.now() - 400 * 86400000); // beyond 365-day expiry
  await db.insert(s.posMemberLedger).values({ tenantId: hq.id, memberId: mem.id, txnType: 'Earn', points: '500', txnDate: old, balanceAfter: '500' });
  await db.insert(s.posMemberLedger).values({ tenantId: hq.id, memberId: mem.id, txnType: 'Earn', points: '300', balanceAfter: '800' });
  await db.insert(s.giftCards).values({ tenantId: hq.id, cardNo: 'GC-T1', initialAmount: '100', balance: '100', status: 'Active' });
  await db.insert(s.employees).values({ tenantId: hq.id, empCode: 'E1', name: 'Server One', nationalId: '0000000000000' }).onConflictDoNothing?.();

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

  // ── P2a: optimistic locking ──
  const w1 = await inj('POST', `/api/pos/scale/table/${tbl.id}/status`, token, { status: 'occupied', rev: 0 });
  ok('table status write at rev 0 → rev 1', (w1.status === 200 || w1.status === 201) && w1.json.rev === 1, `rev=${w1.json.rev}`);
  const stale = await inj('POST', `/api/pos/scale/table/${tbl.id}/status`, token, { status: 'paying', rev: 0 });
  ok('stale write (rev 0) → 409 STALE_WRITE', stale.status === 409 && /STALE_WRITE/.test(JSON.stringify(stale.json)), `st=${stale.status}`);
  const w2 = await inj('POST', `/api/pos/scale/table/${tbl.id}/status`, token, { status: 'paying', rev: 1 });
  ok('fresh write (rev 1) → rev 2', w2.json.rev === 2);

  // ── P2a: auto-86 ──
  const r86 = await inj('POST', '/api/pos/scale/availability/recompute', token);
  ok('auto-86: ingredient at 0 → dish unavailable', r86.json.changed?.some((c: any) => c.sku === 'PADTHAI' && c.is_available === false), JSON.stringify(r86.json.changed ?? []));
  await db.update(s.customerInventory).set({ currentStock: '50' }).where(eq(s.customerInventory.itemId, 'NOODLE'));
  const r86b = await inj('POST', '/api/pos/scale/availability/recompute', token);
  ok('auto-86: ingredient restocked → dish available again', r86b.json.changed?.some((c: any) => c.sku === 'PADTHAI' && c.is_available === true));

  // ── P2b: aggregator adapters ──
  ok('register grab adapter', (await inj('POST', '/api/channels/adapters', token, { platform: 'grab', store_ref: 'S1' })).json.created === true);
  const grab = await inj('POST', '/api/channels/grab/webhook', undefined, { eventID: 'E1', orderID: 'O1', merchantID: 'S1', eater: { name: 'Lek' }, items: [{ name: 'Pad Thai', quantity: 2, price: 60 }] });
  ok('grab webhook → order lands (DIN-)', grab.json.status === 'processed' && /^DIN-/.test(grab.json.order_no) && grab.json.subtotal === 120, `${grab.json.status} ${grab.json.order_no}`);
  const dup = await inj('POST', '/api/channels/grab/webhook', undefined, { eventID: 'E1', orderID: 'O1', merchantID: 'S1', items: [{ name: 'Pad Thai', quantity: 2, price: 60 }] });
  ok('grab webhook duplicate eventID → deduped', dup.json.status === 'duplicate');
  await inj('POST', '/api/channels/adapters', token, { platform: 'lineman', store_ref: 'S2' });
  const lm = await inj('POST', '/api/channels/lineman/webhook', undefined, { event_id: 'L1', order_id: 'LO1', branch_id: 'S2', items: [{ name: 'Tom Yum', qty: 1, unit_price: 80 }] });
  ok('lineman webhook (own mapper) → processed', lm.json.status === 'processed' && lm.json.subtotal === 80);
  const orders = await inj('GET', '/api/channels/orders', token);
  ok('channel orders board lists aggregator orders', orders.json.orders?.length >= 2);
  const stRT = await inj('POST', `/api/channels/orders/${grab.json.order_no}/status`, token, { status: 'preparing' });
  ok('status callback round-trip', stRT.json.fulfillment_status === 'preparing' && stRT.json.posted_to_platform === 'grab');
  ok('menu sync-out push', (await inj('POST', '/api/channels/grab/menu-sync', token)).json.pushed === true);

  // ── P2b security: aggregator webhook requires the per-platform shared secret (fail-closed) ──
  process.env.CHANNEL_WEBHOOK_SECRET = 'agg-sekret';
  const wbBody = { eventID: 'E-SEC', orderID: 'O-SEC', merchantID: 'S1', items: [{ name: 'x', quantity: 1, price: 10 }] };
  const secMiss = await app.inject({ method: 'POST', url: '/api/channels/grab/webhook', payload: wbBody });
  ok('webhook without secret (secret configured) → 401', secMiss.statusCode === 401, `${secMiss.statusCode}`);
  const secWrong = await app.inject({ method: 'POST', url: '/api/channels/grab/webhook', headers: { 'x-webhook-secret': 'nope' }, payload: wbBody });
  ok('webhook with wrong secret → 401', secWrong.statusCode === 401, `${secWrong.statusCode}`);
  const secOk = await app.inject({ method: 'POST', url: '/api/channels/grab/webhook', headers: { 'x-webhook-secret': 'agg-sekret' }, payload: { ...wbBody, eventID: 'E-SEC2', orderID: 'O-SEC2' } });
  const secOkJson = (() => { try { return secOk.json(); } catch { return {}; } })();
  ok('webhook with correct secret → processed (RLS-scoped write)', secOk.statusCode < 300 && secOkJson.status === 'processed', `${secOk.statusCode} ${secOkJson.status}`);
  delete process.env.CHANNEL_WEBHOOK_SECRET;

  // ── P2c: tiered loyalty + expiry ──
  await inj('POST', '/api/loyalty/tiers', token, { tier: 'Gold', min_lifetime: 1000, earn_mult: 2, redeem_mult: 1 });
  const eq2 = await inj('GET', `/api/loyalty/members/${mem.id}/earn-quote?spend=100`, token);
  ok('Gold tier earns 2× (100 → 200)', eq2.json.tier === 'Gold' && eq2.json.points === 200, `tier=${eq2.json.tier} pts=${eq2.json.points}`);
  const red = await inj('GET', `/api/loyalty/members/${mem.id}/redeemable`, token);
  ok('points expiry: old Earn excluded (redeemable 300, expired 500)', red.json.redeemable === 300 && red.json.expired === 500, `r=${red.json.redeemable} e=${red.json.expired}`);

  // ── P2c: house account → AR ──
  const ha = await inj('POST', '/api/pos/house-account', token, { sale_no: 'SALE-HA', amount: 250 });
  ok('on-account sale → open AR invoice', (ha.status === 200 || ha.status === 201) && ha.json.status === 'Unpaid' && ha.json.amount === 250);
  ok('house-account outstanding reflects it', (await inj('GET', '/api/pos/house-account', token)).json.outstanding >= 250);

  // ── P2c: gift-card PIN + reload ──
  ok('set gift-card PIN', (await inj('POST', '/api/pos/giftcards/GC-T1/pin', token, { pin: '1234' })).json.pin_set === true);
  ok('balance with correct PIN', (await inj('GET', '/api/pos/giftcards/GC-T1/balance?pin=1234', token)).json.balance === 100);
  ok('balance with wrong PIN → 403', (await inj('GET', '/api/pos/giftcards/GC-T1/balance?pin=0000', token)).status === 403);
  ok('reload tops up balance (100 + 50 → 150)', (await inj('POST', '/api/pos/giftcards/GC-T1/reload', token, { amount: 50, pin: '1234' })).json.balance === 150);

  // ── P2c: labor time-clock ──
  ok('clock-in', (await inj('POST', '/api/pos/labor/clock-in', token, { emp_code: 'E1' })).json.status === 'Open');
  ok('double clock-in → 400', (await inj('POST', '/api/pos/labor/clock-in', token, { emp_code: 'E1' })).status === 400);
  const out = await inj('POST', '/api/pos/labor/clock-out', token, { emp_code: 'E1', break_minutes: 0 });
  ok('clock-out → Closed + hours', out.json.status === 'Closed' && out.json.hours >= 0);
  ok('labor report totals hours', (await inj('GET', '/api/pos/labor/report', token)).json.count === 1);

  await app.close();
  await pg.close();
  console.log('\n── POS P2 (locking/auto-86 + aggregators + loyalty/house/gift/labor) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
