/**
 * Cutover check — WIRING: the standalone P0–P2 modules wired into the live transaction flows.
 * Journal/audit auto-feed, e-Tax auto-submit, pricing-at-checkout, auto-86 on sale, terminal→tender,
 * realtime push, drawer/print.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover pos-wiring
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
  // VAT-registered seller so issueFull works (e-Tax auto-submit)
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ Co', vatRegistered: true, taxId: '0105561000003', vatRate: '0.07' }]).onConflictDoNothing();
  const hq = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0];
  await db.insert(s.users).values({ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq.id }).onConflictDoNothing();
  // pricing item, auto-86 recipe, dining table
  await db.insert(s.menuItems).values({ tenantId: hq.id, sku: 'A', name: 'Item A', type: 'food', price: '100' }).onConflictDoNothing();
  const [dish] = await db.insert(s.menuItems).values({ tenantId: hq.id, sku: 'DISH', name: 'Dish', type: 'food', price: '50', trackStock: true, isAvailable: true }).returning({ id: s.menuItems.id });
  const [rec] = await db.insert(s.menuRecipes).values({ tenantId: hq.id, menuItemId: dish.id, sku: 'DISH', active: true }).returning({ id: s.menuRecipes.id });
  await db.insert(s.menuRecipeLines).values({ tenantId: hq.id, recipeId: rec.id, ingredientItemId: 'ING', ingredientDescription: 'Ingredient', qtyPer: '1', uom: 'EA' });
  await db.insert(s.customerInventory).values({ tenantId: hq.id, itemId: 'ING', itemDescription: 'Ingredient', currentStock: '1', reorderPoint: '0', uom: 'EA' });
  const [tbl] = await db.insert(s.diningTables).values({ tenantId: hq.id, tableNo: 'T1' }).returning({ id: s.diningTables.id });

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

  // ── Wiring: journal auto-feed on sale ──
  const sale1 = await inj('POST', '/api/portal/pos/sales', token, { payment_method: 'Cash', items: [{ item_id: 'A', qty: 1, unit_price: 100 }] });
  ok('portal sale created', !!sale1.json.sale_no, sale1.json.sale_no);
  const jr = await inj('GET', '/api/pos/journal', token);
  ok('sale auto-appended to electronic journal', jr.json.entries?.some((e: any) => e.doc_type === 'SALE' && e.doc_no === sale1.json.sale_no));
  ok('journal chain verifies after auto-feed', (await inj('GET', '/api/pos/journal/verify', token)).json.ok === true);

  // ── Wiring: pricing at checkout (opt-in) ──
  await inj('POST', '/api/pricing/rules', token, { name: 'Half A', scope: 'item', target_id: 'A', type: 'percent', value: 50, priority: 10 });
  const priced = await inj('POST', '/api/portal/pos/sales', token, { apply_pricing: true, payment_method: 'Cash', items: [{ item_id: 'A', qty: 1, unit_price: 100 }] });
  ok('pricing applied at checkout (50% → discount 50)', priced.json.pricing_discount === 50 && priced.json.total === 53.5, `disc=${priced.json.pricing_discount} total=${priced.json.total}`);
  const noPrice = await inj('POST', '/api/portal/pos/sales', token, { payment_method: 'Cash', items: [{ item_id: 'A', qty: 1, unit_price: 100 }] });
  ok('pricing NOT applied without opt-in (back-compat)', noPrice.json.pricing_discount === 0 && noPrice.json.total === 107);

  // ── Wiring: auto-86 on sale (recipe ingredient depletes → dish unavailable) ──
  await inj('POST', '/api/portal/pos/sales', token, { payment_method: 'Cash', items: [{ item_id: 'DISH', qty: 1, unit_price: 50 }] });
  const avail = await inj('GET', '/api/pos/scale/availability', token);
  ok('auto-86 fired on sale (DISH unavailable after ingredient hit 0)', avail.json.items?.some((i: any) => i.sku === 'DISH' && i.is_available === false), JSON.stringify(avail.json.items ?? []));

  // ── Wiring: refund → audit + journal ──
  const refund = await inj('POST', '/api/payments/refunds', token, { payment_no: sale1.json.payment_no, amount: 10 });
  ok('refund processed', (refund.status === 200 || refund.status === 201) && !!refund.json.refund_no, `st=${refund.status}`);
  ok('refund wrote central audit row', (await inj('GET', '/api/pos/audit?action=refund', token)).json.entries?.some((e: any) => e.action === 'POS.refund' && e.entity_id === sale1.json.payment_no));
  ok('refund appended to journal', (await inj('GET', '/api/pos/journal', token)).json.entries?.some((e: any) => e.doc_type === 'REFUND' && e.doc_no === refund.json.refund_no));

  // ── Wiring: full tax invoice → e-Tax auto-submit ──
  const tiv = await inj('POST', '/api/tax-invoices/full', token, { source_type: 'POS', source_ref: sale1.json.sale_no, buyer: { name: 'ACME Co', tax_id: '0105561000003', address: '1 Bangkok' } });
  ok('full tax invoice issued', !!tiv.json.doc_no, `${tiv.status} ${JSON.stringify(tiv.json).slice(0, 160)}`);
  ok('tax invoice auto-submitted to e-Tax (Accepted)', (await inj('GET', `/api/tax/etax/status/${tiv.json.doc_no}`, token)).json.status === 'Accepted');

  // ── Wiring: card terminal capture → tender recorded ──
  const charge = await inj('POST', '/api/payments/terminal/charge', token, { amount: 100, sale_no: 'SALE-TERM', record_tender: true });
  ok('terminal capture records a card tender', charge.json.status === 'Captured' && /^PAY-/.test(charge.json.payment_no ?? ''), `pay=${charge.json.payment_no}`);

  // ── Wiring: realtime push + drawer/print ──
  await inj('POST', `/api/pos/scale/table/${tbl.id}/status`, token, { status: 'occupied', rev: 0 });
  const ev = await inj('GET', '/api/pos/scale/events/recent', token);
  ok('table status change published to realtime bus', ev.json.events?.some((e: any) => e.type === 'table' && e.table_id === tbl.id));
  ok('cash-drawer kick returns ESC/POS command', !!(await inj('POST', '/api/pos/scale/drawer-kick', token)).json.escpos_base64);
  ok('print-job bundles receipt + drawer', (await inj('POST', `/api/pos/scale/print-job/${sale1.json.sale_no}`, token)).json.queued === true);

  await app.close();
  await pg.close();
  console.log('\n── WIRING (modules → live flows) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
