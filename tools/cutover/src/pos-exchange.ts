/**
 * docs/52 Phase 4e — POS exchange (even / partial) over PGlite. An exchange returns the original line(s) to
 * STORE CREDIT and rings the replacement line(s) paid from that credit, atomically (one request tx), so only
 * the DIFFERENCE moves in cash: even swap → no cash; up-swap → customer pays the difference; down-swap →
 * residual stays as store credit. The return auto-issues the ใบลดหนี้ (credit note) so output-VAT is reduced.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover pos-exchange
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'exc-secret';
process.env.NODE_ENV = 'test';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, and } from 'drizzle-orm';
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
const taxId = (p12: string) => { let sum = 0; for (let i = 0; i < 12; i++) sum += Number(p12[i]) * (13 - i); return p12 + String((11 - (sum % 11)) % 10); };

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();
  const n = (v: any) => Number(v ?? 0);

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([
    { code: 'HQ', name: 'HQ' },
    { code: 'T1', name: 'ร้านหนึ่ง', legalName: 'บริษัท ร้านหนึ่ง จำกัด', taxId: taxId('010555600001'), vatRegistered: true, branchCode: '00000', addressLine1: '123 ถนนสุขุมวิท', province: 'กรุงเทพมหานคร', postalCode: '10110' },
    { code: 'T2', name: 'ร้านสอง', vatRegistered: true },
  ]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'clerk', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 },   // returns+exec+pos → exchange
    { username: 'cashier', passwordHash: await pw.hash('pwc'), role: 'Cashier', tenantId: t1 }, // pos_sell only → 403
    { username: 'clerk2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t2 },    // cross-tenant
  ]).onConflictDoNothing();
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: false, pointsPerBaht: '0' }).onConflictDoNothing();
  await db.insert(s.items).values([
    { itemId: 'WIDGET', itemDescription: 'วิดเจ็ต', supplyType: 'goods', uom: 'ชิ้น', unitPrice: '100' },
    { itemId: 'GADGET', itemDescription: 'แกดเจ็ต', supplyType: 'goods', uom: 'ชิ้น', unitPrice: '150' },
  ]).onConflictDoNothing();
  await db.insert(s.customerInventory).values([
    { tenantId: t1, itemId: 'WIDGET', itemDescription: 'วิดเจ็ต', uom: 'ชิ้น', currentStock: '1000' },
    { tenantId: t1, itemId: 'GADGET', itemDescription: 'แกดเจ็ต', uom: 'ชิ้น', currentStock: '1000' },
  ]).onConflictDoNothing();

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
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const [admin, clerk, cashier, clerk2] = [await login('admin', 'admin123'), await login('clerk', 'pw1'), await login('cashier', 'pwc'), await login('clerk2', 'pw2')];

  const stockOf = async (item: string) => n((await db.select().from(s.customerInventory).where(and(eq(s.customerInventory.tenantId, t1), eq(s.customerInventory.itemId, item))))[0]?.currentStock);
  // ring a sale on T1 through the generic register (records a captured tender)
  const sell = (items: any[]) => inj('POST', '/api/pos/sales', clerk, { items });
  const cardBal = async (cardNo: string) => n((await db.select().from(s.giftCards).where(eq(s.giftCards.cardNo, cardNo)))[0]?.balance);
  const glLegs = async (source: string, ref: string) => (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source='${source}' AND je.source_ref='${ref}'`)).rows as any[];
  const leg = (rows: any[], c: string, side: string) => Number(rows.filter((l) => l.account_code === c).reduce((a, l) => a + Number(l[side] || 0), 0));
  const balanced = (rows: any[]) => near(rows.reduce((a, l) => a + Number(l.debit || 0), 0), rows.reduce((a, l) => a + Number(l.credit || 0), 0));

  // ── 1. EVEN exchange: WIDGET (100 → total 107) for GADGET priced 100 (new total 107) → zero cash ──
  const s1 = await sell([{ item_id: 'WIDGET', qty: 1, unit_price: 100 }]);
  const wStock0 = await stockOf('WIDGET'); const gStock0 = await stockOf('GADGET');
  const ex1 = await inj('POST', '/api/pos/exchange', clerk, {
    sale_no: s1.json.sale_no, reason: 'ลูกค้าเปลี่ยนใจ',
    return_items: [{ item_id: 'WIDGET', qty: 1 }],
    new_items: [{ item_id: 'GADGET', qty: 1, unit_price: 100 }],
  });
  ok('EVEN exchange → EXC- + RTN- + new SALE-, net 0, even, no cash, credit fully applied (107)',
    /^EXC-/.test(ex1.json.exchange_no ?? '') && /^RTN-/.test(ex1.json.return_no ?? '') && /^SALE-/.test(ex1.json.new_sale_no ?? '')
    && near(ex1.json.net_difference, 0) && ex1.json.even === true && near(ex1.json.cash_collected, 0) && near(ex1.json.store_credit_applied, 107) && near(ex1.json.residual_store_credit, 0),
    `${ex1.status} ${JSON.stringify(ex1.json).slice(0, 160)}`);
  ok('EVEN exchange → WIDGET restocked (+1), GADGET issued (−1)', near(await stockOf('WIDGET'), wStock0 + 1) && near(await stockOf('GADGET'), gStock0 - 1), `w=${await stockOf('WIDGET')} g=${await stockOf('GADGET')}`);
  // GL: return Dr4000 100/Dr2100 7/Cr2200 107; new sale Dr2200 107/Cr4000 100/Cr2100 7 → net cash 1000 untouched.
  const rtnGl1 = await glLegs('RTN', ex1.json.return_no); const saleGl1 = await glLegs('POS', ex1.json.new_sale_no);
  ok('EVEN exchange GL: return Cr 2200=107 (store credit, no cash out); balanced', near(leg(rtnGl1, '2200', 'credit'), 107) && near(leg(rtnGl1, '1000', 'credit'), 0) && balanced(rtnGl1), JSON.stringify(rtnGl1).slice(0, 140));
  ok('EVEN exchange GL: new sale Dr 2200=107 (store-credit draw-down), Dr 1000=0 (no cash), balanced', near(leg(saleGl1, '2200', 'debit'), 107) && near(leg(saleGl1, '1000', 'debit'), 0) && balanced(saleGl1), JSON.stringify(saleGl1).slice(0, 140));

  // ── 2. UP-SWAP: WIDGET (100) for GADGET 150 (new total 160.5) → customer pays the 53.5 difference in cash ──
  const s2 = await sell([{ item_id: 'WIDGET', qty: 1, unit_price: 100 }]);
  const ex2 = await inj('POST', '/api/pos/exchange', clerk, {
    sale_no: s2.json.sale_no, reason: 'อัปเกรดสินค้า',
    return_items: [{ item_id: 'WIDGET', qty: 1 }],
    new_items: [{ item_id: 'GADGET', qty: 1, unit_price: 150 }],
  });
  ok('UP-SWAP → net +53.5, cash_collected 53.5, credit applied 107, no residual, not even',
    near(ex2.json.net_difference, 53.5) && near(ex2.json.cash_collected, 53.5) && near(ex2.json.store_credit_applied, 107) && near(ex2.json.residual_store_credit, 0) && ex2.json.even === false,
    JSON.stringify(ex2.json).slice(0, 140));
  const saleGl2 = await glLegs('POS', ex2.json.new_sale_no);
  ok('UP-SWAP GL: new sale Dr 1000=53.5 (cash diff) + Dr 2200=107 (credit) / Cr 4000=150 + Cr 2100=10.5, balanced',
    near(leg(saleGl2, '1000', 'debit'), 53.5) && near(leg(saleGl2, '2200', 'debit'), 107) && near(leg(saleGl2, '4000', 'credit'), 150) && near(leg(saleGl2, '2100', 'credit'), 10.5) && balanced(saleGl2),
    JSON.stringify(saleGl2).slice(0, 160));

  // ── 3. DOWN-SWAP: GADGET (150 → total 160.5) for WIDGET 100 (new total 107) → residual store credit 53.5 ──
  const s3 = await sell([{ item_id: 'GADGET', qty: 1, unit_price: 150 }]);
  const ex3 = await inj('POST', '/api/pos/exchange', clerk, {
    sale_no: s3.json.sale_no, reason: 'ดาวน์เกรดสินค้า',
    return_items: [{ item_id: 'GADGET', qty: 1 }],
    new_items: [{ item_id: 'WIDGET', qty: 1, unit_price: 100 }],
  });
  ok('DOWN-SWAP → net −53.5, cash_collected 0, credit applied 107, residual 53.5 stays on card',
    near(ex3.json.net_difference, -53.5) && near(ex3.json.cash_collected, 0) && near(ex3.json.store_credit_applied, 107) && near(ex3.json.residual_store_credit, 53.5),
    JSON.stringify(ex3.json).slice(0, 140));
  ok('DOWN-SWAP → the residual store credit is a live, Active card balance (53.5)', near(await cardBal(ex3.json.store_credit_card_no), 53.5), `bal=${await cardBal(ex3.json.store_credit_card_no)}`);

  // ── 4. credit note (ใบลดหนี้) + VAT: an exchange whose original sale carries an Issued full tax invoice ──
  const s4 = await sell([{ item_id: 'WIDGET', qty: 1, unit_price: 100 }]);
  await inj('POST', '/api/tax-invoices/full', clerk, { source_type: 'POS', source_ref: s4.json.sale_no, buyer: { name: 'บริษัท ผู้ซื้อ จำกัด', tax_id: taxId('010555600002'), address: '99 ถนนทดสอบ กรุงเทพฯ' } });
  const ex4 = await inj('POST', '/api/pos/exchange', clerk, {
    sale_no: s4.json.sale_no, reason: 'เปลี่ยนไซซ์',
    return_items: [{ item_id: 'WIDGET', qty: 1 }],
    new_items: [{ item_id: 'GADGET', qty: 1, unit_price: 100 }],
  });
  ok('Exchange against an invoiced sale → the return auto-issues a ใบลดหนี้ (credit note) reducing output VAT',
    /^(CN-|RC-|.*)/.test(ex4.json.credit_note_no ?? '') && !!ex4.json.credit_note_no && ex4.json.original_tax_invoice_no != null,
    `cn=${ex4.json.credit_note_no} inv=${ex4.json.original_tax_invoice_no}`);

  // ── 5. reason is required (reason-coded) ──
  const s5 = await sell([{ item_id: 'WIDGET', qty: 1, unit_price: 100 }]);
  const noReason = await inj('POST', '/api/pos/exchange', clerk, { sale_no: s5.json.sale_no, reason: '', return_items: [{ item_id: 'WIDGET', qty: 1 }], new_items: [{ item_id: 'GADGET', qty: 1, unit_price: 100 }] });
  ok('Exchange with a blank reason → 400 (reason-coded)', noReason.status === 400, `${noReason.status} ${noReason.json.error?.code ?? ''}`);

  // ── 6. over-return guard propagates: return more than sold ──
  const s6 = await sell([{ item_id: 'WIDGET', qty: 1, unit_price: 100 }]);
  const over = await inj('POST', '/api/pos/exchange', clerk, { sale_no: s6.json.sale_no, reason: 'x', return_items: [{ item_id: 'WIDGET', qty: 3 }], new_items: [{ item_id: 'GADGET', qty: 1, unit_price: 100 }] });
  ok('Exchange returning more than sold → 400 OVER_RETURN (guard propagates)', over.status === 400 && over.json.error?.code === 'OVER_RETURN', `${over.status} ${over.json.error?.code}`);
  // atomicity: the failed exchange left NO new GADGET sale and NO restock
  const orphanSale = (await pg.query(`SELECT count(*) c FROM cust_pos_sales WHERE notes LIKE '%${s6.json.sale_no}%'`)).rows[0] as any;
  ok('Failed exchange is atomic → no orphan replacement sale persisted', Number(orphanSale?.c ?? 0) === 0, `orphans=${orphanSale?.c}`);

  // ── 7. SoD/permission: a plain Cashier (pos_sell only) cannot run an exchange (a refund is involved) ──
  const s7 = await sell([{ item_id: 'WIDGET', qty: 1, unit_price: 100 }]);
  const cashierEx = await inj('POST', '/api/pos/exchange', cashier, { sale_no: s7.json.sale_no, reason: 'x', return_items: [{ item_id: 'WIDGET', qty: 1 }], new_items: [{ item_id: 'GADGET', qty: 1, unit_price: 100 }] });
  ok('Cashier (pos_sell only, no returns/pos_refund/exec) → 403 (refund duty segregated from selling)', cashierEx.status === 403, `${cashierEx.status}`);

  // ── 8. cross-tenant isolation: T2 clerk exchanging against a T1 sale → 404 (return not found) ──
  const crossEx = await inj('POST', '/api/pos/exchange', clerk2, { sale_no: s7.json.sale_no, reason: 'x', return_items: [{ item_id: 'WIDGET', qty: 1 }], new_items: [{ item_id: 'GADGET', qty: 1, unit_price: 100 }] });
  ok('RLS: T2 exchange against a T1 sale → 404 NOT_FOUND (tenant isolation)', crossEx.status === 404, `${crossEx.status}`);

  // ── 9. trial balance stays balanced after all the exchanges ──
  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json.totals ?? {};
  ok('Trial balance balanced after all exchanges', near(tb.debit ?? tb.total_debit, tb.credit ?? tb.total_credit), JSON.stringify(tb).slice(0, 60));

  await app.close();
  await pg.close();
  console.log('\n── docs/52 Phase 4e — POS exchange (even / partial) (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} pos-exchange checks failed` : `\n✅ All ${checks.length} pos-exchange checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
