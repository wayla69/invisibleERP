/**
 * docs/52 Phase 4a — customer-tier & per-branch price books. A governed, approved base-price list the POS
 * draws from: a book serves a customer TIER and/or a BRANCH, holds per-item prices, and is MAKER-CHECKER
 * (staged PendingApproval + inactive; a DIFFERENT user activates it — mirrors the price-rule G6 gate). At the
 * till, `createSale` overrides a line's client price with the governed book price when an active, approved book
 * matches (tier/branch/validity); no matching book ⇒ the client price stands (byte-identical). Precedence:
 * priority (lower first) → specificity → newest; within a book the highest min_qty ≤ the sold qty wins.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover pos-pricebook
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'is-secret';
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
  await db.insert(s.tenants).values([
    { code: 'SHOP', name: 'ร้านค้าส่ง', industry: 'retail' },
    { code: 'SHOP2', name: 'ร้านอื่น', industry: 'retail' },
  ]).onConflictDoNothing();
  const t = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'SHOP')))[0].id);
  const t2 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'SHOP2')))[0].id);
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('pw1'), role: 'Admin', tenantId: t },   // seller + approver
    { username: 'boss', passwordHash: await pw.hash('pw1'), role: 'Admin', tenantId: t },    // distinct checker
    { username: 'wh', passwordHash: await pw.hash('pw1'), role: 'Warehouse', tenantId: t },  // no pricelist → 403
  ]).onConflictDoNothing();
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: false, pointsPerBaht: '0' }).onConflictDoNothing();
  await db.insert(s.items).values([
    { itemId: 'WIDGET', itemDescription: 'วิดเจ็ต', supplyType: 'goods', uom: 'ชิ้น', unitPrice: '100' },
  ]).onConflictDoNothing();
  await db.insert(s.customerInventory).values([
    { tenantId: t, itemId: 'WIDGET', itemDescription: 'วิดเจ็ต', uom: 'ชิ้น', currentStock: '10000' },
  ]).onConflictDoNothing();
  const [brB] = await db.insert(s.branches).values({ tenantId: t, code: 'BR-B', name: 'สาขา B' }).returning({ id: s.branches.id });
  const [brA] = await db.insert(s.branches).values({ tenantId: t, code: 'BR-A', name: 'สาขา A' }).returning({ id: s.branches.id });

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
  const boss = await login('boss');
  const wh = await login('wh');

  // sell one WIDGET (client list price 100) under an optional tier / branch — returns the sale response
  const sale = (opts: { tier?: string; branch?: number; qty?: number } = {}) => inj('POST', '/api/pos/sales', admin, {
    items: [{ item_id: 'WIDGET', qty: opts.qty ?? 1, unit_price: 100 }],
    ...(opts.tier ? { price_tier: opts.tier } : {}), ...(opts.branch ? { branch_id: opts.branch } : {}),
  });
  const revOf = async (saleNo: string) => Number((await pg.query(`SELECT sum(credit) c FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source='POS' AND je.source_ref='${saleNo}' AND account_code='4000'`)).rows[0]?.c ?? 0);
  const mkBook = (tok: string, body: any) => inj('POST', '/api/pricing/books', tok, body);
  const setEntries = (tok: string, id: number, entries: any[]) => inj('POST', `/api/pricing/books/${id}/entries`, tok, { entries });
  const approve = (tok: string, id: number, body?: any) => inj('POST', `/api/pricing/books/${id}/approve`, tok, body ?? {});
  // create book + entries as `admin`, activate with a DISTINCT checker `boss`
  const activate = async (body: any, entries: any[]) => { const b = await mkBook(admin, body); await setEntries(admin, b.json.id, entries); await approve(boss, b.json.id); return Number(b.json.id); };

  // ── 1. maker creates a wholesale book → staged PendingApproval + inactive ──
  const w1 = await mkBook(admin, { name: 'ราคาส่ง', tier: 'wholesale', priority: 100 });
  await setEntries(admin, w1.json.id, [{ item_id: 'WIDGET', unit_price: 80 }]);
  const w1row = await inj('GET', `/api/pricing/books/${w1.json.id}`, admin);
  ok('new price book is staged PendingApproval + inactive (maker-checker)',
    w1.json.pending === true && w1row.json.status === 'PendingApproval' && w1row.json.active === false, JSON.stringify({ status: w1row.json.status, active: w1row.json.active }));

  // ── 2. BEFORE approval the book does not price the sale → client price stands (byte-identical) ──
  const s2 = await sale({ tier: 'wholesale' });
  ok('wholesale sale BEFORE approval → subtotal 100 (inactive book ignored, byte-identical), revenue 4000=100',
    near(s2.json.subtotal, 100) && near(await revOf(s2.json.sale_no), 100), JSON.stringify({ subtotal: s2.json.subtotal }));

  // ── 3. self-approval by the maker → SOD_VIOLATION ──
  const selfAppr = await approve(admin, w1.json.id);
  ok('maker self-approving the book → 403 SOD_VIOLATION', selfAppr.status === 403 && selfAppr.json.error?.code === 'SOD_VIOLATION', `${selfAppr.status} ${selfAppr.json.error?.code}`);

  // ── 4. a DISTINCT checker activates it ──
  const okAppr = await approve(boss, w1.json.id);
  ok('a different user approves → Active', okAppr.status === 201 && okAppr.json.status === 'Active' && okAppr.json.active === true, JSON.stringify({ status: okAppr.json.status }));

  // ── 5. AFTER approval a wholesale sale uses the governed book price ──
  const s5 = await sale({ tier: 'wholesale' });
  ok('wholesale sale AFTER approval → governed book price: subtotal 80, revenue 4000=80',
    near(s5.json.subtotal, 80) && near(await revOf(s5.json.sale_no), 80), JSON.stringify({ subtotal: s5.json.subtotal }));

  // ── 6. no tier → client price (byte-identical) ──
  const s6 = await sale({});
  ok('sale with NO price_tier → subtotal 100 (client price, byte-identical)', near(s6.json.subtotal, 100), JSON.stringify({ subtotal: s6.json.subtotal }));

  // ── 7. a tier with no matching book → client price (byte-identical) ──
  const s7 = await sale({ tier: 'retail' });
  ok('sale with a tier that has no book → subtotal 100 (byte-identical)', near(s7.json.subtotal, 100), JSON.stringify({ subtotal: s7.json.subtotal }));

  // ── 8. precedence: a higher-precedence (lower priority number) wholesale book wins ──
  await activate({ name: 'ราคาส่งพิเศษ', tier: 'wholesale', priority: 10 }, [{ item_id: 'WIDGET', unit_price: 75 }]);
  const s8 = await sale({ tier: 'wholesale' });
  ok('two matching wholesale books → the priority-10 book (75) beats the priority-100 book (80)', near(s8.json.subtotal, 75), JSON.stringify({ subtotal: s8.json.subtotal }));

  // ── 9. the /book-price read endpoint returns the effective governed price ──
  const bp = await inj('GET', '/api/pricing/book-price?item_id=WIDGET&tier=wholesale', admin);
  ok('GET /book-price?tier=wholesale → 75', near(bp.json.price, 75), JSON.stringify({ price: bp.json.price }));

  // ── 10. per-branch book (no tier) prices only its own branch ──
  await activate({ name: 'ราคาสาขา B', branch_id: Number(brB.id), priority: 100 }, [{ item_id: 'WIDGET', unit_price: 70 }]);
  const s10b = await sale({ branch: Number(brB.id) });
  const s10a = await sale({ branch: Number(brA.id) });
  ok('branch-B book → a no-tier sale at branch B is 70; the same at branch A is 100 (branch-scoped)',
    near(s10b.json.subtotal, 70) && near(s10a.json.subtotal, 100), JSON.stringify({ brB: s10b.json.subtotal, brA: s10a.json.subtotal }));

  // ── 11. book-local qty break: the highest min_qty ≤ the sold qty wins ──
  await activate({ name: 'ราคา VIP', tier: 'vip', priority: 100 }, [{ item_id: 'WIDGET', unit_price: 90, min_qty: 1 }, { item_id: 'WIDGET', unit_price: 65, min_qty: 5 }]);
  const s11hi = await sale({ tier: 'vip', qty: 6 });
  const s11lo = await sale({ tier: 'vip', qty: 2 });
  ok('vip book qty break → qty 6 uses the min_qty-5 tier (65×6=390); qty 2 uses min_qty-1 (90×2=180)',
    near(s11hi.json.subtotal, 390) && near(s11lo.json.subtotal, 180), JSON.stringify({ q6: s11hi.json.subtotal, q2: s11lo.json.subtotal }));

  // ── 12. cross-tenant isolation: SHOP2's cheaper wholesale book is invisible to SHOP ──
  const [b2] = await db.insert(s.priceBooks).values({ tenantId: t2, name: 'ต่างร้าน', tier: 'wholesale', priority: 1, active: true, status: 'Active' }).returning({ id: s.priceBooks.id });
  await db.insert(s.priceBookEntries).values({ tenantId: t2, priceBookId: Number(b2.id), itemId: 'WIDGET', unitPrice: '5', minQty: 1 });
  const s12 = await sale({ tier: 'wholesale' });
  ok('SHOP2 wholesale book (5) is invisible to SHOP → SHOP wholesale sale is still 75 (tenant isolation)', near(s12.json.subtotal, 75), JSON.stringify({ subtotal: s12.json.subtotal }));

  // ── 13. R10 SoD: a non-pricing role cannot maintain a book ──
  const whBook = await mkBook(wh, { name: 'x', tier: 'wholesale' });
  ok('non-pricing role (Warehouse) POST /pricing/books → 403 (R10: price maintenance ≠ selling)', whBook.status === 403, `${whBook.status}`);

  await app.close();
  await pg.close();
  console.log('\n── docs/52 Phase 4a — customer-tier & per-branch price books (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} pos-pricebook checks failed` : `\n✅ All ${checks.length} pos-pricebook checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
