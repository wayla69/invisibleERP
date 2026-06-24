/**
 * C3 — Real card-gateway charge path. The simple tender path (recordTender → resolveGateway) must make a
 * REAL PSP charge for Opn (Omise) / Stripe and never report Captured for money that did not move.
 * We stub global.fetch to a fake PSP so the integration wiring (auth, satang minor-units, status mapping,
 * token requirement, error → Failed row) is verified without real network.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover payments-gateway
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'pg-secret';
process.env.NODE_ENV = 'test';
process.env.OPN_SECRET_KEY = 'skey_test_opn';
process.env.STRIPE_SECRET_KEY = 'sk_test_stripe';

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

// ── fake PSP over a stubbed fetch ────────────────────────────────────────────
interface Captured { url: string; auth: string; amount: string | null }
const fetchCalls: Captured[] = [];
let omiseMode: 'ok' | 'decline' = 'ok';
const realFetch = globalThis.fetch;
function installFetchStub() {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    const auth = String(init?.headers?.Authorization ?? init?.headers?.authorization ?? '');
    const body = init?.body;
    const amount = body && typeof body.get === 'function' ? body.get('amount') : null;
    if (url.includes('omise.co/charges')) {
      fetchCalls.push({ url, auth, amount });
      if (omiseMode === 'decline') return { ok: false, status: 402, json: async () => ({ object: 'error', code: 'card_declined', message: 'card was declined' }) } as any;
      return { ok: true, status: 200, json: async () => ({ id: 'chrg_test_1', object: 'charge', status: 'successful', paid: true }) } as any;
    }
    if (url.includes('api.stripe.com/v1/payment_intents')) {
      fetchCalls.push({ url, auth, amount });
      return { ok: true, status: 200, json: async () => ({ id: 'pi_test_1', object: 'payment_intent', status: 'succeeded' }) } as any;
    }
    return realFetch(input, init);
  }) as any;
}

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง', vatRegistered: true }]).onConflictDoNothing();
  const t1 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'T1')))[0].id);
  await db.insert(s.users).values([{ username: 'cash1', passwordHash: await pw.hash('pw1'), role: 'Admin', tenantId: t1, customerName: 'ร้านหนึ่ง' }]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const token = (await inj('POST', '/api/login', undefined, { username: 'cash1', password: 'pw1' })).json.token as string;
  const tender = (b: any) => inj('POST', '/api/payments', token, b);
  const lastCall = () => fetchCalls[fetchCalls.length - 1];

  installFetchStub();

  // ── 1. Opn card WITH token → REAL Omise charge, Captured, real provider ref ──
  const before = fetchCalls.length;
  const r1 = await tender({ sale_no: 'S-PG-1', method: 'Card', amount: 107.5, currency: 'THB', gateway: 'opn', token: 'tokn_visa_test' });
  ok('Opn card+token → real Omise charge, Captured, ref from PSP',
    (r1.status === 200 || r1.status === 201) && r1.json.status === 'Captured' && r1.json.gateway_ref === 'chrg_test_1' && fetchCalls.length === before + 1,
    JSON.stringify({ s: r1.json.status, ref: r1.json.gateway_ref }));

  // ── 2. the PSP call used satang minor units + basic auth (no fake capture) ──
  ok('Omise call: amount in satang (10750) + Basic auth on secret key',
    lastCall()?.url.includes('omise.co/charges') && lastCall()?.amount === '10750' && lastCall()?.auth.startsWith('Basic '),
    JSON.stringify({ amt: lastCall()?.amount, auth: lastCall()?.auth.slice(0, 6) }));

  // ── 3. Opn WITHOUT a token → Pending, NO charge made (never fake-captures) ──
  const before3 = fetchCalls.length;
  const r3 = await tender({ sale_no: 'S-PG-2', method: 'Card', amount: 200, currency: 'THB', gateway: 'opn' });
  ok('Opn no-token → Pending, no PSP charge attempted',
    r3.json.status === 'Pending' && fetchCalls.length === before3,
    JSON.stringify({ s: r3.json.status, calls: fetchCalls.length - before3 }));

  // ── 4. PSP decline → 4xx and NO money booked (no Captured tender). The request tx rolls back on the
  //       rethrown PSP error, so the safety property is "nothing captured", not a surviving Failed row. ──
  omiseMode = 'decline';
  const r4 = await tender({ sale_no: 'S-PG-3', method: 'Card', amount: 50, currency: 'THB', gateway: 'opn', token: 'tokn_bad' });
  const list3 = await inj('GET', '/api/payments?sale_no=S-PG-3', token);
  const captured3 = (list3.json.payments ?? []).some((p: any) => p.status === 'Captured');
  ok('Opn decline → 4xx + no Captured tender (money not booked)',
    r4.status >= 400 && !captured3,
    JSON.stringify({ http: r4.status, captured: captured3 }));
  omiseMode = 'ok';

  // ── 5. Stripe card WITH token → real PaymentIntent, Captured, Bearer auth ──
  const before5 = fetchCalls.length;
  const r5 = await tender({ sale_no: 'S-PG-4', method: 'Card', amount: 80, currency: 'THB', gateway: 'stripe', token: 'pm_card_test' });
  ok('Stripe card+token → real PaymentIntent, Captured, Bearer auth',
    r5.json.status === 'Captured' && r5.json.gateway_ref === 'pi_test_1' && fetchCalls.length === before5 + 1 && lastCall()?.auth.startsWith('Bearer '),
    JSON.stringify({ s: r5.json.status, ref: r5.json.gateway_ref }));

  // ── 6. mock gateway (default) → Captured, no PSP call ──
  const before6 = fetchCalls.length;
  const r6 = await tender({ sale_no: 'S-PG-5', method: 'Cash', amount: 60, currency: 'THB' });
  ok('default mock gateway → Captured, no PSP network call', r6.json.status === 'Captured' && fetchCalls.length === before6, JSON.stringify({ s: r6.json.status }));

  // ── 7. Opn configured-away (no secret) → falls back to mock (Captured), no PSP call ──
  const savedKey = process.env.OPN_SECRET_KEY; delete process.env.OPN_SECRET_KEY;
  const before7 = fetchCalls.length;
  const r7 = await tender({ sale_no: 'S-PG-6', method: 'Card', amount: 30, currency: 'THB', gateway: 'opn', token: 'tokn_x' });
  ok('Opn without OPN_SECRET_KEY → mock fallback (Captured), no PSP call', r7.json.status === 'Captured' && fetchCalls.length === before7, JSON.stringify({ s: r7.json.status }));
  process.env.OPN_SECRET_KEY = savedKey;

  // ── 8. idempotency: same key replays the first tender, no second charge ──
  const before8 = fetchCalls.length;
  const k = 'idem-pg-0001';
  const a = await tender({ sale_no: 'S-PG-7', method: 'Card', amount: 90, currency: 'THB', gateway: 'opn', token: 'tokn_idem', idempotency_key: k });
  const b = await tender({ sale_no: 'S-PG-7', method: 'Card', amount: 90, currency: 'THB', gateway: 'opn', token: 'tokn_idem', idempotency_key: k });
  ok('idempotency: same key → replayed tender, exactly ONE PSP charge',
    a.json.payment_no === b.json.payment_no && b.json.replayed === true && fetchCalls.length === before8 + 1,
    JSON.stringify({ same: a.json.payment_no === b.json.payment_no, charges: fetchCalls.length - before8 }));

  globalThis.fetch = realFetch;
  console.log('\n── C3 — Real card-gateway charge path (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} payments-gateway checks failed` : `\n✅ All ${checks.length} payments-gateway checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
