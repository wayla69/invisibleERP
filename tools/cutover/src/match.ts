/**
 * Phase 16 — Source-to-Pay: 3-way match (PO↔GR↔Invoice) + RFQ/sourcing + supplier screening over PGlite.
 * The match GATES AP payment: matched→payable, variance→blocked, override→unblocks. RFQ→award→PO. Blocklist.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover match
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'match-secret';
process.env.MAIL_FROM = process.env.MAIL_FROM || 'shop@example.com'; // doc-email path reaches the SMTP guard
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
const truthy = (v: any) => v === true || v === 't' || v === 'true' || v === 1; // pg boolean coercion (PGlite/raw)

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    // second Admin — vendors is a shared (tenant_id NULL) master (0034): writing it needs the RLS bypass,
    // which only an Admin session sets, so the VBC (0270) maker-checker approver must also be Admin (a
    // DIFFERENT username from the requester still enforces the SoD check).
    { username: 'vbcApprover', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: hq },
    // non-Admin (RLS-scoped) procurement users — Procurement role carries both procurement + masterdata
    { username: 'procT1', passwordHash: await pw.hash('pw'), role: 'Procurement', tenantId: t1 },
    { username: 'procT2', passwordHash: await pw.hash('pw'), role: 'Procurement', tenantId: t2 },
    { username: 'apprv', passwordHash: await pw.hash('pw'), role: 'FinancialController', tenantId: hq }, // AP-PAY checker (≠ admin requester)
    { username: 'apclerk', passwordHash: await pw.hash('pw'), role: 'ApClerk', tenantId: hq }, // PE-5: creditors-only (the match beneficiary) — must NOT set the tolerance
    { username: 'capT1', passwordHash: await pw.hash('pw'), role: 'StockCounter', tenantId: t1 }, // pr_raise-only (no procurement/creditors) — Quick Capture lane (docs/34)
  ]).onConflictDoNothing();
  // The Procurement role default is now SoD-clean (procurement/pr_raise only). These fixtures need the
  // legacy bundle (md_vendor for supplier screening, etc.) → grant it via an explicit per-user override
  // (overrides take precedence over the role default — see resolvePermissions).
  for (const un of ['procT1', 'procT2']) {
    const uid = Number((await db.select().from(s.users).where(eq(s.users.username, un)))[0].id);
    await db.insert(s.userPermissions).values(
      ['procurement', 'creditors', 'ar', 'delivery', 'masterdata', 'approvals'].map((perm) => ({ userId: uid, perm })),
    ).onConflictDoNothing();
  }
  await db.insert(s.items).values({ itemId: 'X', itemDescription: 'วัตถุดิบ X', uom: 'EA', unitPrice: '10' }).onConflictDoNothing();
  // V1 = legacy shared master (tenant_id NULL). Seeded via the raw superuser db so RLS WITH CHECK is bypassed.
  const [v1] = await db.insert(s.vendors).values({ name: 'ผู้ขาย V1', isSupplier: true, approvalStatus: 'approved', blocklisted: false }).returning({ id: s.vendors.id });
  const V1 = Number(v1.id);
  // per-tenant owned vendors for the isolation assertions (section M)
  const [va] = await db.insert(s.vendors).values({ tenantId: t1, name: 'ผู้ขายของ T1', isSupplier: true, approvalStatus: 'approved', blocklisted: false }).returning({ id: s.vendors.id });
  const [vb] = await db.insert(s.vendors).values({ tenantId: t2, name: 'ผู้ขายของ T2', isSupplier: true, approvalStatus: 'approved', blocklisted: false }).returning({ id: s.vendors.id });
  const VA = Number(va.id), VB = Number(vb.id);
  // Two near-duplicate vendors in HQ for the match-merge (DQM) assertions (section H5). Same phone + similar
  // name so the detector flags both a phone and a name reason.
  const [vd1] = await db.insert(s.vendors).values({ tenantId: hq, name: 'บริษัท เอบีซี เทรดดิ้ง จำกัด', isSupplier: true, phone: '02-777-8888', approvalStatus: 'approved', blocklisted: false }).returning({ id: s.vendors.id });
  const [vd2] = await db.insert(s.vendors).values({ tenantId: hq, name: 'เอบีซี เทรดดิ้ง', isSupplier: true, phone: '02-777-8888', email: 'abc@trade.co.th', approvalStatus: 'approved', blocklisted: false }).returning({ id: s.vendors.id });
  const VD1 = Number(vd1.id), VD2 = Number(vd2.id);

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ bodyLimit: 16 * 1024 * 1024 })); // upload-channel bodies (base64 image/PDF), mirrors main.ts
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json, text: res.payload };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const admin = await login('admin', 'admin123');
  const procT1 = await login('procT1', 'pw'); // RLS-scoped to t1
  const procT2 = await login('procT2', 'pw'); // RLS-scoped to t2
  const apprv = await login('apprv', 'pw');   // AP-PAY approver (≠ admin)
  const vbcApprover = await login('vbcApprover', 'pw'); // VBC (0270) approver — Admin, ≠ admin requester
  const capT1 = await login('capT1', 'pw');   // pr_raise-only capturer (Quick Capture lane)
  const apTxn = async (amount: number) => (await inj('POST', '/api/finance/ap/transactions', admin, { vendor_id: V1, txn_type: 'Goods', amount })).json.txn_no as string;
  // AP-PAY maker-checker: requesting a payment (admin) is gated on the 3-way match; a successful request
  // is PendingApproval until a DIFFERENT authorized user approves it. payAttempt = the request (used for the
  // match-gate block assertions); payFull = request + approve (used where a real disbursement is expected).
  const payAttempt = (txnNo: string, amount: number) => inj('PATCH', `/api/finance/ap/transactions/${txnNo}/pay`, admin, { amount });
  const payFull = async (txnNo: string, amount: number) => {
    const req = await payAttempt(txnNo, amount);
    if (!req.json?.payment_no) return req; // blocked at request (match gate) → return the request result as-is
    return inj('POST', `/api/finance/ap/payments/${req.json.payment_no}/approve`, apprv);
  };
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
  const pay1 = await payFull(ap1, 1000);
  const gl1 = await payGl(ap1);
  ok('Matched invoice request+approve → bill Paid, GL Dr2000=1000 / Cr1000=1000', pay1.json.bill_status === 'Paid' && near(leg(gl1, '2000', 'debit'), 1000) && near(leg(gl1, '1000', 'credit'), 1000), JSON.stringify({ st: pay1.json.status, bill: pay1.json.bill_status }));

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
  // PE-5 — the AP beneficiary (creditors) that runs the match + releases payment must NOT set the tolerance
  // that governs whether every invoice auto-passes; only an approver duty (exec/approvals) may.
  const apclerk = await login('apclerk', 'pw');
  const tolByClerk = await inj('PUT', '/api/procurement/match/tolerance', apclerk, { price_pct: 99 });
  ok('PE-5: creditors (AP) cannot set the match tolerance (403); approver-only', tolByClerk.status === 403, `${tolByClerk.status} ${tolByClerk.json.error?.code}`);

  // ── F. override gate (EXP-01 maker-checker: overrider ≠ matcher, binds Admin) ──
  // the match was RUN by admin → admin cannot also override it.
  const ovrSelf = await inj('POST', `/api/procurement/match/${ap2}/override`, admin, { reason: 'self-override attempt' });
  ok('EXP-01: matcher cannot override their own 3-way match → 403 SOD_VIOLATION (binds even Admin)', ovrSelf.status === 403 && ovrSelf.json.error?.code === 'SOD_VIOLATION', `${ovrSelf.status} ${ovrSelf.json.error?.code}`);
  const ovr = await inj('POST', `/api/procurement/match/${ap2}/override`, apprv, { reason: 'manager approved variance' });
  const pay2b = await payFull(ap2, 1200);
  const gl2 = await payGl(ap2);
  ok('Override unblocks: independent override→request+approve → bill Paid + PAY-AP GL posted', ovr.json.override === true && ovr.json.override_by !== 'admin' && pay2b.json.bill_status === 'Paid' && near(leg(gl2, '2000', 'debit'), 1200), JSON.stringify({ ovr: ovr.json.override, pay: pay2b.json.bill_status }));

  // ── G. RFQ → award → PO ──
  const rfq = await inj('POST', '/api/procurement/rfqs', admin, { items: [{ item_id: 'X', qty: 50 }] });
  const rfqNo = rfq.json.rfq_no as string;
  // Printable ใบขอเสนอราคา (RFQ) + generic email path wired.
  const rfqPdf = await inj('GET', `/api/procurement/rfqs/${rfqNo}/pdf`, admin);
  ok('RFQ print: PDF/HTML contains "ใบขอเสนอราคา" + item (X)', rfqPdf.status === 200 && rfqPdf.text.includes('ใบขอเสนอราคา') && rfqPdf.text.includes('X'), `${rfqPdf.status} ${String(rfqPdf.text).slice(0, 50)}`);
  const rfqEmail = await inj('POST', `/api/procurement/rfqs/${rfqNo}/send-email`, admin, { to_email: 'supplier@example.com' });
  ok('RFQ email path wired → EMAIL_NOT_CONFIGURED (503) with no SMTP in CI', rfqEmail.status === 503 && rfqEmail.json.error?.code === 'EMAIL_NOT_CONFIGURED', `${rfqEmail.status} ${rfqEmail.json.error?.code}`);
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

  // ── H2. vendor bank-detail maker-checker (0270) — closes a BEC/vendor-payment-fraud gap: md_vendor
  // stages a payee bank-detail change, a DISTINCT exec/approvals user must release it before it lands on
  // `vendors` (mirrors the G15 tenant PromptPay/tax-id pattern). ──
  const stage1 = await inj('PATCH', `/api/procurement/vendors/${V1}/bank`, admin, { bank_name: 'ธนาคารกรุงเทพ', bank_account: '111-1-11111-1' });
  ok('VBC: stage bank change → PendingApproval + req_no', stage1.json.status === 'PendingApproval' && /^VBC-/.test(stage1.json.req_no ?? ''), JSON.stringify(stage1.json));
  const pend1 = await inj('GET', '/api/procurement/vendor-bank-changes', admin);
  ok('VBC: pending list shows the staged request for V1', (pend1.json.pending ?? []).some((p: any) => p.req_no === stage1.json.req_no && p.vendor_id === V1), JSON.stringify(pend1.json).slice(0, 150));
  const selfApproveVbc = await inj('POST', `/api/procurement/vendor-bank-changes/${stage1.json.req_no}/approve`, admin);
  ok('VBC: requester cannot approve own bank-change request → 403 SOD_VIOLATION', selfApproveVbc.status === 403 && selfApproveVbc.json.error?.code === 'SOD_VIOLATION', `${selfApproveVbc.status} ${selfApproveVbc.json.error?.code}`);
  const approveVbc = await inj('POST', `/api/procurement/vendor-bank-changes/${stage1.json.req_no}/approve`, vbcApprover);
  // bank_account is encrypted-at-rest (ITGC-AC-19) — decrypts only through the Drizzle ORM layer, so read it
  // via db.select (not a raw pg.query, which would only see the ciphertext).
  const vendorAfterApprove = (await db.select().from(s.vendors).where(eq(s.vendors.id, V1)))[0];
  ok('VBC: distinct approver releases it → vendors.bank_name/bank_account updated', approveVbc.json.status === 'Approved' && vendorAfterApprove?.bankName === 'ธนาคารกรุงเทพ' && vendorAfterApprove?.bankAccount === '111-1-11111-1', JSON.stringify({ st: approveVbc.json.status, row: { bankName: vendorAfterApprove?.bankName, bankAccount: vendorAfterApprove?.bankAccount } }));

  // Re-staging supersedes any still-open request; the earlier one is marked Superseded, not left dangling.
  const stage2 = await inj('PATCH', `/api/procurement/vendors/${V1}/bank`, admin, { bank_name: 'ธนาคารไทยพาณิชย์', bank_account: '222-2-22222-2' });
  const stage3 = await inj('PATCH', `/api/procurement/vendors/${V1}/bank`, admin, { bank_name: 'ธนาคารกสิกรไทย', bank_account: '333-3-33333-3' });
  const pend2 = await inj('GET', '/api/procurement/vendor-bank-changes', admin);
  const supersededRow = (await pg.query(`SELECT status FROM vendor_bank_change_requests WHERE req_no='${stage2.json.req_no}'`)).rows as any[];
  ok('VBC: re-staging supersedes the earlier still-pending request (only the latest shows as pending)',
    supersededRow[0]?.status === 'Superseded' && (pend2.json.pending ?? []).some((p: any) => p.req_no === stage3.json.req_no) && !(pend2.json.pending ?? []).some((p: any) => p.req_no === stage2.json.req_no),
    JSON.stringify({ superseded: supersededRow[0]?.status, pending: (pend2.json.pending ?? []).map((p: any) => p.req_no) }));

  // Reject leaves vendors untouched.
  const rejectVbc = await inj('POST', `/api/procurement/vendor-bank-changes/${stage3.json.req_no}/reject`, vbcApprover, { reason: 'ไม่สามารถยืนยันตัวตนได้' });
  const vendorAfterReject = (await db.select().from(s.vendors).where(eq(s.vendors.id, V1)))[0];
  ok('VBC: reject → status Rejected, vendors bank details unchanged (still the earlier approved values)',
    rejectVbc.json.status === 'Rejected' && vendorAfterReject?.bankName === 'ธนาคารกรุงเทพ' && vendorAfterReject?.bankAccount === '111-1-11111-1',
    JSON.stringify({ st: rejectVbc.json.status, row: { bankName: vendorAfterReject?.bankName, bankAccount: vendorAfterReject?.bankAccount } }));

  // ── H3. vendor master direct-edit (master-data audit Phase 2) — contact/address/rating/category/
  // currency/notes save immediately (no maker-checker; these carry no payment-redirection risk).
  // tax_id/credit_limit/bank details AND payment_terms (GRC-3) stay out of scope for this endpoint — those
  // sensitive fields route through the master-data change maker-checker (see service-level comment). ──
  const vpUpdate = await inj('PATCH', `/api/procurement/vendors/${V1}/profile`, admin, {
    contact: 'คุณสมชาย', phone: '02-111-2222', email: 'v1@example.com', address: '123 ถนนสุขุมวิท กรุงเทพฯ',
    lead_time_days: 7, rating: 4.5, category: 'Preferred', currency: 'USD', notes: 'ผู้ขายหลักสำหรับวัตถุดิบ X',
  });
  ok('VBC: vendor profile direct-edit saves immediately (no approval step)',
    vpUpdate.status === 200 && vpUpdate.json.vendor_id === V1, JSON.stringify(vpUpdate.json).slice(0, 150));
  const vendorAfterProfile = (await db.select().from(s.vendors).where(eq(s.vendors.id, V1)))[0];
  ok('VBC: vendor profile fields persisted (contact/phone/email/address/lead_time/rating/category/currency/notes)',
    vendorAfterProfile?.contact === 'คุณสมชาย' && vendorAfterProfile?.phone === '02-111-2222' && vendorAfterProfile?.email === 'v1@example.com'
      && vendorAfterProfile?.address === '123 ถนนสุขุมวิท กรุงเทพฯ' && vendorAfterProfile?.leadTimeDays === 7
      && near(vendorAfterProfile?.rating, 4.5) && vendorAfterProfile?.category === 'Preferred' && vendorAfterProfile?.currency === 'USD' && vendorAfterProfile?.notes === 'ผู้ขายหลักสำหรับวัตถุดิบ X',
    JSON.stringify({ contact: vendorAfterProfile?.contact, rating: vendorAfterProfile?.rating, cur: vendorAfterProfile?.currency }));
  const vpEmpty = await inj('PATCH', `/api/procurement/vendors/${V1}/profile`, admin, {});
  ok('VBC: vendor profile PATCH with no fields → 400 NO_FIELDS', vpEmpty.status === 400 && vpEmpty.json.error?.code === 'NO_FIELDS', `${vpEmpty.status} ${vpEmpty.json.error?.code}`);
  // The suppliers list projection (GET /api/inventory/suppliers) now also surfaces these fields for the web UI.
  const suppliersList = (await inj('GET', '/api/inventory/suppliers', admin)).json;
  const v1Row = (suppliersList.suppliers ?? []).find((r: any) => r.Vendor_ID === V1);
  ok('VBC: /api/inventory/suppliers projects the vendor-master fields (Email/Address/Rating/Category/Currency/Approval_Status)',
    v1Row?.Email === 'v1@example.com' && v1Row?.Currency === 'USD' && near(v1Row?.Rating, 4.5) && v1Row?.Approval_Status === 'approved' && v1Row?.Blocklisted === false,
    JSON.stringify(v1Row).slice(0, 200));

  // ── H4. Party-model depth (master-data audit Phase 4) — vendors previously carried exactly one scalar
  // address and no contact rows; now multi-address/multi-contact + a self-referencing parent-vendor pointer
  // for consolidated group spend/reporting. Direct-edit, no maker-checker (no payment-redirection risk). ──
  const vAddr1 = await inj('POST', `/api/procurement/vendors/${V1}/addresses`, admin, { address_type: 'registered', address_line1: '1 ถนนพหลโยธิน', is_primary: true });
  ok('Vendor address: add registered address as primary', vAddr1.status === 201 || vAddr1.status === 200, `${vAddr1.status} ${JSON.stringify(vAddr1.json).slice(0, 150)}`);
  const vAddr2 = await inj('POST', `/api/procurement/vendors/${V1}/addresses`, admin, { address_type: 'shipping', address_line1: '2 ถนนวิภาวดี', is_primary: true });
  const vAddrList = await inj('GET', `/api/procurement/vendors/${V1}/addresses`, admin);
  ok('Vendor address: list returns both, only the newest primary', vAddrList.json.addresses?.length === 2 && vAddrList.json.addresses.filter((a: any) => a.is_primary).length === 1 && vAddrList.json.addresses.find((a: any) => a.is_primary)?.address_type === 'shipping', JSON.stringify(vAddrList.json.addresses));
  const vAddrDel = await inj('DELETE', `/api/procurement/vendors/${V1}/addresses/${vAddr1.json.id}`, admin);
  ok('Vendor address: delete the non-primary address', vAddrDel.status === 200 && vAddrDel.json.deleted === true, `${vAddrDel.status}`);
  const vAddrDelMissing = await inj('DELETE', `/api/procurement/vendors/${V1}/addresses/999999`, admin);
  ok('Vendor address: delete non-existent → 404 ADDRESS_NOT_FOUND', vAddrDelMissing.status === 404 && vAddrDelMissing.json.error?.code === 'ADDRESS_NOT_FOUND', `${vAddrDelMissing.status} ${vAddrDelMissing.json.error?.code}`);

  const vContact1 = await inj('POST', `/api/procurement/vendors/${V1}/contacts`, admin, { name: 'คุณวิชัย', title: 'Sales Manager', phone: '089-000-0000', is_primary: true });
  ok('Vendor contact: add primary contact', vContact1.status === 201 || vContact1.status === 200, `${vContact1.status} ${JSON.stringify(vContact1.json).slice(0, 150)}`);
  const vContactList = await inj('GET', `/api/procurement/vendors/${V1}/contacts`, admin);
  ok('Vendor contact: list returns the added contact', vContactList.json.contacts?.length === 1 && vContactList.json.contacts[0].name === 'คุณวิชัย', JSON.stringify(vContactList.json.contacts));
  const vContactDelMissing = await inj('DELETE', `/api/procurement/vendors/${V1}/contacts/999999`, admin);
  ok('Vendor contact: delete non-existent → 404 CONTACT_NOT_FOUND', vContactDelMissing.status === 404 && vContactDelMissing.json.error?.code === 'CONTACT_NOT_FOUND', `${vContactDelMissing.status} ${vContactDelMissing.json.error?.code}`);

  const vParentSelf = await inj('PATCH', `/api/procurement/vendors/${V1}/parent`, admin, { parent_vendor_id: V1 });
  ok('Vendor parent: cannot be its own parent → 400 SELF_PARENT', vParentSelf.status === 400 && vParentSelf.json.error?.code === 'SELF_PARENT', `${vParentSelf.status} ${vParentSelf.json.error?.code}`);
  const vParentSet = await inj('PATCH', `/api/procurement/vendors/${V1}/parent`, admin, { parent_vendor_id: VA });
  ok('Vendor parent: link to parent vendor', vParentSet.status === 200 && vParentSet.json.parent_vendor_id === VA, JSON.stringify(vParentSet.json).slice(0, 150));
  const vParentRow = (await pg.query(`SELECT parent_vendor_id FROM vendors WHERE id=${V1}`)).rows as any[];
  ok('Vendor parent: persisted on vendors.parent_vendor_id', Number(vParentRow[0]?.parent_vendor_id) === VA, JSON.stringify(vParentRow[0]));

  // ── H5. Match-merge / DQM (master-data audit Phase 5) — detect + merge duplicate vendors. ──
  await inj('POST', `/api/procurement/vendors/${VD2}/addresses`, admin, { address_type: 'billing', address_line1: '9 อาคารเอบีซี', is_primary: true });
  const vDupScan = await inj('GET', '/api/procurement/vendors/duplicates', admin);
  const vGrp = (vDupScan.json.groups ?? []).find((g: any) => [g.primary.vendor_id, ...g.duplicates.map((d: any) => d.vendor_id)].includes(VD1) && [g.primary.vendor_id, ...g.duplicates.map((d: any) => d.vendor_id)].includes(VD2));
  ok('Vendor dedup: detects the near-duplicate pair (shared phone + similar name)', !!vGrp && vGrp.duplicates.some((d: any) => d.reasons.includes('phone') && d.reasons.includes('name')), JSON.stringify(vGrp?.duplicates?.map((d: any) => ({ id: d.vendor_id, reasons: d.reasons, score: d.score }))));
  const vSelfMerge = await inj('POST', `/api/procurement/vendors/${VD1}/merge`, admin, { duplicate_vendor_id: VD1 });
  ok('Vendor merge: cannot merge into itself → 400 SELF_MERGE', vSelfMerge.status === 400 && vSelfMerge.json.error?.code === 'SELF_MERGE', `${vSelfMerge.status} ${vSelfMerge.json.error?.code}`);
  const vMerge = await inj('POST', `/api/procurement/vendors/${VD1}/merge`, admin, { duplicate_vendor_id: VD2 });
  ok('Vendor merge: merges duplicate into survivor', (vMerge.status === 200 || vMerge.status === 201) && vMerge.json.merged === true, `${vMerge.status} ${JSON.stringify(vMerge.json).slice(0, 120)}`);
  const vd2Row = (await pg.query(`SELECT active, merged_into, merged_by FROM vendors WHERE id=${VD2}`)).rows as any[];
  ok('Vendor merge: duplicate soft-retired (active=false, merged_into set, record preserved)', vd2Row[0]?.active === false && Number(vd2Row[0]?.merged_into) === VD1, JSON.stringify(vd2Row[0]));
  const vd1Addrs = await inj('GET', `/api/procurement/vendors/${VD1}/addresses`, admin);
  ok('Vendor merge: duplicate child rows repointed onto the survivor (address)', (vd1Addrs.json.addresses?.length ?? 0) >= 1, `addr=${vd1Addrs.json.addresses?.length}`);
  const vd1Row = (await db.select().from(s.vendors).where(eq(s.vendors.id, VD1)))[0];
  ok('Vendor merge: survivorship fills the survivor email from the duplicate', vd1Row?.email === 'abc@trade.co.th', `email=${vd1Row?.email}`);
  const vReMerge = await inj('POST', `/api/procurement/vendors/${VD1}/merge`, admin, { duplicate_vendor_id: VD2 });
  ok('Vendor merge: re-merging an already-merged duplicate → 400 ALREADY_MERGED', vReMerge.status === 400 && vReMerge.json.error?.code === 'ALREADY_MERGED', `${vReMerge.status} ${vReMerge.json.error?.code}`);

  // ── H6. Change history / universal audit (master-data audit Phase 6) — the DB trigger (0274) captures
  // every create/update on the vendor master into the append-only field-level change log (ITGC-AC-14).
  // (VD1 is a tenant-owned vendor; a tenant steward sees their own tenant's trail — shared NULL-tenant
  // master rows are HQ-scoped, consistent with the audit-viewer's tenant filter.) ──
  // GRC-3: payment_terms is now a maker-checked sensitive field (routes through /api/masterdata/change-requests,
  // MDM-01) — only the low-risk category is edited directly here.
  await inj('PATCH', `/api/procurement/vendors/${VD1}/profile`, admin, { category: 'Strategic' });
  const vHist = await inj('GET', `/api/procurement/vendors/${VD1}/history`, admin);
  const vUpd = (vHist.json.history ?? []).find((e: any) => e.action === 'updated' && e.changes.some((c: any) => c.field === 'category' && c.new === 'Strategic'));
  ok('Vendor history: records the field-level profile update (category → Strategic) with old→new + actor', !!vUpd && vUpd.actor === 'admin', JSON.stringify(vUpd?.changes?.filter((c: any) => ['category'].includes(c.field))));

  // ── H7. Thai address standardization (master-data audit Phase 7) — province canonicalised, postal validated. ──
  const vAddrNorm = await inj('POST', `/api/procurement/vendors/${VD1}/addresses`, admin, { address_type: 'registered', province: 'เชียงใหม่ ', postal_code: '50000' });
  ok('Vendor address: province "เชียงใหม่ " (trailing space) canonicalised to "เชียงใหม่"', (vAddrNorm.status === 201 || vAddrNorm.status === 200) && vAddrNorm.json.province === 'เชียงใหม่', `province=${vAddrNorm.json.province}`);
  const vBadPostal = await inj('POST', `/api/procurement/vendors/${VD1}/addresses`, admin, { address_type: 'other', postal_code: '5000' });
  ok('Vendor address: a non-5-digit postal code → 400 POSTAL_INVALID', vBadPostal.status === 400 && vBadPostal.json.error?.code === 'POSTAL_INVALID', `${vBadPostal.status} ${vBadPostal.json.error?.code}`);

  // ── H8. Typed party relationships (master-data audit Phase 8) — subsidiary/related-party/subcontractor. ──
  const vRelSelf = await inj('POST', `/api/procurement/vendors/${VD1}/relationships`, admin, { to_vendor_id: VD1, rel_type: 'related_party' });
  ok('Vendor relationship: cannot relate to itself → 400 SELF_RELATION', vRelSelf.status === 400 && vRelSelf.json.error?.code === 'SELF_RELATION', `${vRelSelf.status} ${vRelSelf.json.error?.code}`);
  const vRelAdd = await inj('POST', `/api/procurement/vendors/${VD1}/relationships`, admin, { to_vendor_id: VA, rel_type: 'subcontractor', note: 'ผู้รับเหมาช่วง' });
  ok('Vendor relationship: add a typed relationship (subcontractor)', (vRelAdd.status === 201 || vRelAdd.status === 200) && vRelAdd.json.rel_type === 'subcontractor' && vRelAdd.json.party?.vendor_id === VA, JSON.stringify(vRelAdd.json).slice(0, 140));
  const vRelDup = await inj('POST', `/api/procurement/vendors/${VD1}/relationships`, admin, { to_vendor_id: VA, rel_type: 'subcontractor' });
  ok('Vendor relationship: duplicate → 409 RELATION_EXISTS', vRelDup.status === 409 && vRelDup.json.error?.code === 'RELATION_EXISTS', `${vRelDup.status} ${vRelDup.json.error?.code}`);
  const vRelListVA = await inj('GET', `/api/procurement/vendors/${VA}/relationships`, admin);
  ok('Vendor relationship: the target vendor sees it as INCOMING', (vRelListVA.json.relationships ?? []).some((r: any) => r.direction === 'incoming' && r.rel_type === 'subcontractor' && r.party.vendor_id === VD1), JSON.stringify(vRelListVA.json.relationships));
  const vRelDel = await inj('DELETE', `/api/procurement/vendors/${VD1}/relationships/${vRelAdd.json.id}`, admin);
  ok('Vendor relationship: delete removes it', vRelDel.status === 200 && vRelDel.json.deleted === true, `${vRelDel.status}`);

  // ── H9. Governed bank master (master-data audit Phase 9) — a recognised bank name is canonicalised when
  // a bank-detail change is staged (through the maker-checker). ──
  const bankStage = await inj('PATCH', `/api/procurement/vendors/${VD1}/bank`, admin, { bank_name: 'kbank', bank_account: '123-4-56789-0' });
  const bankPending = await inj('GET', '/api/procurement/vendor-bank-changes', admin);
  const bankReq = (bankPending.json.pending ?? []).find((p: any) => p.req_no === bankStage.json.req_no);
  ok('Governed bank master: staging "kbank" canonicalises the bank name to "ธนาคารกสิกรไทย"', bankReq?.bank_name === 'ธนาคารกสิกรไทย', JSON.stringify({ staged: bankStage.json.status, name: bankReq?.bank_name }));

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
  const scReg = await inj('GET', '/api/procurement/scorecards', admin);
  ok('Supplier scorecard register: ranks vendors by score (V1 present, avg + underperformers)', (scReg.json.scorecards ?? []).some((sr: any) => sr.vendor_id === V1 && sr.score === sc.json.score) && scReg.json.count >= 1 && scReg.json.avg_score >= 0 && typeof scReg.json.underperformers === 'number', `n=${scReg.json.count} avg=${scReg.json.avg_score} under=${scReg.json.underperformers}`);

  // ── J2. scorecard on-time + quality are COMPUTED from receipt/claim history (previously hard-coded 100).
  //     Isolated on a dedicated vendor: one receipt 22 days LATE vs its PO's expected_date → on_time 0%,
  //     and a 20-of-100 goods-receipt claim → quality 80%. Seeded via raw db (RLS-bypassing superuser). ──
  const [vsc] = await db.insert(s.vendors).values({ name: 'ผู้ขาย SC', isSupplier: true, approvalStatus: 'approved', blocklisted: false }).returning({ id: s.vendors.id });
  const VSC = Number(vsc.id);
  await db.insert(s.purchaseOrders).values({ poNo: 'PO-SC-1', poDate: '2020-01-01', vendorId: VSC, status: 'Approved', expectedDate: '2020-01-10', tenantId: hq });
  const [grSc] = await db.insert(s.goodsReceipts).values({ grNo: 'GR-SC-1', grDate: '2020-02-01', poNo: 'PO-SC-1', vendorId: VSC, tenantId: hq }).returning({ id: s.goodsReceipts.id });
  await db.insert(s.grItems).values({ grId: Number(grSc.id), poNo: 'PO-SC-1', itemId: 'X', receivedQty: '100', uom: 'EA', tenantId: hq });
  await db.insert(s.grClaims).values({ claimNo: 'GRC-SC-1', claimDate: '2020-02-02', grNo: 'GR-SC-1', poNo: 'PO-SC-1', vendorId: VSC, itemId: 'X', grQty: '100', claimQty: '20', uom: 'EA', status: 'Open' });
  const scReal = await inj('POST', `/api/procurement/suppliers/${VSC}/scorecard`, admin, { period: '2020-02' });
  ok('Supplier scorecard: LATE delivery → on_time_pct = 0 (computed, not hard-coded 100)', scReal.json.on_time_pct === 0, JSON.stringify(scReal.json));
  ok('Supplier scorecard: GR claim 20/100 → quality_pct = 80 + claim_count = 1', near(scReal.json.quality_pct, 80) && scReal.json.claim_count === 1, JSON.stringify(scReal.json));

  // ── K. non-PO bill (no match) is payable — gate fails OPEN, only PO-based matched invoices are gated ──
  const nonPo = await apTxn(500);
  const payNonPo = await payFull(nonPo, 500);
  ok('Non-PO bill (no match row) request+approve → bill Paid (gate fails open)', payNonPo.json.bill_status === 'Paid', `${payNonPo.status} ${payNonPo.json.bill_status}`);

  // ── L. override does NOT survive a re-match (stale override must not keep a failing invoice payable) ──
  const ap5 = await apTxn(1200);
  await runMatch(ap5, poNo, [{ item_id: 'X', qty: 100, unit_price: 12 }]); // price_variance
  await inj('POST', `/api/procurement/match/${ap5}/override`, apprv, { reason: 'one-time' }); // independent overrider (≠ matcher)
  await runMatch(ap5, poNo, [{ item_id: 'X', qty: 100, unit_price: 12 }]); // re-match → must RESET override
  const pay5 = await payAttempt(ap5, 1200);
  ok('Override cleared by re-match → still-failing invoice BLOCKED again (409)', pay5.status === 409 && pay5.json.error?.code === 'MATCH_BLOCKED', `${pay5.status} ${pay5.json.error?.code}`);

  // ── M. multi-tenant vendor isolation (vendors gap fix — adversarial-verify follow-up) ──
  // (a) cross-tenant MUTATION blocked: T1 tries to blocklist T2's vendor → 404, and the row is untouched.
  const crossMut = await inj('PATCH', `/api/procurement/suppliers/${VB}/status`, procT1, { blocklisted: true, reason: 'sabotage' });
  const vbAfter = (await pg.query(`SELECT blocklisted FROM vendors WHERE id=${VB}`)).rows as any[];
  ok('Tenant A cannot mutate tenant B vendor (404, row untouched)', crossMut.status === 404 && !truthy(vbAfter[0]?.blocklisted), `st=${crossMut.status} blk=${vbAfter[0]?.blocklisted}`);

  // (b) DoS closed: T2 blocklists its OWN vendor → ok; T1's createPo for ITS OWN vendor still succeeds.
  const ownBlock = await inj('PATCH', `/api/procurement/suppliers/${VB}/status`, procT2, { blocklisted: true, reason: 'คุณภาพต่ำ' });
  const vbOwn = (await pg.query(`SELECT blocklisted FROM vendors WHERE id=${VB}`)).rows as any[];
  const t1Po = await inj('POST', '/api/procurement/pos', procT1, { vendor_id: VA, items: [{ item_id: 'X', order_qty: 3, unit_price: 10 }] });
  ok("Tenant B blocklists own vendor → ok; tenant A's PO for its own vendor still succeeds (no cross-tenant DoS)",
    ownBlock.status === 200 && truthy(vbOwn[0]?.blocklisted) && (t1Po.status === 200 || t1Po.status === 201) && /^PO-/.test(t1Po.json.po_no ?? ''),
    `block=${ownBlock.status} blk=${vbOwn[0]?.blocklisted} po=${t1Po.status}`);

  // (c) cross-tenant VISIBILITY blocked: an RLS-scoped read as T1 cannot see T2's vendor; the shared (NULL) master still can.
  const t1Sees = await pg.transaction(async (tx: any) => {
    await tx.query('SET LOCAL ROLE app_user');
    await tx.query(`SELECT set_config('app.bypass_rls','off',true)`);
    await tx.query(`SELECT set_config('app.tenant_id',$1,true)`, [String(t1)]);
    const foreign = await tx.query(`SELECT id FROM vendors WHERE id=$1`, [VB]); // T2's vendor → hidden
    const shared = await tx.query(`SELECT id FROM vendors WHERE id=$1`, [V1]);  // legacy shared → visible
    return { foreign: foreign.rows.length, shared: shared.rows.length };
  });
  ok('RLS: tenant A cannot SEE tenant B vendor, but the shared (NULL) master stays visible', t1Sees.foreign === 0 && t1Sees.shared === 1, JSON.stringify(t1Sees));

  // ── N. AR/AP idempotency (W3): a retried request with the same key must not double-post ──
  const countEntries = async (source: string, refLike: string) => Number((await pg.query(`SELECT count(*)::int n FROM journal_entries WHERE source='${source}' AND source_ref LIKE '${refLike}'`)).rows[0].n);
  // (a) AP bill dedup (M3): same idempotency_key → one bill, one AP GL entry
  const bill1 = await inj('POST', '/api/finance/ap/transactions', admin, { vendor_id: V1, txn_type: 'Goods', amount: 500, idempotency_key: 'bill-k1' });
  const bill2 = await inj('POST', '/api/finance/ap/transactions', admin, { vendor_id: V1, txn_type: 'Goods', amount: 500, idempotency_key: 'bill-k1' });
  const billRows = Number((await pg.query(`SELECT count(*)::int n FROM ap_transactions WHERE idempotency_key='bill-k1'`)).rows[0].n);
  ok('AP bill idempotent: same key → same txn_no, 1 row, 1 AP GL entry', bill1.json.txn_no === bill2.json.txn_no && bill2.json.idempotent === true && billRows === 1 && (await countEntries('AP', bill1.json.txn_no)) === 1, JSON.stringify({ t1: bill1.json.txn_no, t2: bill2.json.txn_no, rows: billRows }));
  // (b) AP payment-REQUEST idempotency (H2): a retried request with the same key → ONE pending request;
  //     approving it once disburses 800 with exactly one PAY-AP GL entry (no double cash-out).
  const payIdem = await apTxn(800);
  const p1 = await inj('PATCH', `/api/finance/ap/transactions/${payIdem}/pay`, admin, { amount: 800, idempotency_key: 'pay-k1' });
  const p2 = await inj('PATCH', `/api/finance/ap/transactions/${payIdem}/pay`, admin, { amount: 800, idempotency_key: 'pay-k1' });
  const reqRows = Number((await pg.query(`SELECT count(*)::int n FROM ap_payments WHERE idempotency_key='pay-k1'`)).rows[0].n);
  const apprIdem = await inj('POST', `/api/finance/ap/payments/${p1.json.payment_no}/approve`, apprv);
  ok('AP payment-request idempotent + approved once: same key → 1 pending request, paid 800, 1 PAY-AP entry', p1.json.payment_no === p2.json.payment_no && p2.json.idempotent === true && reqRows === 1 && near(apprIdem.json.paid_amount, 800) && (await countEntries('PAY-AP', `${payIdem}:p:%`)) === 1, JSON.stringify({ pn1: p1.json.payment_no, pn2: p2.json.payment_no, rows: reqRows, paid: apprIdem.json.paid_amount }));
  // (c) AR receipt idempotency (H1): same key → cash collected once, one RCP GL entry
  await db.insert(s.arInvoices).values({ invoiceNo: 'INV-IDEM-1', tenantId: hq, amount: '500', paidAmount: '0', status: 'Unpaid' }).onConflictDoNothing();
  const rc1 = await inj('POST', '/api/finance/ar/receipts', admin, { invoice_no: 'INV-IDEM-1', amount: 500, idempotency_key: 'rcp-k1' });
  const rc2 = await inj('POST', '/api/finance/ar/receipts', admin, { invoice_no: 'INV-IDEM-1', amount: 500, idempotency_key: 'rcp-k1' });
  const invPaid = Number((await pg.query(`SELECT paid_amount FROM ar_invoices WHERE invoice_no='INV-IDEM-1'`)).rows[0].paid_amount);
  ok('AR receipt idempotent: retried key → collected once (paid 500), same receipt, 1 RCP entry', rc1.json.receipt_no === rc2.json.receipt_no && rc2.json.idempotent === true && near(invPaid, 500) && (await countEntries('RCP', rc1.json.receipt_no)) === 1, JSON.stringify({ r1: rc1.json.receipt_no, r2: rc2.json.receipt_no, paid: invPaid }));

  // ── O. match-results worklist (register) — all results, blocked filter, tenant isolation ──
  const wl = await inj('GET', '/api/procurement/match', admin);
  ok('Match worklist: lists all results + blocked/overridden counts', (wl.json.results ?? []).length >= 4 && wl.json.total >= 4 && wl.json.blocked >= 1 && wl.json.overridden >= 1, `n=${wl.json.count} total=${wl.json.total} blocked=${wl.json.blocked} ovr=${wl.json.overridden}`);
  const wlBlocked = await inj('GET', '/api/procurement/match?blocked=true', admin);
  ok('Match worklist: ?blocked=true → only held invoices (not payable, not overridden)', (wlBlocked.json.results ?? []).length >= 1 && (wlBlocked.json.results ?? []).every((r: any) => !truthy(r.payable) && !truthy(r.override)), `n=${wlBlocked.json.count}`);
  const wlT2 = await inj('GET', '/api/procurement/match', procT2);
  ok('Match worklist: RLS — tenant T2 sees none of HQ match results', (wlT2.json.results ?? []).length === 0 && wlT2.json.total === 0, `n=${wlT2.json.count}`);

  // ── P. AP invoice intake (EXP-10): scan → extract → PO auto-map → post bill → automated 3-way match ──
  // (a) explicit PO number in the scan → one-shot auto: mapped(po_number) + bill posted + header match.
  const poI = await inj('POST', '/api/procurement/pos', admin, { vendor_id: V1, items: [{ item_id: 'X', order_qty: 40, unit_price: 25 }] });
  const poINo = poI.json.po_no as string;
  await inj('PATCH', `/api/procurement/pos/${poINo}/approve`, admin, { approve: true });
  await inj('POST', '/api/procurement/grs', admin, { po_no: poINo, items: [{ item_id: 'X', received_qty: 40 }] });
  const scanA = `ผู้ขาย V1 จำกัด\nInvoice# IV-9001\n2026-07-01\nPO Number: ${poINo}\nรวมทั้งสิ้น 1,000.00`;
  const auto1 = await inj('POST', '/api/procurement/ap-intake/auto', admin, { text: scanA });
  ok('Intake auto: PO no. in scan → mapped(po_number 100%) + bill posted + header match=matched, payable',
    auto1.json.po_no === poINo && auto1.json.map_method === 'po_number' && auto1.json.status === 'Posted' && auto1.json.match_status === 'matched' && truthy(auto1.json.payable) && auto1.json.invoice_no === 'IV-9001' && near(auto1.json.amount, 1000),
    JSON.stringify({ po: auto1.json.po_no, m: auto1.json.map_method, st: auto1.json.status, match: auto1.json.match_status }));
  const payAuto = await payFull(auto1.json.txn_no, 1000);
  ok('Intake-posted matched bill passes the pay gate → request+approve → Paid', payAuto.json.bill_status === 'Paid', `${payAuto.status} ${payAuto.json.bill_status}`);

  // (b) no PO number in the scan → auto-map by vendor + amount (unambiguous winner) → post → matched.
  const poB = await inj('POST', '/api/procurement/pos', admin, { vendor_id: V1, items: [{ item_id: 'X', order_qty: 30, unit_price: 20 }] });
  const poBNo = poB.json.po_no as string;
  await inj('PATCH', `/api/procurement/pos/${poBNo}/approve`, admin, { approve: true });
  await inj('POST', '/api/procurement/grs', admin, { po_no: poBNo, items: [{ item_id: 'X', received_qty: 30 }] });
  const scanB = `ผู้ขาย V1 จำกัด\nInvoice# IV-9002\n2026-07-01\nรวมทั้งสิ้น 600.00`;
  const intB = await inj('POST', '/api/procurement/ap-intake', admin, { text: scanB });
  ok('Intake map: vendor + amount (no PO no. in scan) → auto-mapped vendor_amount to the 600-baht PO',
    intB.json.status === 'Mapped' && intB.json.po_no === poBNo && intB.json.map_method === 'vendor_amount',
    JSON.stringify({ st: intB.json.status, po: intB.json.po_no, m: intB.json.map_method, cands: (intB.json.candidates ?? []).length }));
  const postB = await inj('POST', `/api/procurement/ap-intake/${intB.json.intake_no}/post`, admin, {});
  ok('Intake post: books the bill + auto-runs the match → matched, payable', postB.json.status === 'Posted' && postB.json.match_status === 'matched' && truthy(postB.json.payable), JSON.stringify({ st: postB.json.status, match: postB.json.match_status }));

  // (c) ambiguous candidates → NeedsReview (never guess); manual map; cumulative guard: the mapped PO's
  // received value is already fully invoiced by (a) → a second invoice on it is over_invoiced + blocked.
  const scanC = `ผู้ขาย V1 จำกัด\nInvoice# IV-9003\n2026-07-01\nรวมทั้งสิ้น 1,000.00`;
  const intC = await inj('POST', '/api/procurement/ap-intake', admin, { text: scanC });
  ok('Intake ambiguity: two 1,000-baht POs for the vendor → NeedsReview with scored candidates (no auto-map)',
    intC.json.status === 'NeedsReview' && intC.json.po_no == null && (intC.json.candidates ?? []).length >= 2,
    JSON.stringify({ st: intC.json.status, cands: (intC.json.candidates ?? []).map((c: any) => c.po_no) }));
  await inj('PUT', `/api/procurement/ap-intake/${intC.json.intake_no}/map`, admin, { po_no: poINo });
  const postC = await inj('POST', `/api/procurement/ap-intake/${intC.json.intake_no}/post`, admin, {});
  const payC = await payAttempt(postC.json.txn_no, 1000);
  ok('Cumulative guard: 2nd invoice on an already-fully-invoiced PO → over_invoiced, pay BLOCKED 409',
    postC.json.match_status === 'over_invoiced' && !truthy(postC.json.payable) && payC.status === 409 && payC.json.error?.code === 'MATCH_BLOCKED',
    JSON.stringify({ match: postC.json.match_status, pay: payC.status }));

  // (d) duplicate-invoice guard: the same vendor invoice number scanned twice never books twice.
  const dupAuto = await inj('POST', '/api/procurement/ap-intake/auto', admin, { text: scanA });
  const dupPost = await inj('POST', `/api/procurement/ap-intake/${dupAuto.json.intake_no}/post`, admin, {});
  ok('Duplicate guard: re-scan of IV-9001 → NeedsReview (not auto-posted) and explicit post → 409 DUPLICATE_INVOICE',
    dupAuto.json.auto_posted === false && dupAuto.json.status === 'NeedsReview' && dupAuto.json.dup_of != null && dupPost.status === 409 && dupPost.json.error?.code === 'DUPLICATE_INVOICE',
    JSON.stringify({ st: dupAuto.json.status, dup: dupAuto.json.dup_of, post: dupPost.status }));

  // (e) invoice arrives BEFORE the goods → blocked; the scheduled auto re-match releases it once the GR posts.
  const poE = await inj('POST', '/api/procurement/pos', admin, { vendor_id: V1, items: [{ item_id: 'X', order_qty: 20, unit_price: 50 }] });
  const poENo = poE.json.po_no as string;
  await inj('PATCH', `/api/procurement/pos/${poENo}/approve`, admin, { approve: true });
  await inj('POST', '/api/procurement/grs', admin, { po_no: poENo, items: [{ item_id: 'X', received_qty: 10 }] }); // half received
  const scanE = `ผู้ขาย V1 จำกัด\nInvoice# IV-9004\n2026-07-01\nPO Number: ${poENo}\nรวมทั้งสิ้น 1,000.00`;
  const autoE = await inj('POST', '/api/procurement/ap-intake/auto', admin, { text: scanE });
  const payE1 = await payAttempt(autoE.json.txn_no, 1000);
  ok('Invoice ahead of goods: 1,000 invoiced vs 500 received → over_invoiced, pay BLOCKED 409',
    autoE.json.match_status === 'over_invoiced' && payE1.status === 409, JSON.stringify({ match: autoE.json.match_status, pay: payE1.status }));
  await inj('POST', '/api/procurement/grs', admin, { po_no: poENo, items: [{ item_id: 'X', received_qty: 10 }] }); // rest arrives
  const rtI = (await inj('GET', '/api/bi/report-types', admin)).json;
  ok('Auto re-match is a schedulable job type (rides the report scheduler)', (rtI.report_types ?? []).some((t: any) => t.key === 'ap_automatch_rerun'), '');
  await inj('POST', '/api/bi/subscriptions', admin, { name: 'Auto re-match', report_type: 'ap_automatch_rerun', frequency: 'daily' });
  const ranI = (await inj('POST', '/api/bi/subscriptions/run', admin)).json;
  const rerun = (ranI.runs ?? []).find((r: any) => r.report_type === 'ap_automatch_rerun');
  const mE = await inj('GET', `/api/procurement/match/${autoE.json.txn_no}`, admin);
  const payE2 = await payFull(autoE.json.txn_no, 1000);
  ok('Scheduled auto re-match: GR caught up → sweep releases the hold, invoice now matched + payable → Paid',
    rerun?.status === 'success' && /released \d+/i.test(rerun?.summary ?? '') && mE.json.match_status === 'matched' && truthy(mE.json.payable) && payE2.json.bill_status === 'Paid',
    JSON.stringify({ sum: rerun?.summary, match: mE.json.match_status, pay: payE2.json.bill_status }));

  // (f) unmappable document → NeedsReview; posting WITHOUT a PO books a non-PO bill (fail-open, payable).
  const scanF = `ร้านสาธารณูปโภค ไม่มีในระบบ\nInvoice# UTIL-77\n2026-07-01\nรวมทั้งสิ้น 777.00`;
  const intF = await inj('POST', '/api/procurement/ap-intake', admin, { text: scanF });
  const postF = await inj('POST', `/api/procurement/ap-intake/${intF.json.intake_no}/post`, admin, {});
  const payF = await payFull(postF.json.txn_no, 777);
  ok('Unmappable scan → NeedsReview; posted without PO → non-PO bill, no match row, payable (fail-open)',
    intF.json.status === 'NeedsReview' && (intF.json.candidates ?? []).length === 0 && postF.json.match_status == null && truthy(postF.json.payable) && payF.json.bill_status === 'Paid',
    JSON.stringify({ st: intF.json.status, match: postF.json.match_status, pay: payF.json.bill_status }));

  // (g) worklist + RLS: HQ sees the intakes; tenant T2 sees none; idempotent re-post returns the same bill.
  const wlI = await inj('GET', '/api/procurement/ap-intake', admin);
  const wlIT2 = await inj('GET', '/api/procurement/ap-intake', procT2);
  const repost = await inj('POST', `/api/procurement/ap-intake/${intB.json.intake_no}/post`, admin, {});
  ok('Intake worklist: HQ sees all intakes; tenant T2 sees none (RLS); re-post is idempotent (same txn)',
    (wlI.json.intakes ?? []).length >= 6 && (wlIT2.json.intakes ?? []).length === 0 && repost.json.txn_no === postB.json.txn_no,
    JSON.stringify({ hq: wlI.json.count, t2: wlIT2.json.count, same: repost.json.txn_no === postB.json.txn_no }));

  // ── Q. AP intake UPLOAD channel (EXP-10): direct image/PDF → extract → auto-map → matched-at-posting ──
  // A minimal single-page PDF with a real TEXT LAYER (uncompressed content stream) — the deterministic
  // no-API-key path CI relies on. latin1 keeps byte offsets exact.
  const miniPdf = (lines: string[], flate = false) => {
    const content = `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => `${i ? '0 -16 Td ' : ''}(${l.replace(/([\\()])/g, '\\$1')}) Tj `).join('')}ET`;
    const stream = flate ? require('node:zlib').deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1');
    const head = `4 0 obj << ${flate ? '/Filter /FlateDecode ' : ''}/Length ${stream.length} >> stream\n`;
    const parts = [
      Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj\n' + head, 'latin1'),
      stream,
      Buffer.from('\nendstream endobj\n5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF', 'latin1'),
    ];
    return Buffer.concat(parts);
  };
  const pdfDataUrl = (b: Buffer) => `data:application/pdf;base64,${b.toString('base64')}`;

  // (a) PDF with an explicit PO number → upload/auto books + matches in one call; the file is stored.
  const poQ = await inj('POST', '/api/procurement/pos', admin, { vendor_id: V1, items: [{ item_id: 'X', order_qty: 25, unit_price: 40 }] });
  const poQNo = poQ.json.po_no as string;
  await inj('PATCH', `/api/procurement/pos/${poQNo}/approve`, admin, { approve: true });
  await inj('POST', '/api/procurement/grs', admin, { po_no: poQNo, items: [{ item_id: 'X', received_qty: 25 }] });
  const pdfA = miniPdf(['V1 Supplies Co Ltd', 'Invoice# IV-9100', 'Date: 2026-07-01', `PO Number: ${poQNo}`, 'Total 1,000.00']);
  const upA = await inj('POST', '/api/procurement/ap-intake/upload/auto', admin, { file_name: 'inv-9100.pdf', data_url: pdfDataUrl(pdfA) });
  ok('Upload PDF (text layer, no API key): extracted via rules → auto-mapped + posted + matched, file stored',
    upA.json.status === 'Posted' && upA.json.po_no === poQNo && upA.json.match_status === 'matched' && truthy(upA.json.payable) && upA.json.invoice_no === 'IV-9100' && upA.json.extract_source === 'rules' && upA.json.has_file === true,
    JSON.stringify({ st: upA.json.status, po: upA.json.po_no, inv: upA.json.invoice_no, src: upA.json.extract_source }));
  const fileA = await inj('GET', `/api/procurement/ap-intake/${upA.json.intake_no}/file`, admin);
  ok('Stored source document retrievable (inline data: URL fallback — no object store in harness)',
    fileA.json.file_name === 'inv-9100.pdf' && String(fileA.json.data_url ?? '').startsWith('data:application/pdf;base64,') && fileA.json.mime === 'application/pdf',
    JSON.stringify({ name: fileA.json.file_name, mime: fileA.json.mime, inline: !!fileA.json.data_url }));

  // (b) FlateDecode text layer inflates correctly (direct extractor check on dist).
  const { pdfExtractText } = require('../../../apps/api/dist/common/pdf-text');
  const flateText = pdfExtractText(miniPdf(['Invoice# IV-9200', 'Total 555.00'], true));
  ok('PDF text-layer extractor handles FlateDecode streams', /IV-9200/.test(flateText) && /555\.00/.test(flateText), JSON.stringify(flateText).slice(0, 60));

  // (c) image without an API key → honestly EMPTY extraction: NeedsReview with the file kept for a human;
  // posting is refused (no amount) rather than booking a blank bill.
  const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const upC = await inj('POST', '/api/procurement/ap-intake/upload', admin, { file_name: 'photo.png', data_url: png1x1 });
  const postC2 = await inj('POST', `/api/procurement/ap-intake/${upC.json.intake_no}/post`, admin, {});
  ok('Upload image with no AI key → NeedsReview (source none, file stored); post refused INTAKE_AMOUNT_REQUIRED',
    upC.json.status === 'NeedsReview' && upC.json.extract_source === 'none' && upC.json.has_file === true && postC2.status === 400 && postC2.json.error?.code === 'INTAKE_AMOUNT_REQUIRED',
    JSON.stringify({ st: upC.json.status, src: upC.json.extract_source, post: postC2.json.error?.code }));

  // (d) type/size gates: only PNG/JPEG/WebP/PDF, bounded size.
  const upBadType = await inj('POST', '/api/procurement/ap-intake/upload', admin, { file_name: 'x.txt', data_url: `data:text/plain;base64,${Buffer.from('hello').toString('base64')}` });
  const upTooBig = await inj('POST', '/api/procurement/ap-intake/upload', admin, { file_name: 'big.png', data_url: `data:image/png;base64,${'A'.repeat(6_600_000)}` });
  ok('Upload gates: text/plain → 400 UNSUPPORTED_FILE_TYPE; oversized image → 400 FILE_TOO_LARGE',
    upBadType.status === 400 && upBadType.json.error?.code === 'UNSUPPORTED_FILE_TYPE' && upTooBig.status === 400 && upTooBig.json.error?.code === 'FILE_TOO_LARGE',
    JSON.stringify({ type: upBadType.json.error?.code, size: upTooBig.json.error?.code }));

  // (e) Quick Capture lane (docs/34): a pr_raise-only staffer captures a bill (draft only), sees their own
  // submissions via /mine, but CANNOT book it or read the full AP worklist — booking + the queue stay a
  // creditors/procurement duty (SoD/EXP-06: capturer ≠ poster).
  const capUp = await inj('POST', '/api/procurement/ap-intake/capture', capT1, { file_name: 'my-bill.png', data_url: png1x1 });
  const capMine = await inj('GET', '/api/procurement/ap-intake/mine', capT1);
  const capPost = await inj('POST', `/api/procurement/ap-intake/${capUp.json.intake_no}/post`, capT1, {});
  const capFull = await inj('GET', '/api/procurement/ap-intake', capT1);
  ok('Quick Capture: pr_raise staffer files a NeedsReview draft (file stored) + sees it in /mine',
    (capUp.status === 200 || capUp.status === 201) && capUp.json.status === 'NeedsReview' && capUp.json.has_file === true && capUp.json.extract_source === 'none'
      && Array.isArray(capMine.json.intakes) && capMine.json.intakes.some((i: any) => i.intake_no === capUp.json.intake_no),
    JSON.stringify({ st: capUp.json.status, mine: capMine.json.count }));
  ok('Quick Capture SoD: capturer cannot post the bill (403) nor read the full AP worklist (403)',
    capPost.status === 403 && capFull.status === 403,
    JSON.stringify({ post: capPost.status, full: capFull.status }));

  // (f) Vision LINE ITEMS (0432) — scripted LLM client (the ai-eval seam): an image upload extracts
  // normalized lines that are STORED + returned on the intake, and posting still runs the UNCHANGED
  // header-level 3-way match (lines are reviewer detail, never match input). Ordered LAST + restored in
  // a finally: a leaked fake key would flip every keyless `source none` assertion above on a re-order.
  {
    const { setLlmClientForTests } = require('../../../apps/api/dist/common/llm-client');
    const poL = await inj('POST', '/api/procurement/pos', admin, { vendor_id: V1, items: [{ item_id: 'X', order_qty: 10, unit_price: 100 }] });
    const poLNo = poL.json.po_no as string;
    await inj('PATCH', `/api/procurement/pos/${poLNo}/approve`, admin, { approve: true });
    await inj('POST', '/api/procurement/grs', admin, { po_no: poLNo, items: [{ item_id: 'X', received_qty: 10 }] });
    process.env.ANTHROPIC_API_KEY = 'fake-key-harness';
    try {
      setLlmClientForTests({
        async create() {
          return { content: [{ type: 'text', text: '```json\n' + JSON.stringify({
            vendor_name: 'V1 Supplies Co Ltd', vendor_tax_id: null, invoice_no: 'IV-9300',
            invoice_date: '2569-07-01', amount: '1,000.00', currency: 'thb', po_no: poLNo,
            lines: [
              { description: 'Widget X (box)', qty: 6, unit_price: 100, amount: 600 },
              { description: 'Widget X (loose)', qty: '4', unit_price: '100.00', amount: 400 },
            ],
          }) + '\n```' }] };
        },
        stream() { throw new Error('not used'); },
      });
      const upF = await inj('POST', '/api/procurement/ap-intake/upload', admin, { file_name: 'inv-9300.png', data_url: png1x1 });
      ok('Vision upload: normalized lines stored on the intake (ai source, BE date → CE, qty strings → numbers)',
        upF.json.extract_source === 'ai' && upF.json.invoice_date === '2026-07-01' && Array.isArray(upF.json.lines) && upF.json.lines.length === 2
          && upF.json.lines[1].qty === 4 && upF.json.lines[1].unit_price === 100 && upF.json.currency === 'THB',
        JSON.stringify({ src: upF.json.extract_source, d: upF.json.invoice_date, lines: upF.json.lines?.length, q: upF.json.lines?.[1]?.qty }));
      const postF = await inj('POST', `/api/procurement/ap-intake/${upF.json.intake_no}/post`, admin, {});
      ok('Vision lines do NOT perturb the match: posting runs the unchanged header-level 3-way match → matched/payable',
        postF.json.status === 'Posted' && postF.json.match_status === 'matched' && truthy(postF.json.payable) && postF.json.lines?.length === 2,
        JSON.stringify({ st: postF.json.status, m: postF.json.match_status, pay: postF.json.payable }));
    } finally {
      setLlmClientForTests(null);
      delete process.env.ANTHROPIC_API_KEY;
    }
  }

  // (g) Vendor tax-id BLIND INDEX (0433): the mapper looks the 13-digit tax id up via tax_id_bidx first
  // (equality on the HMAC blind index), self-heals the column from the decrypt-and-scan fallback, and
  // re-verifies every index hit against the decrypted value so a STALE index can only miss, never mis-map.
  {
    const { blindIndex } = require('../../../apps/api/dist/database/encrypted-column');
    const TAXID = '0123456789012';
    const [vtx] = await db.insert(s.vendors).values({ name: 'VTX Trading Co', isSupplier: true, approvalStatus: 'approved', blocklisted: false, taxId: TAXID }).returning({ id: s.vendors.id });
    const poT = await inj('POST', '/api/procurement/pos', admin, { vendor_id: Number(vtx.id), items: [{ item_id: 'X', order_qty: 10, unit_price: 100 }] });
    await inj('PATCH', `/api/procurement/pos/${poT.json.po_no}/approve`, admin, { approve: true });

    // First map: no bidx yet → decrypted-scan path resolves the vendor AND self-heals the index.
    const in1 = await inj('POST', '/api/procurement/ap-intake', admin, { text: `VTX Trading Co\nTax ID ${TAXID}\nGrand Total 1,000.00` });
    const [healed] = await db.select({ bidx: s.vendors.taxIdBidx }).from(s.vendors).where(eq(s.vendors.id, vtx.id));
    ok('Tax-id map: scan fallback resolves the vendor + SELF-HEALS tax_id_bidx (= blindIndex(digits))',
      in1.json.map_method === 'vendor_tax_id' && in1.json.po_no === poT.json.po_no && healed.bidx === blindIndex(TAXID),
      JSON.stringify({ method: in1.json.map_method, po: in1.json.po_no, healed: healed.bidx === blindIndex(TAXID) }));

    // Stale-index safety: plant the SAME bidx on a decoy vendor whose real tax id differs — the index
    // hit fails decrypted re-verification, so the mapper still resolves the true vendor.
    const [decoy] = await db.insert(s.vendors).values({ name: 'Decoy Ltd', isSupplier: true, approvalStatus: 'approved', blocklisted: false, taxId: '9999999999999', taxIdBidx: blindIndex(TAXID) }).returning({ id: s.vendors.id });
    const in2 = await inj('POST', '/api/procurement/ap-intake', admin, { text: `VTX Trading Co\nTax ID ${TAXID}\nGrand Total 1,000.00` });
    ok('Tax-id map: a stale/planted blind index can only MISS, never mis-map (decrypted re-verification)',
      in2.json.map_method === 'vendor_tax_id' && in2.json.po_no === poT.json.po_no && in2.json.vendor_name === 'VTX Trading Co',
      JSON.stringify({ method: in2.json.map_method, vendor: in2.json.vendor_name, decoy: Number(decoy.id) }));
  }

  console.log('\n── Phase 16 — Source-to-Pay: 3-way match + RFQ + supplier screening ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} match checks failed` : `\n✅ All ${checks.length} match checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
