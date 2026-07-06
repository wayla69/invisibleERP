/**
 * Cutover check — POS world-class P1: pricing engine (P1a), POS audit + reason codes + blind
 * drawer close (P1c), hash-chained electronic journal + e-Tax submission (P1b).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover pos-p1
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
const IN_WINDOW = '2026-06-22T08:00:00Z';  // Bangkok Mon 15:00 (inside 14:00–16:00)
const OUT_WINDOW = '2026-06-22T03:00:00Z'; // Bangkok Mon 10:00 (outside)

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
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq.id },
    { username: 'pricer', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq.id }, // G6: distinct approver for price-rule maker-checker (≠ admin)
  ]).onConflictDoNothing();

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
  // G6 maker-checker (SoD R10): a price rule is staged inactive on create and must be ACTIVATED by a
  // DIFFERENT user. mkRule creates (admin) then approves (pricer ≠ admin) so downstream pricing is unchanged.
  const pricerTok = (await inj('POST', '/api/login', undefined, { username: 'pricer', password: 'admin123' })).json.token;
  const mkRule = async (r: any) => { const res = await inj('POST', '/api/pricing/rules', token, r); if (res.json?.id) await inj('POST', `/api/pricing/rules/${res.json.id}/approve`, pricerTok); return res; };

  // ── P1a: pricing engine ──
  await mkRule({ name: 'Happy Hour A', scope: 'item', target_id: 'A', dow: '1', time_start: '14:00', time_end: '16:00', type: 'percent', value: 50, priority: 10 });
  const hhIn = await inj('POST', '/api/pricing/quote', token, { at: IN_WINDOW, lines: [{ sku: 'A', qty: 2, unit_price: 100 }] });
  ok('happy-hour applies in-window (50% off 200 → 100)', hhIn.json.lines?.[0]?.discount === 100 && hhIn.json.total === 100, `disc=${hhIn.json.lines?.[0]?.discount}`);
  const hhOut = await inj('POST', '/api/pricing/quote', token, { at: OUT_WINDOW, lines: [{ sku: 'A', qty: 2, unit_price: 100 }] });
  ok('happy-hour excluded out-of-window', hhOut.json.lines?.[0]?.discount === 0 && hhOut.json.total === 200, `disc=${hhOut.json.lines?.[0]?.discount}`);

  await inj('PUT', '/api/pricing/combos/CMB', token, { components: [{ component_sku: 'X', qty: 1, unit_price_override: 30 }, { component_sku: 'Y', qty: 2, unit_price_override: 20 }] });
  const combo = await inj('POST', '/api/pricing/quote', token, { at: IN_WINDOW, lines: [{ sku: 'CMB', qty: 1 }] });
  ok('combo explodes into component lines', combo.json.lines?.length === 2 && combo.json.subtotal === 70, `lines=${combo.json.lines?.length} sub=${combo.json.subtotal}`);

  await mkRule({ name: 'BOGO B', scope: 'item', target_id: 'B', type: 'bogo', min_qty: 1, priority: 20 });
  const bogo = await inj('POST', '/api/pricing/quote', token, { at: IN_WINDOW, lines: [{ sku: 'B', qty: 4, unit_price: 50 }] });
  ok('BOGO buy-1-get-1 on qty 4 → 2 free (disc 100)', bogo.json.lines?.[0]?.discount === 100, `disc=${bogo.json.lines?.[0]?.discount}`);

  await mkRule({ name: 'Bulk C', scope: 'item', target_id: 'C', type: 'qty_break', min_qty: 3, value: 20, priority: 30 });
  const qb = await inj('POST', '/api/pricing/quote', token, { at: IN_WINDOW, lines: [{ sku: 'C', qty: 3, unit_price: 100 }] });
  ok('qty-break ≥3 → 20% off (disc 60)', qb.json.lines?.[0]?.discount === 60, `disc=${qb.json.lines?.[0]?.discount}`);

  const sc6 = await inj('POST', '/api/pricing/quote', token, { at: IN_WINDOW, party_size: 6, service_charge_pct: 10, lines: [{ sku: 'Z', qty: 1, unit_price: 1000 }] });
  ok('service charge on 6-top (10% → 100)', sc6.json.service_charge === 100 && sc6.json.total === 1100, `sc=${sc6.json.service_charge}`);
  const sc4 = await inj('POST', '/api/pricing/quote', token, { at: IN_WINDOW, party_size: 4, service_charge_pct: 10, lines: [{ sku: 'Z', qty: 1, unit_price: 1000 }] });
  ok('no service charge under threshold', sc4.json.service_charge === 0);
  const rnd = await inj('POST', '/api/pricing/quote', token, { at: IN_WINDOW, rounding: 1, lines: [{ sku: 'Z', qty: 1, unit_price: 101.4 }] });
  ok('satang rounding to nearest baht (101.40 → 101)', rnd.json.total === 101, `total=${rnd.json.total}`);

  // ── P1c: reason codes + audit + blind close ──
  ok('create reason code', (await inj('POST', '/api/pos/audit/reason-codes', token, { code: 'PRICE_MATCH', label: 'ราคาคู่แข่ง', applies_to: 'discount' })).json.created === true);
  const rc = await inj('GET', '/api/pos/audit/reason-codes?applies_to=discount', token);
  ok('reason code listed for applies_to=discount', rc.json.reason_codes?.some((r: any) => r.code === 'PRICE_MATCH'));
  await inj('POST', '/api/pos/override', token, { action: 'discount', sale_no: 'SALE-Z', amount: 50, reason_code: 'PRICE_MATCH', approved_by: 'mgr1' });
  const audit = await inj('GET', '/api/pos/audit', token);
  const row = audit.json.entries?.find((e: any) => e.action === 'POS.discount' && e.entity_id === 'SALE-Z');
  ok('override wrote central audit row', !!row && row.actor === 'admin' && row.meta?.reason_code === 'PRICE_MATCH', JSON.stringify(row?.meta ?? {}).slice(0, 80));

  const till = await inj('POST', '/api/payments/till/open', token, { opening_float: 1000 });
  const close = await inj('POST', '/api/payments/till/close', token, { session_no: till.json.session_no, closing_count: 1000 });
  ok('blind close: variance computed server-side from submitted count', (close.status === 200 || close.status === 201) && close.json.expected_cash === 1000 && close.json.variance === 0, `exp=${close.json.expected_cash} var=${close.json.variance}`);

  // ── P1b: hash-chained journal ──
  const j1 = await inj('POST', '/api/pos/journal/append', token, { doc_type: 'SALE', doc_no: 'S1', payload: { total: 100 } });
  const j2 = await inj('POST', '/api/pos/journal/append', token, { doc_type: 'SALE', doc_no: 'S2', payload: { total: 200 } });
  const j3 = await inj('POST', '/api/pos/journal/append', token, { doc_type: 'VOID', doc_no: 'S1', payload: { reason: 'mistake' } });
  ok('journal seq increments + chains', j1.json.seq === 1 && j2.json.seq === 2 && j3.json.seq === 3 && j2.json.prev_hash === j1.json.hash, `seqs=${j1.json.seq},${j2.json.seq},${j3.json.seq}`);
  ok('journal verify → ok', (await inj('GET', '/api/pos/journal/verify', token)).json.ok === true);
  // tamper: mutate a past payload directly in the DB → chain must break at that seq
  await db.update(s.posJournal).set({ payload: { total: 999 } }).where(eq(s.posJournal.seq, 2));
  const tampered = await inj('GET', '/api/pos/journal/verify', token);
  ok('journal verify detects tamper (broken_at 2)', tampered.json.ok === false && tampered.json.broken_at === 2, `broken_at=${tampered.json.broken_at}`);

  // ── P1b: e-Tax submission (mock provider) — submission builds + signs the stored tax invoice's XML,
  //         so seed a real tax-invoice row to target (no cert configured → submitted unsigned).
  await db.insert(s.taxInvoices).values({
    tenantId: hq.id, docNo: 'TIV-202606-0001', type: 'full', issueDate: '2026-06-24', sourceType: 'AR', sourceRef: 'INV-X',
    sellerName: 'HQ', sellerTaxId: '0105551234567', sellerBranchCode: '00000', sellerAddress: 'กรุงเทพฯ',
    buyerName: 'ลูกค้า', buyerTaxId: '0992001234567', buyerAddress: 'กรุงเทพฯ', currency: 'THB',
    subtotal: '100.00', discount: '0', vatRate: '0.0700', vatAmount: '7.00', grandTotal: '107.00', isVatInclusive: false, status: 'Issued',
  }).onConflictDoNothing();
  const sub = await inj('POST', '/api/tax/etax/submit/TIV-202606-0001', token, {});
  ok('e-Tax submit (mock) → Accepted', sub.json.status === 'Accepted' && /^mock-/.test(sub.json.provider_ref));
  ok('e-Tax status → Accepted', (await inj('GET', '/api/tax/etax/status/TIV-202606-0001', token)).json.status === 'Accepted');
  ok('e-Tax resubmit idempotent', (await inj('POST', '/api/tax/etax/submit/TIV-202606-0001', token, {})).json.idempotent === true);

  await app.close();
  await pg.close();
  console.log('\n── POS P1 (pricing + audit/blind-close + journal/e-Tax) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
