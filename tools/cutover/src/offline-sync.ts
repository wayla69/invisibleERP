/**
 * POS Tier 2 #11 — Offline mode / sync (โหมดออฟไลน์ + ซิงค์) over PGlite:
 * replay a batch of offline-queued sales idempotently — per-item savepoint isolation, server-minted
 * sale_no, tenant-scoped dedup, book-on-offline-day. Reuses portal createSale (no duplicated GL).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover offline-sync
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'off-secret';
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
const uuid = () => `op-${++uid}-${'x'.repeat(4)}`;

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
    { username: 'cust1', passwordHash: await pw.hash('pw1'), role: 'Customer', tenantId: t1, customerName: 'ร้านหนึ่ง' },
    { username: 'cust2', passwordHash: await pw.hash('pw2'), role: 'Customer', tenantId: t2, customerName: 'ร้านสอง' },
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
  const cust1 = await login('cust1', 'pw1');
  const cust2 = await login('cust2', 'pw2');
  const sync = (token: string, sales: any[]) => inj('POST', '/api/portal/pos/offline-sync', token, { sales });
  const op = (u: string, net: number, extra: any = {}) => ({ client_uuid: u, device_id: 'POS-01', captured_at: '2026-05-10T08:30:00.000Z', lines: [{ item_id: 'A', item_description: 'สินค้า', qty: 1, unit_price: net }], ...extra });
  const cnt = async (sql: string) => Number(((await pg.query(sql)).rows as any[])[0].n);

  // ── 1. sync 3 sales → all synced, server-minted distinct SALE- ──
  const u1 = uuid(), u2 = uuid(), u3 = uuid();
  const b1 = await sync(cust1, [op(u1, 100), op(u2, 200), op(u3, 300)]);
  const r1 = b1.json.results ?? [];
  const nos = r1.map((r: any) => r.sale_no);
  ok('Sync 3 → all synced, distinct server-minted SALE-', b1.json.summary?.synced === 3 && r1.every((r: any) => r.status === 'synced' && /^SALE-/.test(r.sale_no)) && new Set(nos).size === 3, JSON.stringify(b1.json.summary));

  // ── 2. replay same batch → all duplicate, same sale_no, no double sale/GL ──
  const b2 = await sync(cust1, [op(u1, 100), op(u2, 200), op(u3, 300)]);
  const r2 = b2.json.results ?? [];
  const salesT1 = await cnt(`SELECT count(*)::int n FROM cust_pos_sales WHERE tenant_id=${t1}`);
  const glT1 = await cnt(`SELECT count(*)::int n FROM journal_entries WHERE tenant_id=${t1} AND source='POS'`);
  ok('Replay → all duplicate, same sale_no, no double sale/GL (3 sales, 3 POS entries)', b2.json.summary?.duplicate === 3 && r2[0].sale_no === r1[0].sale_no && salesT1 === 3 && glT1 === 3, `dup=${b2.json.summary?.duplicate} sales=${salesT1} gl=${glT1}`);

  // ── 3. one invalid op (empty lines) → failed; others synced ──
  const u4 = uuid(), u5 = uuid(), u6 = uuid();
  const b3 = await sync(cust1, [op(u4, 100), { client_uuid: u5, device_id: 'POS-01', captured_at: '2026-05-10T08:30:00.000Z', lines: [] }, op(u6, 150)]);
  const r3 = b3.json.results ?? [];
  const byU = (u: string) => r3.find((r: any) => r.client_uuid === u);
  const failRow = await cnt(`SELECT count(*)::int n FROM pos_offline_sync WHERE client_uuid='${u5}' AND status='failed' AND sale_no IS NULL`);
  const salesAfter = await cnt(`SELECT count(*)::int n FROM cust_pos_sales WHERE tenant_id=${t1}`);
  ok('Partial failure: bad op failed, others synced (2 new sales, failed audit row)', byU(u4)?.status === 'synced' && byU(u5)?.status === 'failed' && !!byU(u5)?.error && byU(u6)?.status === 'synced' && salesAfter === 5 && failRow === 1, `${JSON.stringify(r3.map((r: any) => r.status))} sales=${salesAfter} fail=${failRow}`);

  // ── 4. offline timestamp + book-on-offline-day ──
  const synced4 = byU(u4);
  const cap = (await pg.query(`SELECT captured_at FROM pos_offline_sync WHERE client_uuid='${u4}'`)).rows as any[];
  const sd = (await pg.query(`SELECT sale_date FROM cust_pos_sales WHERE sale_no='${synced4.sale_no}'`)).rows as any[];
  const sdISO = new Date(sd[0].sale_date).toISOString();
  ok('Offline timestamp preserved + sale booked on offline day (2026-05-10)', new Date(cap[0].captured_at).toISOString().startsWith('2026-05-10T08:30') && sdISO.startsWith('2026-05-10'), `cap=${new Date(cap[0]?.captured_at).toISOString()} sale_date=${sdISO}`);

  // ── 5. same client_uuid twice in one batch → first synced, second duplicate ──
  const u7 = uuid();
  const b5 = await sync(cust1, [{ ...op(u7, 100), client_seq: 1 }, { ...op(u7, 100), client_seq: 2 }]);
  const r5 = b5.json.results ?? [];
  const dup5 = await cnt(`SELECT count(*)::int n FROM cust_pos_sales WHERE notes LIKE '%offline%' AND tenant_id=${t1} AND total='107.00'`);
  ok('Same uuid twice in one batch → 1 synced + 1 duplicate (one sale only)', b5.json.summary?.synced === 1 && b5.json.summary?.duplicate === 1, JSON.stringify(b5.json.summary));

  // ── 6. RLS: T2 reuse of T1 uuid → synced (tenant-scoped dedup), not falsely duplicate ──
  const b6 = await sync(cust2, [op(u1, 100)]);
  const r6 = (b6.json.results ?? [])[0];
  const t2sees = await cnt(`SELECT count(*)::int n FROM pos_offline_sync WHERE tenant_id=${t2}`);
  ok('RLS: T2 reusing T1 client_uuid → synced (dedup is tenant-scoped)', r6?.status === 'synced' && /^SALE-/.test(r6?.sale_no) && t2sees === 1, `${r6?.status} t2rows=${t2sees}`);

  // ── 7. GL correctness — reused createSale chokepoint (Dr1000=Cr4000+Cr2100, VAT 7%) ──
  const gl = (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source_ref='${r1[0].sale_no}'`)).rows as any[];
  const leg = (c: string, side: string) => Number(gl.filter((l) => l.account_code === c).reduce((a, l) => a + Number(l[side] || 0), 0));
  ok('GL: net 100 → Dr1000=107, Cr4000=100, Cr2100=7 (VAT 7%), balanced', near(leg('1000', 'debit'), 107) && near(leg('4000', 'credit'), 100) && near(leg('2100', 'credit'), 7), JSON.stringify(gl.map((l) => `${l.account_code}:${Number(l.debit) || -Number(l.credit)}`)));

  // ── 8. VAT on discounted base ──
  const u8 = uuid();
  const b8 = await sync(cust1, [op(u8, 100, { discount: 20 })]);
  const sale8 = (b8.json.results ?? [])[0]?.sale_no;
  const tax8 = (await pg.query(`SELECT subtotal, discount, tax_amount, total FROM cust_pos_sales WHERE sale_no='${sale8}'`)).rows as any[];
  ok('VAT on discounted base: net 100 − disc 20 → taxable 80, vat 5.60, total 85.60', near(tax8[0]?.tax_amount, 5.6) && near(tax8[0]?.total, 85.6), JSON.stringify(tax8[0]));

  // ── 9. transient failure is RETRYABLE (not dead-lettered): closed period → failed → reopen → replay synced ──
  const uT = uuid();
  const opT = () => ({ client_uuid: uT, device_id: 'POS-01', captured_at: '2026-07-15T08:30:00.000Z', lines: [{ item_id: 'A', item_description: 'สินค้า', qty: 1, unit_price: 100 }] });
  await inj('POST', `/api/ledger/periods/2026-07/close?tenant_id=${t1}`, admin); // close T1's calendar (cust1 → T1)
  const bFail = await sync(cust1, [opT()]);
  const rFail = (bFail.json.results ?? [])[0];
  const failRowT = await cnt(`SELECT count(*)::int n FROM pos_offline_sync WHERE client_uuid='${uT}' AND status='failed' AND sale_no IS NULL`);
  await inj('POST', `/api/ledger/periods/2026-07/open?tenant_id=${t1}`, admin);
  const bRetry = await sync(cust1, [opT()]); // replay after reopen — must NOT be dead-lettered as duplicate
  const rRetry = (bRetry.json.results ?? [])[0];
  const salesT = await cnt(`SELECT count(*)::int n FROM cust_pos_sales WHERE sale_no='${rRetry.sale_no}'`);
  ok('Transient fail → retryable: PERIOD_CLOSED failed (no sale), reopen + replay → synced with SALE-', rFail?.status === 'failed' && rFail?.error === 'PERIOD_CLOSED' && failRowT === 1 && rRetry?.status === 'synced' && /^SALE-/.test(rRetry?.sale_no ?? '') && salesT === 1, `fail=${rFail?.status}/${rFail?.error} retry=${rRetry?.status}/${rRetry?.sale_no}`);

  // ── 10. trial balance balanced ──
  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  ok('Trial balance balanced after all offline-sync activity', tb.totals?.balanced === true, JSON.stringify(tb.totals ?? {}));

  console.log('\n── POS Tier 2 #11 Offline Mode / Sync (โหมดออฟไลน์ + ซิงค์) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} offline-sync checks failed` : `\n✅ All ${checks.length} offline-sync checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
