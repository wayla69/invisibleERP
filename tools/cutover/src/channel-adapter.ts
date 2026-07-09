/**
 * C6 — Delivery-aggregator OUTBOUND adapter framework. Menu push + order lifecycle (accept / reject /
 * status) call a per-platform provider — REAL HTTP when CHANNEL_API_URL_<P> is set, mock otherwise. We
 * stub global.fetch to a fake partner API and assert the wiring (URL, bearer auth, payload, KDS routing).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover channel-adapter
 */
import 'reflect-metadata';
import { createHmac } from 'node:crypto';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'chan-secret';
process.env.NODE_ENV = 'test';
process.env.CHANNEL_API_URL_GRAB = 'https://grab.test/partner';
process.env.CHANNEL_API_TOKEN_GRAB = 'grab-partner-token';
process.env.WEBHOOK_SECRET_GRAB = 'grab-inbound-secret';

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
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

const calls: { url: string; auth: string; body: any }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  if (url.startsWith('https://grab.test/')) {
    let body: any = {}; try { body = JSON.parse(init?.body ?? '{}'); } catch { /* */ }
    calls.push({ url, auth: String(init?.headers?.Authorization ?? ''), body });
    return { ok: true, status: 200, headers: { get: () => 'grab-req-1' }, json: async () => ({ id: 'grab-ack-1' }) } as any;
  }
  return realFetch(input, init);
}) as any;
const lastTo = (frag: string) => [...calls].reverse().find((c) => c.url.includes(frag));

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'T1', name: 'ร้านหนึ่ง', vatRegistered: true }]).onConflictDoNothing();
  const t1 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'T1')))[0].id);
  await db.insert(s.users).values([{ username: 'boss', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: t1 }]).onConflictDoNothing();
  await db.insert(s.menuItems).values([
    { tenantId: t1, sku: 'A', name: 'ผัดไทย', price: '120.00', isAvailable: true, active: true },
    { tenantId: t1, sku: 'B', name: 'ต้มยำ', price: '150.00', isAvailable: true, active: true },
  ]);

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { rawBody: true });
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inj = async (m: string, url: string, opts: { token?: string; payload?: any; headers?: any } = {}) => {
    const res = await app.inject({ method: m as any, url, headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) }, payload: opts.payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const token = (await inj('POST', '/api/login', { payload: { username: 'boss', password: 'pw' } })).json.token as string;

  // register a grab adapter for this store, auto_accept OFF (so we can test the accept flow)
  await inj('POST', '/api/channels/adapters', { token, payload: { platform: 'grab', store_ref: 'GRAB-001', auto_accept: false } });

  // ── 1. menu push → real POST to the partner /menu with bearer + items ──
  const ms = await inj('POST', '/api/channels/grab/menu-sync', { token });
  const menuCall = lastTo('/menu');
  ok('menu-sync → real POST to partner /menu (bearer + items + store_ref)',
    ms.json.pushed === true && ms.json.provider === 'grab' && !!menuCall && menuCall.auth === 'Bearer grab-partner-token' && menuCall.body.store_ref === 'GRAB-001' && (menuCall.body.items?.length ?? 0) === 2,
    JSON.stringify({ pushed: ms.json.pushed, items: menuCall?.body.items?.length }));

  // ── 2. inbound order webhook (auto_accept OFF) → order received, lines held off the KDS (new) ──
  const wh = await inj('POST', '/api/channels/grab/webhook', {
    headers: { 'x-webhook-secret': 'grab-inbound-secret' },
    payload: { orderID: 'G-1001', eventID: 'evt-1', merchantID: 'GRAB-001', deliveryFee: 20, items: [{ name: 'ผัดไทย', quantity: 2, price: 120 }] },
  });
  const orderNo = wh.json.order_no;
  const kdsNew = await db.execute(`SELECT kds_status FROM dine_in_order_items WHERE order_id=(SELECT id FROM dine_in_orders WHERE order_no='${orderNo}')`).then((r: any) => (r.rows ?? r)[0]?.kds_status);
  ok('inbound webhook (auto_accept off) → order received, lines NOT yet on the KDS (new)', wh.json.status === 'processed' && !!orderNo && kdsNew === 'new', JSON.stringify({ st: wh.json.status, kds: kdsNew }));

  // ── 3. accept → confirm to platform + route lines to the KDS (queued) ──
  const acc = await inj('POST', `/api/channels/orders/${orderNo}/accept`, { token });
  const acceptCall = lastTo(`/orders/G-1001/accept`);
  const kdsAfter = await db.execute(`SELECT kds_status FROM dine_in_order_items WHERE order_id=(SELECT id FROM dine_in_orders WHERE order_no='${orderNo}')`).then((r: any) => (r.rows ?? r)[0]?.kds_status);
  ok('accept → POST partner /accept, order routed to KDS (queued)',
    acc.json.routed_to_kds === true && acc.json.fulfillment_status === 'accepted' && acc.json.post_ok === true && !!acceptCall && kdsAfter === 'queued',
    JSON.stringify({ routed: acc.json.routed_to_kds, kds: kdsAfter }));

  // ── 4. status callback → real POST back to the platform ──
  const st = await inj('POST', `/api/channels/orders/${orderNo}/status`, { token, payload: { status: 'out_for_delivery' } });
  const statusCall = lastTo(`/orders/G-1001/status`);
  ok('status update → POST partner /status, post_ok true', st.json.post_ok === true && st.json.posted_to_platform === 'grab' && statusCall?.body.status === 'out_for_delivery', JSON.stringify({ ok: st.json.post_ok }));

  // ── 5. reject a second order → cancelled + platform rejected ──
  const wh2 = await inj('POST', '/api/channels/grab/webhook', { headers: { 'x-webhook-secret': 'grab-inbound-secret' }, payload: { orderID: 'G-1002', eventID: 'evt-2', merchantID: 'GRAB-001', items: [{ name: 'ต้มยำ', quantity: 1, price: 150 }] } });
  const rej = await inj('POST', `/api/channels/orders/${wh2.json.order_no}/reject`, { token, payload: { reason: '86 out of stock' } });
  ok('reject → POST partner /reject, order cancelled', rej.json.fulfillment_status === 'rejected' && rej.json.routed_to_kds === false && !!lastTo('/orders/G-1002/reject') && rej.json.post_ok === true, JSON.stringify({ st: rej.json.fulfillment_status }));

  // ── 6. an unconfigured platform falls back to the mock provider (no network) ──
  await inj('POST', '/api/channels/adapters', { token, payload: { platform: 'lineman', store_ref: 'LM-1', auto_accept: true } });
  const before = calls.length;
  const lm = await inj('POST', '/api/channels/lineman/menu-sync', { token });
  ok('unconfigured platform (lineman) → mock provider, no partner HTTP call', lm.json.pushed === true && lm.json.provider === 'mock' && calls.length === before, JSON.stringify({ provider: lm.json.provider, newCalls: calls.length - before }));

  // ── 7. inbound webhook with a bad secret → 401 (auth unchanged by the outbound work) ──
  const bad = await inj('POST', '/api/channels/grab/webhook', { headers: { 'x-webhook-secret': 'wrong' }, payload: { orderID: 'G-9', merchantID: 'GRAB-001', items: [] } });
  ok('inbound webhook bad secret → 401 BAD_WEBHOOK_SIG', bad.status === 401 && bad.json.error?.code === 'BAD_WEBHOOK_SIG', JSON.stringify({ s: bad.status }));

  // ── 7b. security review L-2: an HMAC signing secret upgrades inbound auth to HMAC-over-body ──
  process.env.WEBHOOK_HMAC_SECRET_GRAB = 'grab-hmac-key';
  const hmacBody = { orderID: 'G-77', eventID: 'evt-77', merchantID: 'GRAB-001', items: [{ name: 'ผัดไทย', quantity: 1, price: 80 }] };
  const goodSig = createHmac('sha256', 'grab-hmac-key').update(JSON.stringify(hmacBody)).digest('hex');
  const staticOnly = await inj('POST', '/api/channels/grab/webhook', { headers: { 'x-webhook-secret': 'grab-inbound-secret' }, payload: hmacBody });
  ok('L-2: with HMAC configured, a static-secret-only inbound is rejected (401 BAD_WEBHOOK_SIG)', staticOnly.status === 401 && staticOnly.json.error?.code === 'BAD_WEBHOOK_SIG', JSON.stringify({ s: staticOnly.status }));
  const signed = await inj('POST', '/api/channels/grab/webhook', { headers: { 'x-webhook-signature': goodSig }, payload: hmacBody });
  ok('L-2: a valid HMAC-over-body inbound is accepted (proves rawBody plumbing)', signed.status !== 401 && signed.json.error?.code !== 'BAD_WEBHOOK_SIG', JSON.stringify({ s: signed.status, c: signed.json?.error?.code }));
  delete process.env.WEBHOOK_HMAC_SECRET_GRAB;

  console.log('\n── C6 — Delivery-aggregator outbound adapter framework (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} channel-adapter checks failed` : `\n✅ All ${checks.length} channel-adapter checks passed`);
  globalThis.fetch = realFetch;
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
