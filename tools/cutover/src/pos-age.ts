/**
 * docs/52 Phase 3c — age-restricted sale gate. An item with `items.min_age > 0` (alcohol/tobacco) may not be
 * sold without an age check: the cashier attests they verified ID (`age_ack`), or a `customer_birthdate`
 * proves the buyer meets the highest required age — else the sale is refused (`AGE_VERIFICATION_REQUIRED` /
 * `AGE_BELOW_MINIMUM`). The sale records `age_verified`. A cart with no restricted item is byte-identical.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover pos-age
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
  await db.insert(s.tenants).values([{ code: 'SHOP', name: 'ร้านสะดวกซื้อ', industry: 'retail' }]).onConflictDoNothing();
  const t = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'SHOP')))[0].id);
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('pw1'), role: 'Admin', tenantId: t },
    { username: 'wh', passwordHash: await pw.hash('pw1'), role: 'Warehouse', tenantId: t },
  ]).onConflictDoNothing();
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: false, pointsPerBaht: '0' }).onConflictDoNothing();
  await db.insert(s.items).values([
    { itemId: 'BEER', itemDescription: 'เบียร์', supplyType: 'goods', uom: 'ขวด', unitPrice: '100', minAge: 20 },
    { itemId: 'TOY', itemDescription: 'ของเล่น', supplyType: 'goods', uom: 'ชิ้น', unitPrice: '100', minAge: 0 },
  ]).onConflictDoNothing();
  await db.insert(s.customerInventory).values([
    { tenantId: t, itemId: 'BEER', itemDescription: 'เบียร์', uom: 'ขวด', currentStock: '100' },
    { tenantId: t, itemId: 'TOY', itemDescription: 'ของเล่น', uom: 'ชิ้น', currentStock: '100' },
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
  const login = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'pw1' })).json.token as string;
  const admin = await login('admin');
  const sale = (body: any) => inj('POST', '/api/pos/sales', admin, body);
  const stockOf = async (itemId: string) => Number((await db.select().from(s.customerInventory).where(and(eq(s.customerInventory.tenantId, t), eq(s.customerInventory.itemId, itemId))))[0]?.currentStock ?? 0);
  const ageVerifiedOf = async (saleNo: string) => (await pg.query(`SELECT age_verified FROM cust_pos_sales WHERE sale_no='${saleNo}'`)).rows[0] as any;
  const glOf = async (saleNo: string) => (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source='POS' AND je.source_ref='${saleNo}'`)).rows as any[];
  const cr = (gl: any[], acct: string) => gl.filter((l) => l.account_code === acct).reduce((a, l) => a + Number(l.credit || 0), 0);
  const BEER = [{ item_id: 'BEER', qty: 1, unit_price: 100 }];

  // ── 1. age-restricted item with NO age info → refused ──
  const s1 = await sale({ items: BEER });
  ok('age-restricted sale with no age info → 400 AGE_VERIFICATION_REQUIRED (nothing persisted)',
    s1.status === 400 && s1.json.error?.code === 'AGE_VERIFICATION_REQUIRED', `${s1.status} ${s1.json.error?.code}`);

  // ── 2. cashier attests (age_ack) → sells, age_verified=true, byte-identical GL ──
  const s2 = await sale({ items: BEER, age_ack: true });
  const g2 = await glOf(s2.json.sale_no);
  ok('cashier attests age_ack → sale ok, age_verified=true, stock 100→99, revenue → 4000 (byte-identical)',
    /^SALE-/.test(s2.json.sale_no ?? '') && (await ageVerifiedOf(s2.json.sale_no))?.age_verified === true && near(await stockOf('BEER'), 99) && near(cr(g2, '4000'), 100),
    JSON.stringify({ sale: s2.json.sale_no, verified: (await ageVerifiedOf(s2.json.sale_no))?.age_verified }));

  // ── 3. birthdate proving age ≥ 20 → sells ──
  const s3 = await sale({ items: BEER, customer_birthdate: '2000-01-01' });
  ok('customer_birthdate 2000-01-01 (age ≥ 20) → sale ok, age_verified=true',
    /^SALE-/.test(s3.json.sale_no ?? '') && (await ageVerifiedOf(s3.json.sale_no))?.age_verified === true, JSON.stringify({ sale: s3.json.sale_no }));

  // ── 4. birthdate proving age < 20 → refused ──
  const s4 = await sale({ items: BEER, customer_birthdate: '2010-01-01' });
  ok('customer_birthdate 2010-01-01 (age < 20) → 400 AGE_BELOW_MINIMUM',
    s4.status === 400 && s4.json.error?.code === 'AGE_BELOW_MINIMUM', `${s4.status} ${s4.json.error?.code}`);

  // ── 5. mixed cart (restricted + unrestricted) still needs the age check ──
  const s5noack = await sale({ items: [...BEER, { item_id: 'TOY', qty: 1, unit_price: 100 }] });
  ok('mixed cart (BEER + TOY) with no age info → still 400 AGE_VERIFICATION_REQUIRED',
    s5noack.status === 400 && s5noack.json.error?.code === 'AGE_VERIFICATION_REQUIRED', `${s5noack.status} ${s5noack.json.error?.code}`);
  const s5 = await sale({ items: [...BEER, { item_id: 'TOY', qty: 1, unit_price: 100 }], age_ack: true });
  ok('mixed cart with age_ack → sells, age_verified=true', /^SALE-/.test(s5.json.sale_no ?? '') && (await ageVerifiedOf(s5.json.sale_no))?.age_verified === true, JSON.stringify({ sale: s5.json.sale_no }));

  // ── 6. unrestricted-only cart is byte-identical — no age needed, age_verified=false ──
  const s6 = await sale({ items: [{ item_id: 'TOY', qty: 1, unit_price: 100 }] });
  ok('unrestricted item only → sells with no age info, age_verified=false (byte-identical), revenue → 4000',
    /^SALE-/.test(s6.json.sale_no ?? '') && (await ageVerifiedOf(s6.json.sale_no))?.age_verified === false && near(cr(await glOf(s6.json.sale_no), '4000'), 100),
    JSON.stringify({ verified: (await ageVerifiedOf(s6.json.sale_no))?.age_verified }));

  // ── 7. a non-selling role cannot ring a sale ──
  const whr = await inj('POST', '/api/pos/sales', await login('wh'), { items: [{ item_id: 'TOY', qty: 1, unit_price: 100 }] });
  ok('non-selling role (Warehouse) → 403', whr.status === 403, `${whr.status}`);

  await app.close();
  await pg.close();
  console.log('\n── docs/52 Phase 3c — age-restricted sale gate (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} pos-age checks failed` : `\n✅ All ${checks.length} pos-age checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
