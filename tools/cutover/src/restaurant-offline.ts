/**
 * POS — Touch-register offline sync (ขายออฟไลน์ที่หน้าร้าน + ซิงค์) over PGlite:
 * the touch register (/pos/register) sells MENU items by sku through the restaurant order→checkout
 * path; when the network is down the sale is queued client-side and replayed to
 * POST /api/restaurant/offline-sync. The replay is idempotent on (tenant, client_uuid) — a re-sent
 * batch returns 'duplicate' and never double-posts the sale or its GL.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover restaurant-offline
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'roff-secret';
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
const uuid = () => `rop-${++uid}-${'y'.repeat(4)}`;

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
    { username: 'sales2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t2 },
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
  const admin = await login('admin', 'admin123');
  const sales1 = await login('sales1', 'pw1');
  const sales2 = await login('sales2', 'pw2');
  const cnt = async (sql: string) => Number(((await pg.query(sql)).rows as any[])[0].n);

  // seed a menu item the register sells (price 100 → total 107 incl VAT 7%)
  await inj('POST', '/api/menu/items', sales1, { sku: 'GP01', name: 'ผัดกะเพราไก่', price: 100, station_code: 'hot', prep_minutes: 10 });
  await inj('POST', '/api/menu/items', sales2, { sku: 'GP01', name: 'ผัดกะเพราไก่', price: 100, station_code: 'hot', prep_minutes: 10 });

  const sync = (token: string, sales: any[]) => inj('POST', '/api/restaurant/offline-sync', token, { sales });
  const op = (u: string, extra: any = {}) => ({ client_uuid: u, device_id: 'T01', captured_at: '2026-05-10T08:30:00.000Z', lines: [{ sku: 'GP01', qty: 1 }], method: 'Cash', ...extra });

  // ── 1. sync 2 register sales → both synced, distinct server-minted SALE- ──
  const u1 = uuid(), u2 = uuid();
  const b1 = await sync(sales1, [op(u1), op(u2)]);
  const r1 = b1.json.results ?? [];
  ok('Register offline: sync 2 → both synced, distinct SALE-', b1.json.summary?.synced === 2 && r1.every((r: any) => r.status === 'synced' && /^SALE-/.test(r.sale_no)) && new Set(r1.map((r: any) => r.sale_no)).size === 2, JSON.stringify(b1.json.summary));

  // ── 2. replay same batch → both duplicate, same sale_no, NO double sale/GL ──
  const b2 = await sync(sales1, [op(u1), op(u2)]);
  const salesT1 = await cnt(`SELECT count(*)::int n FROM cust_pos_sales WHERE tenant_id=${t1}`);
  const glT1 = await cnt(`SELECT count(*)::int n FROM journal_entries WHERE tenant_id=${t1} AND source='POS'`);
  ok('Register offline: replay → both duplicate, no double sale/GL (2 sales, 2 POS entries)', b2.json.summary?.duplicate === 2 && (b2.json.results ?? [])[0].sale_no === r1[0].sale_no && salesT1 === 2 && glT1 === 2, `dup=${b2.json.summary?.duplicate} sales=${salesT1} gl=${glT1}`);

  // ── 3. GL correctness: net 100 → Dr1000=107, Cr4000=100, Cr2100=7 (VAT 7%) ──
  const gl = (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source_ref='${r1[0].sale_no}'`)).rows as any[];
  const leg = (c: string, side: string) => Number(gl.filter((l) => l.account_code === c).reduce((a, l) => a + Number(l[side] || 0), 0));
  ok('Register offline: GL net 100 → Dr1000=107, Cr4000=100, Cr2100=7 (VAT)', near(leg('1000', 'debit'), 107) && near(leg('4000', 'credit'), 100) && near(leg('2100', 'credit'), 7), JSON.stringify(gl.map((l) => `${l.account_code}:${Number(l.debit) || -Number(l.credit)}`)));

  // ── 4. one bad op (unknown sku) → failed; the others sync ──
  const u3 = uuid(), u4 = uuid(), u5 = uuid();
  const b3 = await sync(sales1, [op(u3), { client_uuid: u4, device_id: 'T01', captured_at: '2026-05-10T08:31:00.000Z', lines: [{ sku: 'NOPE', qty: 1 }], method: 'Cash' }, op(u5)]);
  const r3 = b3.json.results ?? [];
  const byU = (u: string) => r3.find((r: any) => r.client_uuid === u);
  const failRow = await cnt(`SELECT count(*)::int n FROM pos_offline_sync WHERE client_uuid='${u4}' AND status='failed' AND sale_no IS NULL`);
  ok('Register offline: bad op failed (failed audit row), neighbours synced', byU(u3)?.status === 'synced' && byU(u4)?.status === 'failed' && !!byU(u4)?.error && byU(u5)?.status === 'synced' && failRow === 1, `${JSON.stringify(r3.map((r: any) => r.status))} fail=${failRow}`);

  // ── 5. same client_uuid twice in one batch → 1 synced + 1 duplicate (one sale) ──
  const u6 = uuid();
  const b5 = await sync(sales1, [{ ...op(u6), client_seq: 1 }, { ...op(u6), client_seq: 2 }]);
  ok('Register offline: same uuid twice in one batch → 1 synced + 1 duplicate', b5.json.summary?.synced === 1 && b5.json.summary?.duplicate === 1, JSON.stringify(b5.json.summary));

  // ── 6. RLS: T2 reusing T1's client_uuid → synced (dedup is tenant-scoped) ──
  const b6 = await sync(sales2, [op(u1)]);
  const r6 = (b6.json.results ?? [])[0];
  const t2rows = await cnt(`SELECT count(*)::int n FROM pos_offline_sync WHERE tenant_id=${t2}`);
  ok('Register offline: T2 reusing T1 uuid → synced (tenant-scoped dedup)', r6?.status === 'synced' && /^SALE-/.test(r6?.sale_no ?? '') && t2rows === 1, `${r6?.status} t2rows=${t2rows}`);

  // ── 7. discount_pct flows through (net 100, 10% off → taxable 90, vat 6.30, total 96.30) ──
  const u7 = uuid();
  const b7 = await sync(sales1, [op(u7, { discount_pct: 10 })]);
  const sale7 = (b7.json.results ?? [])[0]?.sale_no;
  const t7 = (await pg.query(`SELECT tax_amount, total FROM cust_pos_sales WHERE sale_no='${sale7}'`)).rows as any[];
  ok('Register offline: discount_pct applied (10% off 100 → vat 6.30, total 96.30)', near(t7[0]?.tax_amount, 6.3) && near(t7[0]?.total, 96.3), JSON.stringify(t7[0]));

  // ── 8. trial balance balanced ──
  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  ok('Register offline: trial balance balanced', tb.totals?.balanced === true, JSON.stringify(tb.totals ?? {}));

  console.log('\n── POS Touch-register offline sync (ขายออฟไลน์ที่หน้าร้าน + ซิงค์) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} register-offline checks failed` : `\n✅ All ${checks.length} register-offline checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
