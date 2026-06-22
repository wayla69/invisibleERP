/**
 * Cutover check — POS world-class P0: held orders + manager override (P0c),
 * payment terminal/intents/settlement + PSP webhook (P0b), offline idempotency (P0a).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover pos-p0
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
  // customer inventory so portal offline sale can decrement
  await db.insert(s.customerInventory).values({ tenantId: hq.id, itemId: 'A', itemDescription: 'Apple', currentStock: '100', reorderPoint: '0', uom: 'EA' }).onConflictDoNothing?.();

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

  // ── P0c: held orders ──
  const h = await inj('POST', '/api/pos/hold', token, { label: 'Table 5', cart: { items: [{ item_id: 'A', qty: 2 }] } });
  ok('hold → HOLD-', (h.status === 200 || h.status === 201) && /^HOLD-\d{8}-\d{3}$/.test(h.json.hold_no), `no=${h.json.hold_no}`);
  ok('held list has 1', (await inj('GET', '/api/pos/held', token)).json.held.length === 1);
  const rc = await inj('POST', `/api/pos/held/${h.json.hold_no}/recall`, token);
  ok('recall returns cart', (rc.status === 200 || rc.status === 201) && rc.json.cart?.items?.length === 1);
  ok('held list now 0 after recall', (await inj('GET', '/api/pos/held', token)).json.held.length === 0);

  // ── P0c: manager override ──
  const ov = await inj('POST', '/api/pos/override', token, { action: 'discount', amount: 50, reason_code: 'PRICE_MATCH', reason: 'competitor', approved_by: 'mgr1' });
  ok('override → OVR- + approver', (ov.status === 200 || ov.status === 201) && /^OVR-\d{8}-\d{3}$/.test(ov.json.override_no) && ov.json.approved_by === 'mgr1', `no=${ov.json.override_no}`);
  ok('override audit listed', (await inj('GET', '/api/pos/overrides', token)).json.overrides.some((o: any) => o.override_no === ov.json.override_no));

  // ── P0b: terminal + intents ──
  ok('register terminal', (await inj('POST', '/api/payments/terminal/register', token, { terminal_code: 'TERM1', provider: 'mock' })).json.status === 'active');
  const sale = await inj('POST', '/api/payments/terminal/charge', token, { terminal_code: 'TERM1', sale_no: 'SALE-X', amount: 100 });
  ok('charge sale → Captured (mock)', (sale.status === 200 || sale.status === 201) && /^PTI-\d{8}-\d{3}$/.test(sale.json.intent_no) && sale.json.status === 'Captured', `st=${sale.json.status}`);
  const pre = await inj('POST', '/api/payments/terminal/charge', token, { amount: 60, type: 'preauth' });
  ok('preauth → Authorized', pre.json.status === 'Authorized');
  const cap = await inj('POST', `/api/payments/terminal/intents/${pre.json.intent_no}/capture`, token, {});
  ok('capture preauth → Captured', (cap.status === 200 || cap.status === 201) && cap.json.status === 'Captured' && cap.json.captured_amount === 60);
  const overcap = await inj('POST', '/api/payments/terminal/charge', token, { amount: 40, type: 'preauth' });
  ok('over-capture → 400', (await inj('POST', `/api/payments/terminal/intents/${overcap.json.intent_no}/capture`, token, { amount: 999 })).status === 400);
  // refund
  const r30 = await inj('POST', `/api/payments/terminal/intents/${sale.json.intent_no}/refund`, token, { amount: 30 });
  ok('partial refund leaves remaining 70', r30.json.remaining === 70);
  ok('over-refund → 400', (await inj('POST', `/api/payments/terminal/intents/${sale.json.intent_no}/refund`, token, { amount: 80 })).status === 400);
  // void: cannot void captured
  ok('void captured → 400', (await inj('POST', `/api/payments/terminal/intents/${sale.json.intent_no}/void`, token)).status === 400);
  const pre2 = await inj('POST', '/api/payments/terminal/charge', token, { amount: 20, type: 'preauth' });
  ok('void authorized → Voided', (await inj('POST', `/api/payments/terminal/intents/${pre2.json.intent_no}/void`, token)).json.status === 'Voided');

  // ── P0b: real-provider switch is wired (Omise terminal, no key set → guarded) ──
  await inj('POST', '/api/payments/terminal/register', token, { terminal_code: 'OMTERM', provider: 'omise' });
  const omCharge = await inj('POST', '/api/payments/terminal/charge', token, { terminal_code: 'OMTERM', amount: 99 });
  ok('omise charge w/o key → PROVIDER_NOT_CONFIGURED 400', omCharge.status === 400 && /NOT_CONFIGURED/.test(JSON.stringify(omCharge.json)), `st=${omCharge.status}`);

  // ── P0b: PSP webhook (public, idempotent) ──
  const pre3 = await inj('POST', '/api/payments/terminal/charge', token, { amount: 15, type: 'preauth' });
  const wh = await inj('POST', '/api/payments/psp/webhook', undefined, { provider: 'mock', provider_ref: pre3.json.provider_ref, status: 'Captured' });
  ok('PSP webhook captures intent', wh.json.ok === true);
  const it = await inj('GET', `/api/payments/terminal/intents?sale_no=`, token);
  ok('webhook moved intent to Captured', it.json.intents.find((x: any) => x.intent_no === pre3.json.intent_no)?.status === 'Captured');

  // ── P0b: settlement ──
  const st = await inj('POST', '/api/payments/terminal/settle', token, { fee_pct: 2 });
  ok('settle batch → STL- + fees 2%', (st.status === 200 || st.status === 201) && /^STL-\d{8}-\d{3}$/.test(st.json.batch_no) && st.json.txn_count >= 1 && Math.abs(st.json.fees - st.json.gross * 0.02) < 0.01, `gross=${st.json.gross} fees=${st.json.fees} n=${st.json.txn_count}`);
  ok('settlements list', (await inj('GET', '/api/payments/terminal/settlements', token)).json.batches.length === 1);
  ok('reconcile batch', (await inj('POST', `/api/payments/terminal/settlements/${st.json.batch_no}/reconcile`, token)).json.status === 'Reconciled');

  // ── P0a: offline idempotency (replay same client_uuid → one sale) ──
  const op = { client_uuid: 'cu-1', captured_at: new Date().toISOString(), lines: [{ item_id: 'A', qty: 1, unit_price: 10 }] };
  const o1 = await inj('POST', '/api/portal/pos/offline-sync', token, { sales: [op] });
  ok('offline sync first → synced', o1.status === 200 || o1.status === 201);
  const o2 = await inj('POST', '/api/portal/pos/offline-sync', token, { sales: [op] });
  const dupe = JSON.stringify(o2.json).toLowerCase().includes('duplicate') || (o2.json?.summary?.duplicate >= 1);
  ok('offline replay same client_uuid → duplicate (idempotent)', dupe, JSON.stringify(o2.json).slice(0, 120));
  const offRows = await db.select().from(s.posOfflineSync).where(eq(s.posOfflineSync.clientUuid, 'cu-1'));
  ok('exactly one offline row for client_uuid', offRows.length === 1, `rows=${offRows.length}`);

  await app.close();
  await pg.close();
  console.log('\n── POS P0 (held/override + terminal/settlement + offline idempotency) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
