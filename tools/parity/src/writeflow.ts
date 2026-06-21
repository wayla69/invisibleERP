/**
 * Phase 3 transactional test — รัน write service จริงของ V2 (จาก dist) บน PGlite,
 * ตรวจผลข้างเคียง: doc-number atomic, loyalty, credit-hold, PR→PO→GR (received_qty/
 * stock_movement/lot_ledger/auto-close), AR receipt, AP pay.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/parity writeflow
 */
import 'reflect-metadata';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import * as s from '../../../apps/api/dist/database/schema/index';
import { DocNumberService } from '../../../apps/api/dist/common/doc-number.service';
import { StatusLogService } from '../../../apps/api/dist/common/status-log.service';
import { PosService } from '../../../apps/api/dist/modules/pos/pos.service';
import { ProcurementService } from '../../../apps/api/dist/modules/procurement/procurement.service';
import { FinanceService } from '../../../apps/api/dist/modules/finance/finance.service';
import { LedgerService } from '../../../apps/api/dist/modules/ledger/ledger.service';
import { TaxService } from '../../../apps/api/dist/modules/tax/tax.service';
import { and } from 'drizzle-orm';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');

const checks: { name: string; ok: boolean; detail?: string }[] = [];
function ok(name: string, cond: boolean, detail = '') { checks.push({ name, ok: cond, detail }); }
async function throws(name: string, fn: () => Promise<any>, code?: string) {
  try { await fn(); ok(name, false, 'did not throw'); }
  catch (e: any) { const c = e?.response?.code ?? e?.code; ok(name, code ? c === code : true, `threw ${c ?? e?.message}`); }
}

const admin = { username: 'admin', role: 'Admin', customerName: 'HQ', permissions: [] as string[] };
const sales = { username: 'sales', role: 'Sales', customerName: 'HQ', permissions: [] as string[] };

