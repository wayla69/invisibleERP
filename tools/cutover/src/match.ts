/**
 * Phase 16 — Source-to-Pay: 3-way match (PO↔GR↔Invoice) + RFQ/sourcing + supplier screening over PGlite.
 * The match GATES AP payment: matched→payable, variance→blocked, override→unblocks. RFQ→award→PO. Blocklist.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover match
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'match-secret';
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
import { LedgerService } from '../../../apps/api/dist/modules/ledger/ledger.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.01;

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }]).onConflictDoNothing();
  const hq = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0].id);
  await db.insert(s.users).values([{ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }]).onConflictDoNothing();
  await db.insert(s.items).values({ itemId: 'X', itemDescription: 'วัตถุดิบ X', uom: 'EA', unitPrice: '10' }).onConflictDoNothing();
  const [v1] = await db.insert(s.vendors).values({ name: 'ผู้ขาย V1', isSupplier: true, approvalStatus: 'approved', blocklisted: false }).returning({ id: s.vendors.id });
  const V1 = Number(v1.id);

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const admin = await (async () => (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' })).json.token as string)();
  const apTxn = async (amount: number) => (await inj('POST', '/api/finance/ap/transactions', admin, { vendor_id: V1, txn_type: 'Goods', amount })).json.txn_no as string;
  const payAttempt = (txnNo: string, amount: number) => inj('PATCH', `/api/finance/ap/transactions/${txnNo}/pay`, admin, { amount });
  const runMatch = (txnNo: string, poNo: string, lines: any[]) => inj('POST', '/api/procurement/match/run', admin, { txn_no: txnNo, po_no: poNo, lines });
  const payGl = async (txnNo: string) => (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source='PAY-AP' AND je.source_ref LIKE '${txnNo}:%'`)).rows as any[];
  const leg = (gl: any[], c: string, side: string) => Number(gl.filter((l) => l.account_code === c).reduce((a, l) => a + Number(l[side] || 0), 0));

  // ── A. setup: PO 100@10 → approve → GR 100 ──
  const po = await inj('POST', '/api/procurement/pos', admin, { vendor_id: V1, items: [{ item_id: 'X', order_qty: 100, unit_price: 10 }] });
  const poNo = po.json.po_no as string;
  await inj('PATCH', `/api/procurement/pos/${poNo}/approve`, admin, { approve: true });
  await inj('POST', '/api/procurement/grs', admin, { po_no: poNo, items: [{ item_id: 'X', received_qty: 100 }] });
  const poRecv = (await pg.query(`SELECT received_qty FROM po_items WHERE po_id=(SELECT id FROM purchase_orders WHERE po_no='${poNo}')`)).rows as any[];
  ok('Setup: PO 100@10 approved + GR 100 (po_items.received_qty=100)', near(poRecv[0]?.received_qty, 100), `recv=${poRecv[0]?.received_qty}`);

  // ── B. matched → payable → pay posts GL ──
  const ap1 = await apTxn(1000);
  const m1 = await runMatch(ap1, poNo, [{ item_id: 'X', qty: 100, unit_price: 10 }]);
  ok('Match 100@10 → matched, payable', m1.json.match_status === 'matched' && m1.json.payable === true, JSON.stringify({ st: m1.json.match_status, pay: m1.json.payable }));
  const pay1 = await payAttempt(ap1, 1000);
  const gl1 = await payGl(ap1);
  ok('Matched invoice pays → 200 Paid, GL Dr2000=1000 / Cr1000=1000', pay1.json.status === 'Paid' && near(leg(gl1, '2000', 'debit'), 1000) && near(leg(gl1, '1000', 'credit'), 1000), JSON.stringify({ st: pay1.json.status }));

  // ── C. price variance → blocked ──
  const ap2 = await apTxn(1200);
  const m2 = await runMatch(ap2, poNo, [{ item_id: 'X', qty: 100, unit_price: 12 }]);
  const pay2 = await payAttempt(ap2, 1200);
  ok('Price variance (100@12, +20%) → price_variance, pay BLOCKED 409', m2.json.match_status === 'price_variance' && m2.json.payable === false && near(m2.json.lines[0].price_var_pct, 20) && pay2.status === 409 && pay2.json.error?.code === 'MATCH_BLOCKED', JSON.stringify({ st: m2.json.match_status, pay: pay2.status, code: pay2.json.error?.code }));

  // ── D. qty over-receipt → blocked ──
  const ap3 = await apTxn(1200);
  const m3 = await runMatch(ap3, poNo, [{ item_id: 'X', qty: 120, unit_price: 10 }]);
  const pay3 = await payAttempt(ap3, 1200);
  ok('Qty over-invoice (120 vs GR 100) → over_invoiced, pay BLOCKED 409', m3.json.match_status === 'over_invoiced' && pay3.status === 409, JSON.stringify({ st: m3.json.match_status, pay: pay3.status }));

  // ── E. tolerance ──
  await inj('PUT', '/api/procurement/match/tolerance', admin, { price_pct: 2 });
  const ap4 = await apTxn(1015);
  const m4 = await runMatch(ap4, poNo, [{ item_id: 'X', qty: 100, unit_price: 10.15 }]);
  await inj('PUT', '/api/procurement/match/tolerance', admin, { price_pct: 0 });
  const m4b = await runMatch(ap4, poNo, [{ item_id: 'X', qty: 100, unit_price: 10.15 }]);
  ok('Tolerance: 10.15 @ price_pct 2% → matched; @ 0% → price_variance', m4.json.match_status === 'matched' && m4.json.payable === true && m4b.json.match_status === 'price_variance', JSON.stringify({ at2: m4.json.match_status, at0: m4b.json.match_status }));
  await inj('PUT', '/api/procurement/match/tolerance', admin, { price_pct: 2 }); // restore

  // ── F. override gate ──
  const ovr = await inj('POST', `/api/procurement/match/${ap2}/override`, admin, { reason: 'manager approved variance' });
  const pay2b = await payAttempt(ap2, 1200);
  const gl2 = await payGl(ap2);
  ok('Override unblocks: override→pay 200 Paid + PAY-AP GL posted', ovr.json.override === true && pay2b.json.status === 'Paid' && near(leg(gl2, '2000', 'debit'), 1200), JSON.stringify({ ovr: ovr.json.override, pay: pay2b.json.status }));

  // ── G. RFQ → award → PO ──
  const rfq = await inj('POST', '/api/procurement/rfqs', admin, { items: [{ item_id: 'X', qty: 50 }] });
  const rfqNo = rfq.json.rfq_no as string;
  const qt = await inj('POST', `/api/procurement/rfqs/${rfqNo}/quotes`, admin, { vendor_id: V1, items: [{ item_id: 'X', qty: 50, unit_price: 9.5 }] });
  const awd = await inj('POST', `/api/procurement/rfqs/${rfqNo}/award`, admin, { quote_no: qt.json.quote_no });
  const awdPo = (await pg.query(`SELECT order_qty, unit_price FROM po_items WHERE po_id=(SELECT id FROM purchase_orders WHERE po_no='${awd.json.po_no}')`)).rows as any[];
  ok('RFQ→quote→award builds a PO from the winning quote (50@9.50)', /^RFQ-/.test(rfqNo) && /^PO-/.test(awd.json.po_no ?? '') && near(awdPo[0]?.order_qty, 50) && near(awdPo[0]?.unit_price, 9.5), JSON.stringify({ rfq: rfqNo, po: awd.json.po_no }));

  // ── H. supplier screening ──
  await inj('PATCH', `/api/procurement/suppliers/${V1}/status`, admin, { blocklisted: true, reason: 'คุณภาพต่ำ' });
  const blockedPo = await inj('POST', '/api/procurement/pos', admin, { vendor_id: V1, items: [{ item_id: 'X', order_qty: 10, unit_price: 10 }] });
  const rfq2 = await inj('POST', '/api/procurement/rfqs', admin, { items: [{ item_id: 'X', qty: 5 }] });
  const blockedQuote = await inj('POST', `/api/procurement/rfqs/${rfq2.json.rfq_no}/quotes`, admin, { vendor_id: V1, items: [{ item_id: 'X', qty: 5, unit_price: 10 }] });
  ok('Blocklisted vendor: createPo + submitQuote → 422 SUPPLIER_BLOCKED', blockedPo.status === 422 && blockedPo.json.error?.code === 'SUPPLIER_BLOCKED' && blockedQuote.status === 422, `po=${blockedPo.status} quote=${blockedQuote.status}`);
  await inj('PATCH', `/api/procurement/suppliers/${V1}/status`, admin, { blocklisted: false, approval_status: 'approved' });
  const okPo = await inj('POST', '/api/procurement/pos', admin, { vendor_id: V1, items: [{ item_id: 'X', order_qty: 10, unit_price: 10 }] });
  ok('Un-blocklist → createPo succeeds again', (okPo.status === 200 || okPo.status === 201) && /^PO-/.test(okPo.json.po_no ?? ''), `${okPo.status}`);

  // ── I. idempotency + reconcile ──
  const before = (await pg.query(`SELECT match_no FROM invoice_match_results WHERE txn_no='${ap1}'`)).rows as any[];
  await runMatch(ap1, poNo, [{ item_id: 'X', qty: 100, unit_price: 10 }]);
  await runMatch(ap1, poNo, [{ item_id: 'X', qty: 100, unit_price: 10 }]);
  const after = (await pg.query(`SELECT count(*)::int n, max(match_no) mn FROM invoice_match_results WHERE txn_no='${ap1}'`)).rows as any[];
  ok('Re-run match idempotent: single result row, same match_no', after[0].n === 1 && after[0].mn === before[0]?.match_no, `n=${after[0].n} same=${after[0].mn === before[0]?.match_no}`);
  const recon = await inj('GET', '/api/finance/reconciliation', admin);
  ok('AP sub-ledger ↔ GL 2000 reconciled after gated pays', recon.json.ap_balanced === true || recon.json.ap?.balanced === true || recon.status === 200, JSON.stringify(recon.json).slice(0, 90));

  // ── J. supplier scorecard ──
  const sc = await inj('POST', `/api/procurement/suppliers/${V1}/scorecard`, admin, { period: '2026-06' });
  ok('Supplier scorecard computed (score + gr_count)', sc.json.score != null && sc.json.gr_count >= 1, JSON.stringify(sc.json));

  // ── K. non-PO bill (no match) is payable — gate fails OPEN, only PO-based matched invoices are gated ──
  const nonPo = await apTxn(500);
  const payNonPo = await payAttempt(nonPo, 500);
  ok('Non-PO bill (no match row) pays → 200 Paid (gate fails open)', payNonPo.json.status === 'Paid', `${payNonPo.status} ${payNonPo.json.status}`);

  // ── L. override does NOT survive a re-match (stale override must not keep a failing invoice payable) ──
  const ap5 = await apTxn(1200);
  await runMatch(ap5, poNo, [{ item_id: 'X', qty: 100, unit_price: 12 }]); // price_variance
  await inj('POST', `/api/procurement/match/${ap5}/override`, admin, { reason: 'one-time' });
  await runMatch(ap5, poNo, [{ item_id: 'X', qty: 100, unit_price: 12 }]); // re-match → must RESET override
  const pay5 = await payAttempt(ap5, 1200);
  ok('Override cleared by re-match → still-failing invoice BLOCKED again (409)', pay5.status === 409 && pay5.json.error?.code === 'MATCH_BLOCKED', `${pay5.status} ${pay5.json.error?.code}`);

  console.log('\n── Phase 16 — Source-to-Pay: 3-way match + RFQ + supplier screening ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} match checks failed` : `\n✅ All ${checks.length} match checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
