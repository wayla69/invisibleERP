/**
 * Cutover check — POS world-class P0: held orders + manager override (P0c),
 * payment terminal/intents/settlement + PSP webhook (P0b), offline idempotency (P0a).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover pos-p0
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-secret';
process.env.NODE_ENV = 'test';
// C5: exercise the REAL HMAC webhook path (previously the no-secret dev/test bypass carried the checks).
// Per-provider secret so only 'mock' webhooks require a signature in this run.
process.env.PSP_WEBHOOK_SECRET_MOCK = 'psp-test-secret';

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
  // rawBody:true — the PSP webhook signature is computed over req.rawBody (mirrors main.ts).
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { rawBody: true });
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

  // ── P0b/C5: PSP webhook — SIGNED (HMAC over "<ts>.<rawBody>", replay-window enforced) ──
  const { createHmac } = await import('node:crypto');
  const pspHook = async (body: any, opts?: { ts?: number; badSig?: boolean }) => {
    const raw = JSON.stringify(body);
    const ts = opts?.ts ?? Math.floor(Date.now() / 1000);
    const sig = opts?.badSig ? 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
      : createHmac('sha256', 'psp-test-secret').update(`${ts}.${raw}`).digest('hex');
    const res = await app.inject({ method: 'POST', url: '/api/payments/psp/webhook', payload: raw, headers: { 'content-type': 'application/json', 'x-psp-signature': sig, 'x-psp-timestamp': String(ts) } });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const pre3 = await inj('POST', '/api/payments/terminal/charge', token, { amount: 15, type: 'preauth' });
  const whUnsigned = await inj('POST', '/api/payments/psp/webhook', undefined, { provider: 'mock', provider_ref: pre3.json.provider_ref, status: 'Captured' });
  ok('C5: UNSIGNED webhook rejected once a secret is configured (fail-closed, even in test env)', whUnsigned.status === 401 && whUnsigned.json?.error?.code === 'BAD_WEBHOOK_SIGNATURE', `${whUnsigned.status} ${whUnsigned.json?.error?.code}`);
  const whBad = await pspHook({ provider: 'mock', provider_ref: pre3.json.provider_ref, status: 'Captured' }, { badSig: true });
  ok('C5: tampered signature rejected (BAD_WEBHOOK_SIGNATURE)', whBad.status === 401 && whBad.json?.error?.code === 'BAD_WEBHOOK_SIGNATURE', `${whBad.status}`);
  const whStale = await pspHook({ provider: 'mock', provider_ref: pre3.json.provider_ref, status: 'Captured' }, { ts: Math.floor(Date.now() / 1000) - 400 });
  ok('C5: stale timestamp rejected (WEBHOOK_STALE replay window)', whStale.status === 401 && whStale.json?.error?.code === 'WEBHOOK_STALE', `${whStale.status} ${whStale.json?.error?.code}`);
  const wh = await pspHook({ provider: 'mock', provider_ref: pre3.json.provider_ref, status: 'Captured' });
  ok('PSP webhook (signed) captures intent', wh.json.ok === true, JSON.stringify(wh.json));
  const it = await inj('GET', `/api/payments/terminal/intents?sale_no=`, token);
  ok('webhook moved intent to Captured', it.json.intents.find((x: any) => x.intent_no === pre3.json.intent_no)?.status === 'Captured');

  // ── C5: PSP event-id idempotency — a redelivered event can never re-process/flap the intent ──
  const pre4 = await inj('POST', '/api/payments/terminal/charge', token, { amount: 25, type: 'preauth' });
  const ev1 = await pspHook({ provider: 'mock', provider_ref: pre4.json.provider_ref, status: 'Captured', event_id: 'evt-1001' });
  ok('C5: first delivery of evt-1001 processes (→ Captured)', ev1.json.ok === true && ev1.json.intent_no === pre4.json.intent_no, JSON.stringify(ev1.json));
  const ev1re = await pspHook({ provider: 'mock', provider_ref: pre4.json.provider_ref, status: 'Refunded', event_id: 'evt-1001' });
  ok('C5: redelivery of evt-1001 (even with a DIFFERENT status) acks as duplicate_event', ev1re.json.note === 'duplicate_event', JSON.stringify(ev1re.json));
  const it4 = await inj('GET', `/api/payments/terminal/intents?sale_no=`, token);
  ok('C5: the intent did NOT flap on the redelivered event (still Captured)', it4.json.intents.find((x: any) => x.intent_no === pre4.json.intent_no)?.status === 'Captured');

  // ── C5: tip-on-terminal — charge-time tip + the classic capture-time tip adjustment on a pre-auth ──
  const tipSale = await inj('POST', '/api/payments/terminal/charge', token, { terminal_code: 'TERM1', amount: 100, tip: 20 });
  ok('C5: charge with tip → total 120 captured, tip recorded', tipSale.json.status === 'Captured' && tipSale.json.amount === 120 && tipSale.json.tip === 20, JSON.stringify({ a: tipSale.json.amount, t: tipSale.json.tip }));
  const tab = await inj('POST', '/api/payments/terminal/charge', token, { amount: 50, type: 'preauth' });
  const tabCap = await inj('POST', `/api/payments/terminal/intents/${tab.json.intent_no}/capture`, token, { tip: 10 });
  ok('C5: bar-tab capture adds the gratuity above the auth (50 auth → 60 captured, tip 10)', tabCap.json.status === 'Captured' && tabCap.json.captured_amount === 60 && tabCap.json.tip === 10, JSON.stringify(tabCap.json));
  const tabOver = await inj('POST', '/api/payments/terminal/charge', token, { amount: 30, type: 'preauth' });
  ok('C5: OVER_CAPTURE still guards the BASE amount (tip does not launder a bigger base)', (await inj('POST', `/api/payments/terminal/intents/${tabOver.json.intent_no}/capture`, token, { amount: 999, tip: 5 })).status === 400);
  const itTip = await inj('GET', `/api/payments/terminal/intents?sale_no=`, token);
  ok('C5: intents expose the tip split', itTip.json.intents.find((x: any) => x.intent_no === tipSale.json.intent_no)?.tip === 20);

  // ── P0b: settlement ──
  const st = await inj('POST', '/api/payments/terminal/settle', token, { fee_pct: 2 });
  ok('settle batch → STL- + fees 2%', (st.status === 200 || st.status === 201) && /^STL-\d{8}-\d{3}$/.test(st.json.batch_no) && st.json.txn_count >= 1 && Math.abs(st.json.fees - st.json.gross * 0.02) < 0.01, `gross=${st.json.gross} fees=${st.json.fees} n=${st.json.txn_count}`);
  ok('settlements list', (await inj('GET', '/api/payments/terminal/settlements', token)).json.batches.length === 1);
  ok('reconcile batch', (await inj('POST', `/api/payments/terminal/settlements/${st.json.batch_no}/reconcile`, token)).json.status === 'Reconciled');

  // ── C5: acquirer settlement-report reconciliation — a real per-intent match, not a status flip ──
  // build the "acquirer report" from the batch's own intents (the intents API deliberately hides provider_ref)
  const dbIntents = await db.select().from(s.paymentIntents).where(eq(s.paymentIntents.settlementBatchNo, st.json.batch_no));
  const report = dbIntents.map((x: any) => ({ provider_ref: String(x.providerRef), amount: Number(x.capturedAmount), fee: Math.round(Number(x.capturedAmount) * 2) / 100 }));
  // 1) a broken report: one intent omitted (unreported_intent), one amount off by +5 (amount_mismatch),
  //    one ref the ledger has never seen (missing_intent) → 3 discrepancies, batch NOT auto-reconciled
  const broken = report.slice(1).map((r: any, i: number) => (i === 0 ? { ...r, amount: r.amount + 5 } : r)).concat([{ provider_ref: 'acq_ghost_1', amount: 42, fee: 0.84 }]);
  const imp1 = await inj('POST', `/api/payments/terminal/settlements/${st.json.batch_no}/import`, token, { rows: broken });
  ok('C5: discrepancy import flags all three classes (mismatch + missing_intent + unreported_intent)',
    imp1.status < 300 && imp1.json.discrepancies === 3
      && imp1.json.lines.some((l: any) => l.match_status === 'amount_mismatch')
      && imp1.json.lines.some((l: any) => l.match_status === 'missing_intent' && l.provider_ref === 'acq_ghost_1')
      && imp1.json.lines.some((l: any) => l.match_status === 'unreported_intent'),
    JSON.stringify({ d: imp1.json.discrepancies, m: imp1.json.matched }));
  const lines1 = await inj('GET', `/api/payments/terminal/settlements/${st.json.batch_no}/lines`, token);
  ok('C5: settlement lines persisted with per-intent match status', lines1.json.count === imp1.json.rows && lines1.json.lines.some((l: any) => l.note?.includes('vs captured')), `n=${lines1.json.count}`);
  // 2) the corrected report reconciles: every intent matched exactly → Reconciled, matched Σ = batch gross
  const imp2 = await inj('POST', `/api/payments/terminal/settlements/${st.json.batch_no}/import`, token, { rows: report });
  ok('C5: clean re-import reconciles the batch (0 discrepancies, matched Σ = gross)',
    imp2.status < 300 && imp2.json.discrepancies === 0 && imp2.json.status === 'Reconciled' && Math.abs(imp2.json.reconciled_amount - st.json.gross) < 0.01,
    JSON.stringify({ r: imp2.json.reconciled_amount, g: st.json.gross }));
  const empt = await inj('POST', `/api/payments/terminal/settlements/${st.json.batch_no}/import`, token, { rows: [] });
  ok('C5: an empty report is rejected (validation)', empt.status === 400, `${empt.status}`);

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
