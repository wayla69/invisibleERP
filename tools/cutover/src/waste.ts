/**
 * Inventory — Waste / spoilage logging (ของเสีย/ทิ้ง) over PGlite (W1):
 * reason-coded ingredient waste decrements customer_inventory and (when costed) posts Dr 5810 / Cr 1200;
 * by-reason analytics; perpetual-tracked items are pushed to the INV-07 write-off (no double-handling).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover waste
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'waste-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'wh1', passwordHash: await pw.hash('pw1'), role: 'Warehouse', tenantId: t1 },
    { username: 'wh2', passwordHash: await pw.hash('pw2'), role: 'Warehouse', tenantId: t2 },
  ]).onConflictDoNothing();
  // seed ingredient stock for T1: 100 units of PORK on hand
  await db.insert(s.customerInventory).values({ tenantId: t1, itemId: 'PORK', itemDescription: 'หมูสับ', uom: 'kg', currentStock: '100' });

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
  const wh1 = await login('wh1', 'pw1');
  const wh2 = await login('wh2', 'pw2');
  const admin = await login('admin', 'admin123');
  const gl = async (code: string) => Number(((await pg.query(`SELECT coalesce(sum(jl.debit)-sum(jl.credit),0) v FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.account_code='${code}' AND je.status='Posted' AND je.tenant_id=${t1}`)).rows as any[])[0].v);
  const stock = async () => Number(((await pg.query(`SELECT current_stock v FROM customer_inventory WHERE tenant_id=${t1} AND item_id='PORK'`)).rows as any[])[0].v);

  // ── 1. costed waste → Dr 5810 / Cr 1200, stock down, waste_no ──
  const w1 = await inj('POST', '/api/inventory/waste', wh1, { item_id: 'PORK', qty: 5, reason_code: 'spoilage', unit_cost: 80 });
  ok('Waste: spoilage 5×80 → total 400, WASTE- + JE-', /^WASTE-/.test(w1.json.waste_no ?? '') && near(w1.json.total_cost, 400) && /^JE-/.test(w1.json.journal_no ?? ''), JSON.stringify(w1.json).slice(0, 110));
  ok('Waste: GL Dr 5810 Waste 400 / Cr 1200 Inventory 400', near(await gl('5810'), 400) && near(await gl('1200'), -400), `5810=${await gl('5810')} 1200=${await gl('1200')}`);
  ok('Waste: ingredient stock 100 → 95', near(await stock(), 95), `stock=${await stock()}`);

  // ── 2. uncosted waste (no unit_cost) → logged, stock down, NO GL ──
  const w2 = await inj('POST', '/api/inventory/waste', wh1, { item_id: 'PORK', qty: 3, reason_code: 'prep_error' });
  ok('Waste: uncosted prep_error logged, no JE, stock → 92', w2.json.journal_no == null && near(w2.json.total_cost, 0) && near(await stock(), 92), `je=${w2.json.journal_no} stock=${await stock()}`);

  // ── 3. validation: bad reason / non-positive qty ──
  const badR = await inj('POST', '/api/inventory/waste', wh1, { item_id: 'PORK', qty: 1, reason_code: 'nonsense' });
  const badQ = await inj('POST', '/api/inventory/waste', wh1, { item_id: 'PORK', qty: 0, reason_code: 'damage' });
  ok('Waste: invalid reason + non-positive qty rejected (400)', badR.status === 400 && badQ.status === 400, `${badR.status}/${badQ.status}`);

  // ── 4. perpetual-tracked item is pushed to the INV-07 write-off (no waste-log double-handling) ──
  await db.insert(s.invBalances).values({ tenantId: t1, itemId: 'WIDGET', locationId: 'WH-MAIN', qty: '10', avgCost: '50', totalValue: '500', costingMethod: 'moving_avg' });
  const perp = await inj('POST', '/api/inventory/waste', wh1, { item_id: 'WIDGET', qty: 1, reason_code: 'damage', unit_cost: 50 });
  ok('Waste: perpetual item rejected → USE_WRITEOFF (400)', perp.status === 400 && perp.json.error?.code === 'USE_WRITEOFF', `${perp.status} ${perp.json.error?.code}`);

  // ── 5. analytics: by-reason totals ──
  const list = await inj('GET', '/api/inventory/waste', wh1);
  const spoil = (list.json.by_reason ?? []).find((r: any) => r.reason === 'spoilage');
  ok('Waste analytics: total cost 400, by-reason spoilage cost 400 / prep_error cost 0', near(list.json.total_cost, 400) && near(spoil?.cost, 400) && list.json.count === 2, JSON.stringify(list.json.by_reason));

  // ── 6. RLS: T2 sees none of T1's waste ──
  const t2list = await inj('GET', '/api/inventory/waste', wh2);
  ok('RLS: T2 sees 0 of T1 waste', t2list.json.count === 0, `t2count=${t2list.json.count}`);

  // ── 7. trial balance balanced ──
  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  ok('Trial balance balanced after waste postings', tb.totals?.balanced === true, JSON.stringify(tb.totals ?? {}));

  await app.close();
  await pg.close();
  console.log('\n── Inventory Waste / spoilage logging (ของเสีย/ทิ้ง) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} waste checks failed` : `\n✅ All ${checks.length} waste checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
