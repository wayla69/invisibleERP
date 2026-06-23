/**
 * Multi-branch POS (สาขา + ส่งข้อมูลเข้า HQ) over PGlite: a tenant's outlets sell independently
 * (incl. offline replay) tagged by branch, and roll up to the tenant's HQ for consolidation; HQ serves
 * a master-data bundle for offline caching. Branch ops are tenant-scoped (RLS isolation proven).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover branch
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'branch-secret';
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
let uid = 0;
const uuid = () => `b-op-${++uid}`;

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
  const [t1, t2] = [await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: await tid('HQ') },
    { username: 'cust1', passwordHash: await pw.hash('pw1'), role: 'Customer', tenantId: t1, customerName: 'ร้านหนึ่ง' },
    { username: 'cust2', passwordHash: await pw.hash('pw2'), role: 'Customer', tenantId: t2, customerName: 'ร้านสอง' },
  ]).onConflictDoNothing();
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: true, pointsPerBaht: '1.0', bahtPerPoint: '0.1' }).onConflictDoNothing();
  // T1 catalog (master bundle) + inventory (portal POS decrement)
  await db.insert(s.customerInventory).values({ tenantId: t1, itemId: 'A', itemDescription: 'สินค้า A', uom: 'EA', currentStock: '100', reorderPoint: '5', reorderQty: '20' });
  await db.insert(s.customerItems).values([
    { tenantId: t1, itemId: 'A', itemName: 'สินค้า A', category: 'Drinks', unitPrice: '100', uom: 'EA' },
    { tenantId: t1, itemId: 'B', itemName: 'สินค้า B', category: 'Food', unitPrice: '50', uom: 'EA' },
  ]);
  await db.insert(s.priceList).values({ listName: 'Standard', tenantId: t1, itemId: 'A', basePrice: '100', specialPrice: '90', active: true });
  await db.insert(s.promotions).values({ tenantId: t1, promoId: 'PRM-T1-1', promoName: 'Songkran', promoType: 'Percent', discountPct: '10', active: true });

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
  const cust1 = await login('cust1', 'pw1');
  const cust2 = await login('cust2', 'pw2');
  const cnt = async (q: string) => Number(((await pg.query(q)).rows as any[])[0].n);
  const one = async (q: string) => ((await pg.query(q)).rows as any[])[0];

  // ── 1. create two branches under T1 (HQ + outlet); distinct ids; 201 ──
  const bHq = await inj('POST', '/api/branches', cust1, { code: 'BKK01', name: 'Bangkok HQ', is_hq: true });
  const bCnx = await inj('POST', '/api/branches', cust1, { code: 'CNX01', name: 'Chiang Mai' });
  const hqId = bHq.json.id, cnxId = bCnx.json.id;
  ok('Create 2 branches → 201, distinct ids, HQ flagged', (bHq.status === 201 || bHq.status === 200) && (bCnx.status === 201 || bCnx.status === 200) && hqId && cnxId && hqId !== cnxId && bHq.json.is_hq === true, `hq=${hqId} cnx=${cnxId}`);

  // ── 2. duplicate code within tenant → 409 ──
  const dup = await inj('POST', '/api/branches', cust1, { code: 'BKK01', name: 'dup' });
  ok('Duplicate branch code within tenant → 409 BRANCH_EXISTS', dup.status === 409 && dup.json?.error?.code === 'BRANCH_EXISTS', `status=${dup.status} ${JSON.stringify(dup.json?.error ?? dup.json)}`);

  // ── 3. list branches (T1) → 2, HQ first ──
  const list1 = await inj('GET', '/api/branches', cust1);
  ok('List branches (T1) → 2, HQ ordered first', list1.json.count === 2 && list1.json.branches?.[0]?.is_hq === true, JSON.stringify(list1.json.branches?.map((b: any) => b.code)));

  // ── 4. online portal sale tagged to BKK01 → persisted branch_id ──
  const onl = await inj('POST', '/api/portal/pos/sales', cust1, { items: [{ item_id: 'A', qty: 1, unit_price: 100 }], branch_id: hqId });
  const onlRow = await one(`SELECT branch_id, total FROM cust_pos_sales WHERE sale_no='${onl.json.sale_no}'`);
  ok('Online sale tagged to branch BKK01 (branch_id persisted, total 107)', onl.status === 201 || onl.status === 200 ? Number(onlRow.branch_id) === Number(hqId) && near(onlRow.total, 107) : false, `branch_id=${onlRow?.branch_id} total=${onlRow?.total}`);

  // ── 5. invalid branch_id → 400 BRANCH_NOT_FOUND (no phantom sale) ──
  const before = await cnt(`SELECT count(*)::int n FROM cust_pos_sales WHERE tenant_id=${t1}`);
  const bad = await inj('POST', '/api/portal/pos/sales', cust1, { items: [{ item_id: 'A', qty: 1, unit_price: 100 }], branch_id: 999999 });
  const after = await cnt(`SELECT count(*)::int n FROM cust_pos_sales WHERE tenant_id=${t1}`);
  ok('Invalid branch_id → 400 BRANCH_NOT_FOUND, no sale created', bad.status === 400 && bad.json?.error?.code === 'BRANCH_NOT_FOUND' && after === before, `status=${bad.status} before=${before} after=${after}`);

  // ── 6. offline sync tagged by branch → synced, branch_id on sale + on offline ledger ──
  const u1 = uuid(), u2 = uuid();
  const op = (u: string, net: number, branch: number) => ({ client_uuid: u, branch_id: branch, device_id: 'POS-01', captured_at: '2026-05-10T08:30:00.000Z', lines: [{ item_id: 'A', qty: 1, unit_price: net }] });
  const sync = await inj('POST', '/api/portal/pos/offline-sync', cust1, { sales: [op(u1, 100, hqId), op(u2, 200, cnxId)] });
  const r = sync.json.results ?? [];
  const saleHq = r.find((x: any) => x.client_uuid === u1)?.sale_no;
  const saleCnx = r.find((x: any) => x.client_uuid === u2)?.sale_no;
  const offBranchHq = await one(`SELECT branch_id FROM pos_offline_sync WHERE client_uuid='${u1}'`);
  const saleBranchCnx = await one(`SELECT branch_id FROM cust_pos_sales WHERE sale_no='${saleCnx}'`);
  ok('Offline sync tags branch on sale + offline ledger (2 synced)', sync.json.summary?.synced === 2 && Number(offBranchHq.branch_id) === Number(hqId) && Number(saleBranchCnx.branch_id) === Number(cnxId) && !!saleHq, `synced=${sync.json.summary?.synced} offHq=${offBranchHq?.branch_id} saleCnx=${saleBranchCnx?.branch_id}`);

  // ── 7. an untagged sale shows up under branch "(none)" ──
  await inj('POST', '/api/portal/pos/sales', cust1, { items: [{ item_id: 'A', qty: 1, unit_price: 50 }] });

  // ── 8. HQ consolidation: per-branch totals (BKK01: online 107 + offline 107 = 214 / 2 orders; CNX01: 214 / 1) ──
  const con = await inj('GET', '/api/branches/consolidated', cust1);
  const byCode = (c: string) => (con.json.branches ?? []).find((b: any) => b.code === c);
  const cHq = byCode('BKK01'), cCnx = byCode('CNX01'), cNone = byCode('(none)');
  ok('Consolidated per-branch totals correct (BKK01 2/214, CNX01 1/214, (none) 1/53.5)',
    cHq?.orders === 2 && near(cHq?.total_sales, 214) && cCnx?.orders === 1 && near(cCnx?.total_sales, 214) && cNone?.orders === 1 && near(cNone?.total_sales, 53.5),
    JSON.stringify(con.json.branches?.map((b: any) => `${b.code}:${b.orders}/${b.total_sales}`)));
  ok('Consolidated grand totals (4 orders, 481.50)', con.json.totals?.orders === 4 && near(con.json.totals?.total_sales, 481.5), JSON.stringify(con.json.totals));

  // ── 9. RLS isolation: T2 cannot see T1's branches nor its consolidated sales ──
  const list2 = await inj('GET', '/api/branches', cust2);
  const con2 = await inj('GET', '/api/branches/consolidated', cust2);
  ok('RLS: T2 sees none of T1 branches; T2 consolidation empty', list2.json.count === 0 && (con2.json.branches?.length ?? 0) === 0, `t2branches=${list2.json.count} t2con=${con2.json.branches?.length}`);

  // ── 10. T2 may reuse the same branch code (uniqueness is per-tenant) ──
  const b2 = await inj('POST', '/api/branches', cust2, { code: 'BKK01', name: 'T2 Bangkok' });
  ok('T2 can create code BKK01 (uniqueness is per-tenant)', b2.status === 201 || b2.status === 200, `status=${b2.status}`);

  // ── 11. master bundle for offline caching (catalog + prices + promos, tenant-scoped) ──
  const mb = await inj('GET', '/api/branches/master-bundle', cust1);
  ok('Master bundle returns T1 catalog (2 items, 1 price, 1 promo)', mb.json.counts?.items === 2 && mb.json.counts?.price_list === 1 && mb.json.counts?.promotions === 1, JSON.stringify(mb.json.counts));
  const mb2 = await inj('GET', '/api/branches/master-bundle', cust2);
  ok('Master bundle is tenant-scoped (T2 sees none of T1 catalog)', (mb2.json.counts?.items ?? 0) === 0 && (mb2.json.counts?.promotions ?? 0) === 0, JSON.stringify(mb2.json.counts));

  // ── 12. trial balance still balanced after branch-tagged sales ──
  const admin = await login('admin', 'admin123');
  // validation (W5/M8): branch POST is now Zod-validated — a malformed body is rejected 400, not 500
  const badBranch = await inj('POST', '/api/branches', cust1, { code: '', name: 123 });
  ok('Branch create with bad body → 400 (Zod validation, not 500)', badBranch.status === 400, `status=${badBranch.status}`);
  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  ok('Trial balance balanced after branch activity', tb.totals?.balanced === true, JSON.stringify(tb.totals ?? {}));

  console.log('\n── Multi-branch POS (สาขา + ส่งข้อมูลเข้า HQ) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} branch checks failed` : `\n✅ All ${checks.length} branch checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
