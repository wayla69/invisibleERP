/**
 * POS Phase B (B4) — Pricing rules at the till (กฎราคา ณ จุดขาย) over PGlite.
 * Proves the pricing engine (combo explosion + happy-hour) AND that opt-in pricing rules actually
 * APPLY at dine-in checkout: item %/BOGO/qty-break line discounts, an order-level rule, an auto
 * service charge for large parties (VATable → 4400), satang rounding (→ 4900), balanced GL, time/day
 * gating, and byte-identical backward-compat when not opted in.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover pricing
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'pricing-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง', taxId: '0105556000017', vatRegistered: true }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1] = [await tid('HQ'), await tid('T1')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'sales1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 },
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
  const sales1 = await login('sales1', 'pw1');

  // ── catalog: a category + items (created by the T1 shop → tenant-scoped) ──
  const cat = await inj('POST', '/api/menu/categories', sales1, { code: 'food', name: 'อาหาร', sort: 1 });
  const catId = cat.json.id;
  const mkItem = (sku: string, name: string, price: number) => inj('POST', '/api/menu/items', sales1, { sku, name, price, category_id: catId, station_code: 'hot' });
  for (const [sku, nm, pr] of [['ITEMA', 'กะเพรา', 100], ['ITEMB', 'น้ำ', 50], ['ITEMC', 'ต้มยำ', 100], ['ITEMD', 'แกง', 200], ['ITEMF', 'ผัดไทย', 100]] as [string, string, number][])
    await mkItem(sku, nm, pr);

  // ── time context (Bangkok) for the day-gating negative test ──
  const bkk = new Date(Date.now() + 7 * 3600 * 1000);
  const isoDow = ((bkk.getUTCDay() + 6) % 7) + 1; const wrongDow = (isoDow % 7) + 1;

  // ── rules (item-scoped, always-on unless noted) created via the API as the T1 shop ──
  // G6 maker-checker (SoD R10): a rule is staged inactive on create and must be ACTIVATED by a DIFFERENT
  // user (admin ≠ sales1). mkRule creates then approves so downstream pricing behaves as before.
  const admin = await login('admin', 'admin123');
  const mkRule = async (b: any) => { const r = await inj('POST', '/api/pricing/rules', sales1, b); if (r.json?.id) await inj('POST', `/api/pricing/rules/${r.json.id}/approve`, admin); return r; };
  // Control: a staged rule does NOT apply until approved; the author cannot self-approve. Uses a dedicated
  // throwaway item GX (200) so activating the test rule does not perturb the other pricing checks.
  await mkItem('GX', 'ทดสอบ G6', 200);
  const stagedRule = await inj('POST', '/api/pricing/rules', sales1, { name: 'G6 staged 50%', scope: 'item', target_id: 'GX', type: 'percent', value: 50, priority: 5 });
  ok('G6: new price rule staged PendingApproval (inactive)', stagedRule.json?.pending === true && stagedRule.json?.status === 'PendingApproval', JSON.stringify({ p: stagedRule.json?.pending, s: stagedRule.json?.status }));
  const qBeforeAppr = await inj('POST', '/api/pricing/quote', sales1, { lines: [{ sku: 'GX', qty: 1 }] });
  ok('G6: staged rule does NOT apply in a quote until approved (GX stays 200)', near(qBeforeAppr.json.subtotal, 200) && near(qBeforeAppr.json.line_discount_total, 0), `sub=${qBeforeAppr.json.subtotal} ld=${qBeforeAppr.json.line_discount_total}`);
  const ruleSelf = await inj('POST', `/api/pricing/rules/${stagedRule.json?.id}/approve`, sales1);
  ok('G6: author cannot approve own price rule → 403 SOD_VIOLATION', ruleSelf.status === 403 && ruleSelf.json?.error?.code === 'SOD_VIOLATION', `${ruleSelf.status} ${ruleSelf.json?.error?.code}`);
  const ruleAppr = await inj('POST', `/api/pricing/rules/${stagedRule.json?.id}/approve`, admin);
  const qAfterAppr = await inj('POST', '/api/pricing/quote', sales1, { lines: [{ sku: 'GX', qty: 1 }] });
  ok('G6: a distinct user activates the rule → then it applies (GX 50% → line_discount 100)', (ruleAppr.status === 200 || ruleAppr.status === 201) && ruleAppr.json?.active === true && near(qAfterAppr.json.line_discount_total, 100), `active=${ruleAppr.json?.active} ld=${qAfterAppr.json.line_discount_total}`);
  await mkRule({ name: 'ITEMA 20% off', scope: 'item', target_id: 'ITEMA', type: 'percent', value: 20, priority: 10 });
  await mkRule({ name: 'ITEMB BOGO', scope: 'item', target_id: 'ITEMB', type: 'bogo', min_qty: 1, priority: 10 });
  await mkRule({ name: 'ITEMC qty-break 10%', scope: 'item', target_id: 'ITEMC', type: 'qty_break', value: 10, min_qty: 3, priority: 10 });
  await mkRule({ name: 'ITEMF wrong-day 50%', scope: 'item', target_id: 'ITEMF', type: 'percent', value: 50, dow: String(wrongDow), priority: 10 });

  // combo: SETA = ITEMA + ITEMB (for the quote-engine explosion test)
  await inj('PUT', '/api/pricing/combos/SETA', sales1, { components: [{ component_sku: 'ITEMA', qty: 1 }, { component_sku: 'ITEMB', qty: 1 }] });

  let tn = 0;
  const order = async (items: any[]) => {
    const t = await inj('POST', '/api/restaurant/tables', sales1, { table_no: `P${++tn}`, seats: 8 });
    return (await inj('POST', '/api/restaurant/orders', sales1, { table_id: t.json.id, items })).json;
  };
  const checkout = (orderNo: string, body: any) => inj('POST', `/api/restaurant/orders/${orderNo}/checkout`, sales1, body);
  const glFor = async (saleNo: string) => (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source_ref='${saleNo}'`)).rows as any[];
  const leg = (gl: any[], code: string, side: string) => Number(gl.filter((l) => l.account_code === code).reduce((a, l) => a + Number(l[side] || 0), 0));
  const balanced = (gl: any[]) => near(gl.reduce((a, l) => a + Number(l.debit || 0), 0), gl.reduce((a, l) => a + Number(l.credit || 0), 0));

  // ── 1. quote engine: combo explodes + item rule applies ──
  const q = await inj('POST', '/api/pricing/quote', sales1, { lines: [{ sku: 'SETA', qty: 1 }] });
  ok('Quote: combo SETA explodes to 2 lines (ITEMA+ITEMB)', q.json.lines?.length === 2 && q.json.lines.some((l: any) => l.sku === 'ITEMA') && q.json.lines.some((l: any) => l.sku === 'ITEMB'), JSON.stringify(q.json.lines)?.slice(0, 120));
  ok('Quote: ITEMA 20% rule applied in quote (gross150, line_disc 20)', near(q.json.subtotal, 150) && near(q.json.line_discount_total, 20), `sub=${q.json.subtotal} ld=${q.json.line_discount_total}`);

  // ── 2. item percent rule APPLIES at checkout (ITEMA 100 → 20% → net 80, vat 5.60, total 85.60) ──
  const a = await checkout((await order([{ sku: 'ITEMA', qty: 1 }])).order_no, { apply_pricing_rules: true });
  ok('Checkout item 20%: subtotal 80, total 85.60', near(a.json.subtotal, 80) && near(a.json.total, 85.60), `${a.status} sub=${a.json.subtotal} tot=${a.json.total} rules=${a.json.applied_rules}`);
  ok('Checkout item 20%: rule name surfaced in applied_rules', (a.json.applied_rules ?? []).includes('ITEMA 20% off'), JSON.stringify(a.json.applied_rules));
  ok('Checkout item 20%: GL balanced + Cr4000=80', balanced(await glFor(a.json.sale_no)) && near(leg(await glFor(a.json.sale_no), '4000', 'credit'), 80));

  // ── 3. BOGO at checkout (ITEMB 50 × 2 → 1 free → net 50, total 53.50) ──
  const b = await checkout((await order([{ sku: 'ITEMB', qty: 2 }])).order_no, { apply_pricing_rules: true });
  ok('Checkout BOGO: subtotal 50, total 53.50', near(b.json.subtotal, 50) && near(b.json.total, 53.50), `sub=${b.json.subtotal} tot=${b.json.total}`);

  // ── 4. qty-break at checkout (ITEMC 100 × 3 = 300 → 10% → 270, total 288.90) ──
  const c = await checkout((await order([{ sku: 'ITEMC', qty: 3 }])).order_no, { apply_pricing_rules: true });
  ok('Checkout qty-break: subtotal 270, total 288.90', near(c.json.subtotal, 270) && near(c.json.total, 288.90), `sub=${c.json.subtotal} tot=${c.json.total}`);
  // qty-break does NOT apply below threshold (ITEMC × 2 = 200, no discount → total 214)
  const c2 = await checkout((await order([{ sku: 'ITEMC', qty: 2 }])).order_no, { apply_pricing_rules: true });
  ok('Checkout qty-break below threshold: no discount, total 214', near(c2.json.subtotal, 200) && near(c2.json.total, 214), `sub=${c2.json.subtotal} tot=${c2.json.total}`);

  // ── 5. backward-compat: WITHOUT apply_pricing_rules, no rule applies (ITEMA full price → total 107) ──
  const bc = await checkout((await order([{ sku: 'ITEMA', qty: 1 }])).order_no, {});
  ok('Backward-compat: no opt-in → ITEMA full price, total 107', near(bc.json.subtotal, 100) && near(bc.json.total, 107) && (bc.json.applied_rules ?? []).length === 0, `sub=${bc.json.subtotal} tot=${bc.json.total}`);

  // ── 6. time/day gating: ITEMF's wrong-day rule must NOT apply (full price → total 107) ──
  const f = await checkout((await order([{ sku: 'ITEMF', qty: 1 }])).order_no, { apply_pricing_rules: true });
  ok('Day-gating: wrong-day rule NOT applied (ITEMF total 107)', near(f.json.total, 107) && (f.json.applied_rules ?? []).length === 0, `tot=${f.json.total} rules=${f.json.applied_rules}`);

  // ── 7. order-level rule + service charge + satang rounding + balanced GL ──
  // create an order-level 5% rule, then sell ITEMD 200 to a party of 6 with 10% service charge + rounding=1.
  await mkRule({ name: 'Whole-bill 5%', scope: 'all', type: 'percent', value: 5, priority: 50 });
  const d = await checkout((await order([{ sku: 'ITEMD', qty: 1 }])).order_no, { apply_pricing_rules: true, party_size: 6, service_charge_pct: 10, service_min_party: 6, rounding: 1 });
  // goods 200 − 5% order = 190; service 10% = 19; taxable 209; vat 14.63; preRound 223.63; round→224; adj 0.37
  ok('Order rule 5% applied (discount 10)', near(d.json.discount, 10), `disc=${d.json.discount}`);
  ok('Service charge 19 (party 6 ≥ min 6)', near(d.json.service_charge, 19), `sc=${d.json.service_charge}`);
  ok('Satang rounding to 224 (adj +0.37)', near(d.json.total, 224) && near(d.json.rounding_adjustment, 0.37), `tot=${d.json.total} adj=${d.json.rounding_adjustment}`);
  const dgl = await glFor(d.json.sale_no);
  ok('GL: service charge → Cr 4400 = 19', near(leg(dgl, '4400', 'credit'), 19), JSON.stringify(dgl));
  ok('GL: rounding gain → Cr 4900 = 0.37', near(leg(dgl, '4900', 'credit'), 0.37));
  ok('GL: goods Cr 4000 = 190, VAT Cr 2100 = 14.63, cash Dr 1000 = 224', near(leg(dgl, '4000', 'credit'), 190) && near(leg(dgl, '2100', 'credit'), 14.63) && near(leg(dgl, '1000', 'debit'), 224));
  ok('GL: balanced (Σdebit = Σcredit)', balanced(dgl));

  // ── 8. service charge NOT applied below the party threshold ──
  const dsmall = await checkout((await order([{ sku: 'ITEMD', qty: 1 }])).order_no, { apply_pricing_rules: true, party_size: 2, service_charge_pct: 10, service_min_party: 6 });
  ok('Service charge skipped for small party (party 2 < 6)', near(dsmall.json.service_charge, 0), `sc=${dsmall.json.service_charge}`);

  await app.close();
  await pg.close();

  console.log('\n── POS Phase B (B4) Pricing rules at the till (กฎราคา ณ จุดขาย) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} pricing checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} pricing checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
