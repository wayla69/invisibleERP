/**
 * POS Tier 1 #5 — Returns/refunds with restock + credit-note hook (คืนสินค้า/คืนเงิน) over PGlite:
 * item-level return → refund (REF-), restock customer_inventory + cust_stock_log, GL reversal.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover returns
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ret-secret';
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

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง', vatRegistered: true }, { code: 'T2', name: 'ร้านสอง', vatRegistered: true }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'sales1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 },
    { username: 'cust1', passwordHash: await pw.hash('pc1'), role: 'Customer', tenantId: t1 },
    { username: 'sales2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t2 },
    { username: 'wh1', passwordHash: await pw.hash('pwh'), role: 'Warehouse', tenantId: t1 },
  ]).onConflictDoNothing();
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: false, pointsPerBaht: '0' }).onConflictDoNothing();
  await db.insert(s.customerInventory).values({ tenantId: t1, itemId: 'A', itemDescription: 'สินค้า A', uom: 'ชิ้น', currentStock: '10', reorderPoint: '2', reorderQty: '10' }).onConflictDoNothing();

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
  const [admin, sales1, cust1, sales2, wh1] = [await login('admin', 'admin123'), await login('sales1', 'pw1'), await login('cust1', 'pc1'), await login('sales2', 'pw2'), await login('wh1', 'pwh')];
  const stockOf = async () => n((await db.select().from(s.customerInventory).where(and(eq(s.customerInventory.tenantId, t1), eq(s.customerInventory.itemId, 'A'))))[0]?.currentStock);
  function n(v: any) { return Number(v ?? 0); }
  const sell = (qty: number) => inj('POST', '/api/portal/pos/sales', cust1, { items: [{ item_id: 'A', qty, unit_price: 100 }] });

  // ── full return → refund + restock + GL ──
  const sale1 = await sell(2); // subtotal 200, vat 14, total 214; stock 10→8
  ok('Setup: portal sale 2×A → total 214, stock 8', /^SALE-/.test(sale1.json.sale_no ?? '') && near(sale1.json.total, 214) && near(await stockOf(), 8), `${sale1.status} stock=${await stockOf()}`);
  const r1 = await inj('POST', '/api/pos/returns', sales1, { sale_no: sale1.json.sale_no, items: [{ item_id: 'A', qty: 2 }], reason: 'ชำรุด' });
  ok('Full return → RTN- + REF- + total 214 + restocked + JE-', /^RTN-/.test(r1.json.return_no ?? '') && /^REF-/.test(r1.json.refund_no ?? '') && near(r1.json.total_returned, 214) && r1.json.restocked === true && /^JE-/.test(r1.json.journal_no ?? ''), `${r1.status} ${JSON.stringify(r1.json).slice(0, 120)}`);
  ok('Restock: currentStock back to 10', near(await stockOf(), 10), `stock=${await stockOf()}`);
  const slog = (await pg.query(`SELECT log_type, qty_change, ref_doc FROM cust_stock_log WHERE ref_doc='${r1.json.return_no}'`)).rows as any[];
  ok('cust_stock_log Return row (+2)', slog.length === 1 && slog[0].log_type === 'Return' && near(slog[0].qty_change, 2), JSON.stringify(slog));
  const gl = (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source='RTN' AND je.source_ref='${r1.json.return_no}'`)).rows as any[];
  const leg = (c: string, side: string) => Number(gl.filter((l) => l.account_code === c).reduce((a, l) => a + Number(l[side] || 0), 0));
  ok('GL reversal: Dr4000=200, Dr2100=14, Cr1000=214, balanced', near(leg('4000', 'debit'), 200) && near(leg('2100', 'debit'), 14) && near(leg('1000', 'credit'), 214) && near(gl.reduce((a, l) => a + Number(l.debit || 0), 0), gl.reduce((a, l) => a + Number(l.credit || 0), 0)), JSON.stringify(gl));
  const pays = await inj('GET', `/api/payments?sale_no=${sale1.json.sale_no}`, admin);
  ok('Refund flips payment → Refunded (full)', (pays.json.payments ?? []).some((p: any) => p.status === 'Refunded'), JSON.stringify(pays.json.payments?.[0] ?? {}).slice(0, 70));
  const tb1 = (await inj('GET', '/api/ledger/trial-balance', admin)).json.totals ?? {};
  ok('Trial balance balanced after full return', near(tb1.debit ?? tb1.total_debit, tb1.credit ?? tb1.total_credit), JSON.stringify(tb1).slice(0, 60));

  // ── partial return (1 of 2) ──
  const sale2 = await sell(2); // stock 10→8
  const r2 = await inj('POST', '/api/pos/returns', sales1, { sale_no: sale2.json.sale_no, items: [{ item_id: 'A', qty: 1 }] });
  ok('Partial return 1/2 → total 107, subtotal 100, vat 7, stock 9', near(r2.json.total_returned, 107) && near(r2.json.subtotal_returned, 100) && near(r2.json.vat_returned, 7) && near(await stockOf(), 9), `${r2.status} stock=${await stockOf()} ${JSON.stringify(r2.json).slice(0, 80)}`);
  const pays2 = await inj('GET', `/api/payments?sale_no=${sale2.json.sale_no}`, admin);
  ok('Partial return: payment stays Captured', (pays2.json.payments ?? []).some((p: any) => p.status === 'Captured'), JSON.stringify(pays2.json.payments?.[0] ?? {}).slice(0, 60));
  const over = await inj('POST', '/api/pos/returns', sales1, { sale_no: sale2.json.sale_no, items: [{ item_id: 'A', qty: 2 }] }); // only 1 remains
  ok('Over-return (2 of remaining 1) → 400 OVER_RETURN', over.status === 400 && over.json.error?.code === 'OVER_RETURN', `${over.status} ${over.json.error?.code}`);

  // ── over-return in one shot ──
  const sale3 = await sell(2);
  const over1 = await inj('POST', '/api/pos/returns', sales1, { sale_no: sale3.json.sale_no, items: [{ item_id: 'A', qty: 3 }] });
  ok('Return qty 3 of 2-qty line → 400 OVER_RETURN', over1.status === 400 && over1.json.error?.code === 'OVER_RETURN', `${over1.status} ${over1.json.error?.code}`);

  // ── no captured payment ──
  const [comp] = await db.insert(s.custPosSales).values({ saleNo: 'COMP-1', saleDate: '2026-06-21', tenantId: t1, subtotal: '100', discount: '0', taxAmount: '7', total: '107', paymentMethod: 'Comp', pointsUsed: '0', pointsEarned: '0', status: 'Completed', createdBy: 'seed' }).returning({ id: s.custPosSales.id });
  await db.insert(s.custPosItems).values({ saleId: Number(comp.id), itemId: 'A', itemDescription: 'สินค้า A', qty: '1', uom: 'ชิ้น', unitPrice: '100', discountPct: '0', amount: '100', isCustom: false });
  const noPay = await inj('POST', '/api/pos/returns', sales1, { sale_no: 'COMP-1', items: [{ item_id: 'A', qty: 1 }] });
  ok('Comp sale (no payment) → 400 NO_CAPTURED_PAYMENT', noPay.status === 400 && noPay.json.error?.code === 'NO_CAPTURED_PAYMENT', `${noPay.status} ${noPay.json.error?.code}`);

  // ── RLS + permissions ──
  const crossList = await inj('GET', `/api/pos/returns?sale_no=${sale1.json.sale_no}`, sales2);
  ok('RLS: T2 sees no returns for T1 sale', (crossList.json.returns ?? []).length === 0, `n=${crossList.json.count}`);
  const crossPost = await inj('POST', '/api/pos/returns', sales2, { sale_no: sale1.json.sale_no, items: [{ item_id: 'A', qty: 1 }] });
  ok('RLS: T2 return against T1 sale → 404 NOT_FOUND', crossPost.status === 404, `${crossPost.status}`);
  const noPerm = await inj('POST', '/api/pos/returns', wh1, { sale_no: sale3.json.sale_no, items: [{ item_id: 'A', qty: 1 }] });
  ok('Permission: Warehouse (no returns/pos) → 403', noPerm.status === 403, `${noPerm.status}`);

  // ── Returns register (list-all, tenant-scoped + filterable) ──
  // T1 has exactly 2 returns (full 214 + partial 107 = 321; both restocked).
  const reg = await inj('GET', '/api/pos/returns', sales1);
  ok('Returns register: lists all tenant returns with totals (2 · ฿321 · 2 restocked)', (reg.json.returns ?? []).length === 2 && reg.json.total_count === 2 && near(reg.json.total_refunded, 321) && reg.json.restocked_count === 2, `n=${reg.json.count} total=${reg.json.total_refunded} restocked=${reg.json.restocked_count}`);
  const regSearch = await inj('GET', `/api/pos/returns?search=${encodeURIComponent(r1.json.return_no)}`, sales1);
  ok('Returns register: search by return_no narrows the list (1)', (regSearch.json.returns ?? []).length === 1 && regSearch.json.returns[0].return_no === r1.json.return_no, `n=${regSearch.json.count}`);
  const regT2 = await inj('GET', '/api/pos/returns', sales2);
  ok('Returns register: RLS — T2 sees none of T1 returns', (regT2.json.returns ?? []).length === 0 && regT2.json.total_count === 0, `n=${regT2.json.count}`);

  const tbEnd = (await inj('GET', '/api/ledger/trial-balance', admin)).json.totals ?? {};
  ok('Trial balance balanced at end', near(tbEnd.debit ?? tbEnd.total_debit, tbEnd.credit ?? tbEnd.total_credit), JSON.stringify(tbEnd).slice(0, 60));

  await app.close();
  await pg.close();

  console.log('\n── POS Tier 1 #5 Returns/refunds + restock (คืนสินค้า/คืนเงิน) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} returns checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} returns checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
