/**
 * docs/52 Phase 6a — multi-tender split payment. One sale can be settled by several tenders (cash + card +
 * QR + voucher …). Each leg's `amount` applies to the sale and the legs must sum EXACTLY to the total; a cash
 * leg may over-tender (change). Every leg is recorded as its own PAY tender (drawer/settlement worklist), and
 * the GL asset debit splits across per-method TENDER.* posting events (all default 1000 → net-GL byte-identical
 * to the legacy single Dr 1000 = total; GL-24-remappable). Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover pos-split
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'is-secret';
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
  await db.insert(s.tenants).values([
    { code: 'SHOP', name: 'ร้านค้าปลีก', industry: 'retail' },
    { code: 'SHOP2', name: 'ร้านค้าปลีก 2', industry: 'retail' }, // isolated tenant for the GL-24 remap check
  ]).onConflictDoNothing();
  const t = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'SHOP')))[0].id);
  const t2 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'SHOP2')))[0].id);
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('pw1'), role: 'Admin', tenantId: t },
    { username: 'wh', passwordHash: await pw.hash('pw1'), role: 'Warehouse', tenantId: t },
    { username: 'admin2', passwordHash: await pw.hash('pw1'), role: 'Admin', tenantId: t2 },
  ]).onConflictDoNothing();
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: false, pointsPerBaht: '0' }).onConflictDoNothing();
  await db.insert(s.items).values([{ itemId: 'WIDGET', itemDescription: 'สินค้า', supplyType: 'goods', uom: 'ชิ้น', unitPrice: '100' }]).onConflictDoNothing();
  await db.insert(s.customerInventory).values([
    { tenantId: t, itemId: 'WIDGET', itemDescription: 'สินค้า', uom: 'ชิ้น', currentStock: '1000' },
    { tenantId: t2, itemId: 'WIDGET', itemDescription: 'สินค้า', uom: 'ชิ้น', currentStock: '1000' },
  ]).onConflictDoNothing();
  // GL-24 remap for SHOP2 (seeded BEFORE any sale so the override cache reads it on first lookup): banks card
  // proceeds into 1010 (Bank — Current) instead of Cash.
  await db.insert(s.postingRules).values({ tenantId: t2, eventType: 'TENDER.CARD', legOrder: 1, role: 'tender_asset', side: 'DR', accountCode: '1010', status: 'Approved', active: true }).onConflictDoNothing();

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
  const login = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'pw1' })).json.token as string;
  const admin = await login('admin');
  const glOf = async (saleNo: string) => (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source='POS' AND je.source_ref='${saleNo}'`)).rows as any[];
  const payCount = async (saleNo: string) => (await pg.query(`SELECT count(*)::int AS c FROM payments WHERE sale_no='${saleNo}'`)).rows[0].c as number;
  const dr = (gl: any[], acct: string) => gl.filter((l) => l.account_code === acct).reduce((a, l) => a + Number(l.debit || 0), 0);
  const cr = (gl: any[], acct: string) => gl.filter((l) => l.account_code === acct).reduce((a, l) => a + Number(l.credit || 0), 0);
  const bal = (gl: any[]) => near(gl.reduce((a, l) => a + Number(l.debit || 0), 0), gl.reduce((a, l) => a + Number(l.credit || 0), 0));
  const sale = (body: any) => inj('POST', '/api/pos/sales', admin, body);
  const W = (qty = 1) => [{ item_id: 'WIDGET', qty, unit_price: 100 }]; // qty×100 net, +7% VAT

  // ── 1. single-tender (no tenders[]) → byte-identical: one PAY, Dr 1000 = total, tenders=null ──
  const one = await sale({ items: W(1), payment_method: 'Cash' });
  const oneGl = await glOf(one.json.sale_no);
  ok('single-tender byte-identical: 1 PAY row, Dr 1000 = 107, Cr 4000 100 / 2100 7, tenders=null',
    (await payCount(one.json.sale_no)) === 1 && near(one.json.total, 107) && near(dr(oneGl, '1000'), 107) && near(cr(oneGl, '4000'), 100) && near(cr(oneGl, '2100'), 7) && one.json.tenders === null && bal(oneGl),
    JSON.stringify({ pays: await payCount(one.json.sale_no), total: one.json.total, tenders: one.json.tenders }));

  // ── 2. 3-way split cash+card+QR summing to 107 → 3 PAY rows, Dr 1000 = 107 (all default), balanced ──
  const three = await sale({ items: W(1), tenders: [{ method: 'Cash', amount: 50 }, { method: 'Card', amount: 30 }, { method: 'QR', amount: 27 }] });
  const threeGl = await glOf(three.json.sale_no);
  ok('3-way split (cash 50 + card 30 + QR 27 = 107): 3 PAY rows linked to the sale, response tenders[3]',
    (await payCount(three.json.sale_no)) === 3 && Array.isArray(three.json.tenders) && three.json.tenders.length === 3,
    JSON.stringify({ pays: await payCount(three.json.sale_no), tenders: three.json.tenders?.length }));
  ok('3-way split GL: all methods default to 1000 → single Dr 1000 = 107 (net byte-identical), Cr 4000 100 / 2100 7, balanced',
    near(dr(threeGl, '1000'), 107) && near(cr(threeGl, '4000'), 100) && near(cr(threeGl, '2100'), 7) && bal(threeGl),
    JSON.stringify(threeGl));

  // ── 3. short tender (sum < total) → TENDER_MISMATCH, nothing persisted ──
  const short = await sale({ items: W(1), tenders: [{ method: 'Cash', amount: 50 }, { method: 'Card', amount: 30 }] });
  ok('short tender (80 < 107) → 400 TENDER_MISMATCH', short.status === 400 && short.json.error?.code === 'TENDER_MISMATCH', `${short.status} ${short.json.error?.code}`);

  // ── 4. cash over-tender via cash_tendered → change_due returned; GL still Dr 1000 = 107 (change ≠ GL) ──
  const ovr = await sale({ items: W(1), tenders: [{ method: 'Cash', amount: 107, cash_tendered: 200 }] });
  const ovrGl = await glOf(ovr.json.sale_no);
  ok('cash over-tender: change_due 93 returned; GL Dr 1000 = 107 (change never hits the GL)',
    near(ovr.json.change_due, 93) && near(dr(ovrGl, '1000'), 107) && bal(ovrGl),
    JSON.stringify({ change_due: ovr.json.change_due, dr1000: dr(ovrGl, '1000') }));

  // ── 5. a NON-cash leg cannot over-tender → NONCASH_OVERTENDER ──
  const nco = await sale({ items: W(1), tenders: [{ method: 'Card', amount: 107, cash_tendered: 200 }] });
  ok('non-cash over-tender → 400 NONCASH_OVERTENDER', nco.status === 400 && nco.json.error?.code === 'NONCASH_OVERTENDER', `${nco.status} ${nco.json.error?.code}`);

  // ── 6. GL-24 remap TENDER.CARD → 1010 (SHOP2, rule seeded at setup): cash+card split posts Dr 1000 + Dr 1010 ──
  const admin2 = await login('admin2');
  const remap = await inj('POST', '/api/pos/sales', admin2, { items: W(1), tenders: [{ method: 'Cash', amount: 50 }, { method: 'Card', amount: 57 }] });
  const remapGl = await glOf(remap.json.sale_no);
  ok('GL-24 remap TENDER.CARD→1010: split posts Dr 1000 = 50 (cash) + Dr 1010 = 57 (card), Cr 4000 100 / 2100 7, balanced',
    near(dr(remapGl, '1000'), 50) && near(dr(remapGl, '1010'), 57) && near(cr(remapGl, '4000'), 100) && near(cr(remapGl, '2100'), 7) && bal(remapGl),
    JSON.stringify(remapGl));

  // ── 7. permission: a non-selling role cannot ring a split sale ──
  const wh = await inj('POST', '/api/pos/sales', await login('wh'), { items: W(1), tenders: [{ method: 'Cash', amount: 107 }] });
  ok('non-selling role (Warehouse) → 403', wh.status === 403, `${wh.status}`);

  await app.close();
  await pg.close();
  console.log('\n── docs/52 Phase 6a — multi-tender split payment (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} pos-split checks failed` : `\n✅ All ${checks.length} pos-split checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
