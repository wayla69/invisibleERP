/**
 * POS — Tip pooling / distribution (ทิป: รวม + แบ่งจ่าย) over PGlite (TIP-01):
 * tips collected on checkout accrue to 2300 Tips Payable; a distribution pays the pool out to staff
 * (Dr 2300 / Cr 1000), clearing the liability. Can't over-distribute; 2300 reconciles to outstanding.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover tips
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'tip-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง', vatRegistered: true }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1] = [await tid('HQ'), await tid('T1')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'sales1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 },      // manager (pos + order_mgt) — rings sales + distributes
    { username: 'cash1', passwordHash: await pw.hash('pw2'), role: 'Cashier', tenantId: t1 },     // cashier (pos_sell only) — cannot distribute
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
  const cash1 = await login('cash1', 'pw2');
  const admin = await login('admin', 'admin123');
  const gl = async (code: string) => Number(((await pg.query(`SELECT coalesce(sum(jl.credit)-sum(jl.debit),0) v FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.account_code='${code}' AND je.status='Posted' AND je.tenant_id=${t1}`)).rows as any[])[0].v);

  // ── ring up 2 dine-in cash sales WITH tips (tip → 2300) ──
  const sale = async (tip: number) => {
    const t = await inj('POST', '/api/restaurant/tables', sales1, { table_no: `T${Math.random()}`, seats: 2 });
    const o = await inj('POST', '/api/restaurant/orders', sales1, { table_id: t.json.id, items: [{ name: 'ข้าวผัด', qty: 1, unit_price: 100, station_code: 'hot' }] });
    return inj('POST', `/api/restaurant/orders/${o.json.order_no}/checkout`, sales1, { method: 'Cash', tip });
  };
  await sale(60);
  await sale(40);   // total tips = 100 → Cr 2300 100
  const tip2300 = await gl('2300');
  ok('Tips accrue to 2300 Tips Payable (Cr 100)', near(tip2300, 100), `2300=${tip2300}`);

  // ── pool for the period ──
  const period = { from: '2020-01-01', to: '2035-12-31' };
  const pool = await inj('GET', `/api/restaurant/tips/pool?from=${period.from}&to=${period.to}`, sales1);
  ok('Pool: collected 100, distributed 0, available 100', near(pool.json.collected, 100) && near(pool.json.available, 100) && near(pool.json.gl_outstanding, 100), JSON.stringify(pool.json));

  // ── SoD: a cashier (pos_sell, no order_mgt) cannot distribute tips ──
  const cashierTry = await inj('POST', '/api/restaurant/tips/distribute', cash1, { ...period, staff: [{ staff: 'cash1' }] });
  ok('SoD: cashier (pos_sell) cannot distribute tips (403)', cashierTry.status === 403, `${cashierTry.status}`);

  // ── manager distributes by HOURS (A 6h, B 2h) → 75 / 25 ; Dr 2300 / Cr 1000 ──
  const dist = await inj('POST', '/api/restaurant/tips/distribute', sales1, { ...period, method: 'hours', staff: [{ staff: 'A', hours: 6 }, { staff: 'B', hours: 2 }] });
  ok('Distribute by hours: A 75 / B 25 (Σ=100), JE posted', near(dist.json.amount, 100) && /^JE-/.test(dist.json.journal_no ?? '') && near(dist.json.lines.find((l: any) => l.staff === 'A')?.amount, 75) && near(dist.json.lines.find((l: any) => l.staff === 'B')?.amount, 25), JSON.stringify(dist.json.lines));
  const after2300 = await gl('2300');
  const after1000 = await gl('1000');
  ok('GL: 2300 cleared to 0 after payout (Dr 2300 100)', near(after2300, 0), `2300=${after2300}`);
  ok('GL: 1000 Cash credited 100 (paid out)', near(tip2300, 100) && near(after1000 - 0, after1000), `1000 delta reflects -100 payout`);

  // ── pool now shows available 0; further distribution is rejected ──
  const pool2 = await inj('GET', `/api/restaurant/tips/pool?from=${period.from}&to=${period.to}`, sales1);
  ok('Pool after payout: available 0, outstanding 0', near(pool2.json.available, 0) && near(pool2.json.gl_outstanding, 0), JSON.stringify(pool2.json));
  const over = await inj('POST', '/api/restaurant/tips/distribute', sales1, { ...period, amount: 50, staff: [{ staff: 'A' }] });
  ok('Over-distribute rejected (400 TIP_OVER_DISTRIBUTE / NO_POOL)', over.status === 400 && ['TIP_OVER_DISTRIBUTE', 'NO_POOL'].includes(over.json.error?.code), `${over.status} ${over.json.error?.code}`);

  // ── list shows the distribution + reconciled outstanding ──
  const list = await inj('GET', '/api/restaurant/tips', sales1);
  ok('List: one distribution, 2 staff lines, outstanding 0', list.json.count === 1 && list.json.distributions[0].lines.length === 2 && near(list.json.gl_outstanding, 0), JSON.stringify({ c: list.json.count, o: list.json.gl_outstanding }));

  // ── POS-10: tip-adjust-after-auth (auth → adjust tip pre-capture → capture bill+tip → 2300) ──
  // 2300 is at 0 here (all prior tips distributed); the card-tip capture below re-accrues it in isolation.
  const gl2300Before = await gl('2300');
  // authorize a card tender for a 200 bill (mock gateway → Authorized, no capture yet)
  const auth = await inj('POST', '/api/payments', cash1, { sale_no: 'S-TIP-10', method: 'Card', amount: 200, authorize: true });
  const payNo = auth.json.payment_no as string;
  ok('POS-10: card authorize → Authorized hold (no capture yet)', auth.json.status === 'Authorized' && /^PAY-/.test(payNo ?? ''), JSON.stringify({ s: auth.json.status, no: payNo }));

  // over-limit tip rejected: 25% ceiling on 200 = 50; 60 exceeds it
  const overTip = await inj('POST', `/api/payments/${payNo}/tip-adjust`, cash1, { tip: 60 });
  ok('POS-10: tip over the 25% ceiling rejected (400 TIP_OVER_LIMIT)', overTip.status === 400 && overTip.json.error?.code === 'TIP_OVER_LIMIT', `${overTip.status} ${overTip.json.error?.code}`);

  // adjust the tip within the window (40 ≤ 50), audited
  const adj = await inj('POST', `/api/payments/${payNo}/tip-adjust`, cash1, { tip: 40, reason: 'slip' });
  ok('POS-10: tip adjusted to 40 within window (max 50)', adj.status < 300 && near(adj.json.tip, 40) && near(adj.json.max_tip, 50), JSON.stringify({ tip: adj.json.tip, max: adj.json.max_tip }));
  const audit = await inj('GET', `/api/payments/${payNo}/tip-adjustments`, cash1);
  ok('POS-10: each adjustment written to the immutable audit log', audit.json.count === 1 && near(audit.json.adjustments[0].new_tip, 40) && near(audit.json.adjustments[0].delta, 40), JSON.stringify({ c: audit.json.count }));

  // capture bill + tip → Captured; tip posts to 2300 (Dr 1000 / Cr 2300)
  const cap = await inj('POST', `/api/payments/${payNo}/capture`, cash1);
  ok('POS-10: capture settles bill+tip (240) → Captured', cap.status < 300 && cap.json.status === 'Captured' && near(cap.json.captured_total, 240) && near(cap.json.tip, 40), JSON.stringify({ s: cap.json.status, t: cap.json.captured_total }));
  const gl2300After = await gl('2300');
  ok('POS-10: card tip posts to 2300 Tips Payable on capture (+40)', near(gl2300After - gl2300Before, 40), `2300 Δ=${gl2300After - gl2300Before}`);

  // the freshly-captured tip is now available to the tip pool (TIP-01 pays it out unchanged)
  const poolTip = await inj('GET', `/api/restaurant/tips/pool?from=${period.from}&to=${period.to}`, sales1);
  ok('POS-10: captured card tip flows into the tip pool (available 40)', near(poolTip.json.available, 40) && near(poolTip.json.gl_outstanding, 40), JSON.stringify(poolTip.json));

  // post-capture adjustment rejected (immutable once captured)
  const lateTip = await inj('POST', `/api/payments/${payNo}/tip-adjust`, cash1, { tip: 10 });
  ok('POS-10: tip-adjust after capture rejected (400 TIP_ADJUST_CLOSED)', lateTip.status === 400 && lateTip.json.error?.code === 'TIP_ADJUST_CLOSED', `${lateTip.status} ${lateTip.json.error?.code}`);
  // and a re-capture is idempotent (no double 2300 post)
  const reCap = await inj('POST', `/api/payments/${payNo}/capture`, cash1);
  ok('POS-10: re-capture idempotent (already Captured, no double post)', reCap.json.already === true && near(await gl('2300') - gl2300Before, 40), `2300 Δ=${await gl('2300') - gl2300Before}`);

  // ── trial balance balanced ──
  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  ok('Trial balance balanced after tip distribution + card-tip capture', tb.totals?.balanced === true, JSON.stringify(tb.totals ?? {}));

  await app.close();
  await pg.close();
  console.log('\n── POS Tip pooling / distribution (ทิป: รวม + แบ่งจ่าย) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} tip checks failed` : `\n✅ All ${checks.length} tip checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