async function main() {
  const { PGlite } = require('@electric-sql/pglite');
  const { drizzle } = require('drizzle-orm/pglite');
  const pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });

  // seed
  await db.insert(s.tenants).values([
    { code: 'T1', name: 'Tenant One', creditHold: false, creditLimit: '0', creditTerm: 'Net 30' },
    { code: 'T2', name: 'Tenant Two', creditHold: true, creditLimit: '0' },
  ]);
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: true, pointsPerBaht: '1.0', bahtPerPoint: '0.1' });
  await db.insert(s.vendors).values({ vendorCode: 'V1', name: 'Vendor One', isSupplier: true });
  await db.insert(s.items).values({ itemId: 'X', itemDescription: 'Item X', uom: 'EA', unitPrice: '5' });

  const docNo = new DocNumberService(db);
  const statusLog = new StatusLogService(db);
  const pos = new PosService(db, docNo, statusLog);
  const proc = new ProcurementService(db, docNo, statusLog);
  const ledger = new LedgerService(db, docNo);
  await ledger.seedChartOfAccounts(); // so AR/AP GL postings resolve in trial balance
  const fin = new FinanceService(db, docNo, statusLog, ledger, new TaxService(db));
  // GL helpers
  const jlines = async (source: string, ref: string) => {
    const [je] = await db.select().from(s.journalEntries).where(and(eq(s.journalEntries.source, source), eq(s.journalEntries.sourceRef, ref)));
    if (!je) return [] as any[];
    return db.select().from(s.journalLines).where(eq(s.journalLines.entryId, je.id));
  };
  const leg = (rows: any[], code: string, side: 'debit' | 'credit') => Number(rows.filter((l: any) => l.accountCode === code).reduce((a: number, l: any) => a + Number(l[side]), 0));
  const nearW = (a: any, b: number) => Math.abs(Number(a) - b) < 0.01;

  // ── A. POS create order + loyalty ──
  const ord = await pos.createOrder({ customer_name: 'T1', items: [{ item_id: 'X', order_qty: 2, unit_price: 50 }] }, sales as any);
  ok('POS order_no format SO-YYYYMMDD-HHMM', /^SO-\d{8}-\d{4}$/.test(ord.order_no), ord.order_no);
  ok('POS total = 100', ord.total === 100);
  ok('POS points_earned = 100', ord.points_earned === 100);
  const [lp] = await db.select().from(s.loyaltyPoints).where(eq(s.loyaltyPoints.tenantId, await tid(db, 'T1')));
  ok('loyalty_points balance = 100', Number(lp?.balance) === 100, `balance=${lp?.balance}`);
  const ltxn = await db.select().from(s.loyaltyTxn);
  ok('loyalty_txn 1 row (Earn)', ltxn.length === 1 && ltxn[0].txnType === 'Earn');

  // credit hold
  await throws('POS credit-hold blocks order', () => pos.createOrder({ customer_name: 'T2', items: [{ item_id: 'X', order_qty: 1, unit_price: 10 }] }, sales as any), 'CREDIT_HOLD');

  // ── B. order status update + est rule ──
  const up1 = await pos.updateOrderStatus(ord.order_no, 'Shipped', '2026-07-01', sales as any);
  ok('status Shipped keeps est_delivery', up1.status === 'Shipped' && up1.estimated_delivery === '2026-07-01');
  const up2 = await pos.updateOrderStatus(ord.order_no, 'Completed', '2026-07-01', sales as any);
  ok('status Completed wipes est_delivery (parity)', up2.estimated_delivery === null);
  const olines = await db.select().from(s.orderLines);
  ok('order_lines status follows header', olines.every((l: any) => l.status === 'Completed'));

  // ── C. PR → PO → GR ──
  const pr1 = await proc.createPr({ items: [{ item_id: 'X', request_qty: 10 }] }, admin as any);
  const pr2 = await proc.createPr({ items: [{ item_id: 'X', request_qty: 5 }] }, admin as any);
  ok('PR doc atomic sequential 001/002', pr1.pr_no.endsWith('-001') && pr2.pr_no.endsWith('-002'), `${pr1.pr_no},${pr2.pr_no}`);
  const aPr = await proc.approvePr(pr1.pr_no, true, admin as any);
  ok('PR approve → Approved', aPr.status === 'Approved');
  await throws('PR approve non-admin → 403', () => proc.approvePr(pr2.pr_no, true, sales as any), 'FORBIDDEN');

  const po = await proc.createPo({ vendor_name: 'Vendor One', items: [{ item_id: 'X', order_qty: 10, unit_price: 5 }] }, admin as any);
  ok('PO doc format + total 50', /^PO-\d{8}-\d{3}$/.test(po.po_no) && po.total_amount === 50, `${po.po_no} ${po.total_amount}`);
  await proc.approvePo(po.po_no, true, undefined, admin as any);

  const gr = await proc.createGr({ po_no: po.po_no, items: [{ item_id: 'X', received_qty: 10, lot_no: 'L1', expiry_date: '2027-01-01' }] }, admin as any);
  ok('GR fully received → PO Closed', gr.po_status === 'Closed', gr.po_status);
  const [poi] = await db.select().from(s.poItems);
  ok('po_items.received_qty = 10', Number(poi?.receivedQty) === 10, `recv=${poi?.receivedQty}`);
  const mv = await db.select().from(s.stockMovements);
  ok('stock_movement GR row created', mv.length === 1 && mv[0].moveType === 'GR' && Number(mv[0].qty) === 10);
  const ll = await db.select().from(s.lotLedger);
  ok('lot_ledger L1 balance 10', ll.length === 1 && ll[0].lotNo === 'L1' && Number(ll[0].balance) === 10);

  // partial GR on a second PO
  const po2 = await proc.createPo({ vendor_name: 'Vendor One', items: [{ item_id: 'X', order_qty: 10, unit_price: 5 }] }, admin as any);
  await proc.approvePo(po2.po_no, true, undefined, admin as any);
  const gr2 = await proc.createGr({ po_no: po2.po_no, items: [{ item_id: 'X', received_qty: 4 }] }, admin as any);
  ok('GR partial → PO Received', gr2.po_status === 'Received', gr2.po_status);

  // ── D. AR sync + receipt ──
  const sync = await fin.syncArInvoices(admin as any);
  ok('AR sync created invoice for Completed order', sync.created >= 1, `created=${sync.created}`);
  const invNo = `INV-${ord.order_no}`;
  const [inv] = await db.select().from(s.arInvoices).where(eq(s.arInvoices.invoiceNo, invNo));
  ok('AR invoice amount = 100, Unpaid', Number(inv?.amount) === 100 && inv?.status === 'Unpaid', `amt=${inv?.amount} st=${inv?.status}`);
  const rc = await fin.createReceipt({ invoice_no: invNo, amount: 100 }, admin as any);
  ok('AR receipt full → Paid', rc.status === 'Paid' && /^RCP-\d{8}-\d{3}$/.test(rc.receipt_no), `${rc.receipt_no} ${rc.status}`);
  const [inv2] = await db.select().from(s.arInvoices).where(eq(s.arInvoices.invoiceNo, invNo));
  ok('AR invoice paid_amount=100 status Paid', Number(inv2?.paidAmount) === 100 && inv2?.status === 'Paid');

  // ── E. AP txn + pay ──
  const ap = await fin.createApTxn({ vendor_name: 'Vendor One', amount: 200, paid_amount: 0 }, admin as any);
  ok('AP txn Unpaid + doc format', ap.status === 'Unpaid' && /^AP-\d{8}-\d{3}$/.test(ap.txn_no));
  const pay = await fin.payAp(ap.txn_no, 200, admin as any);
  ok('AP pay full → Paid', pay.status === 'Paid');

  // ── F. Sub-ledger → GL auto-posting (Accounting Tier 1) ──
  const arGl = await jlines('AR', invNo);
  ok('GL: AR invoice Dr 1100 = 100, VAT split (Cr 4000≈93.46, Cr 2100≈6.54)', leg(arGl, '1100', 'debit') === 100 && nearW(leg(arGl, '4000', 'credit'), 93.46) && nearW(leg(arGl, '2100', 'credit'), 6.54), `1100=${leg(arGl, '1100', 'debit')} 4000=${leg(arGl, '4000', 'credit')} 2100=${leg(arGl, '2100', 'credit')}`);
  const rcGl = await jlines('RCP', rc.receipt_no);
  ok('GL: AR receipt Dr 1000 / Cr 1100 = 100', leg(rcGl, '1000', 'debit') === 100 && leg(rcGl, '1100', 'credit') === 100);
  const apGl = await jlines('AP', ap.txn_no);
  ok('GL: AP bill Cr 2000 = 200, Dr (5100+2100) = 200', leg(apGl, '2000', 'credit') === 200 && nearW(leg(apGl, '5100', 'debit') + leg(apGl, '2100', 'debit'), 200));
  const payGl = (await db.select().from(s.journalEntries).where(eq(s.journalEntries.source, 'PAY-AP')));
  ok('GL: AP payment posted (Dr 2000 / Cr 1000)', payGl.length === 1);
  // idempotency: re-run AR sync does NOT double-post
  const sync2 = await fin.syncArInvoices(admin as any);
  const arCount = (await db.select().from(s.journalEntries).where(and(eq(s.journalEntries.source, 'AR'), eq(s.journalEntries.sourceRef, invNo)))).length;
  ok('GL: AR sync idempotent (no double-post)', sync2.created === 0 && arCount === 1, `created2=${sync2.created} arEntries=${arCount}`);
  const tbW = await ledger.trialBalance();
  ok('GL: trial balance balances after all sub-ledger postings', tbW.totals.balanced === true, `D=${tbW.totals.debit} C=${tbW.totals.credit}`);
  const rec = await fin.reconcile();
  ok('GL: reconciliation AR/AP control = sub-ledger (both 0 after full settle)', rec.ar.reconciled && rec.ap.reconciled, JSON.stringify(rec).slice(0, 90));

  await pg.close();

  console.log('\n── Phase 3 write-flow (V2 services on PGlite) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} write-flow checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} write-flow checks passed`);
}

async function tid(db: any, code: string): Promise<number> {
  const [t] = await db.select({ id: s.tenants.id }).from(s.tenants).where(eq(s.tenants.code, code));
  return Number(t.id);
}

main().catch((e) => { console.error(e); process.exit(1); });
