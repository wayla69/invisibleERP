/**
 * Bank — Cash banking: safe-drop → bank deposit + reconciliation (นำฝากธนาคาร) over PGlite (REC-05):
 * till cash 'drop's into the safe are batched into a bank deposit (Dr bank / Cr 1000 Cash), undeposited
 * drops are tracked (cash-in-safe exposure), and a deposit is reconciled to the bank statement. SoD: banking
 * (exec/ar) is segregated from the cashier (pos_till) who drops the cash.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover cash-banking
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'bank-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1] = [await tid('HQ'), await tid('T1')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'cash1', passwordHash: await pw.hash('pw1'), role: 'PosSupervisor', tenantId: t1 },   // pos_till (drops) — no exec/ar
    { username: 'fin1', passwordHash: await pw.hash('pw2'), role: 'ArClerk', tenantId: t1 },          // ar (banks)
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
  const cash1 = await login('cash1', 'pw1');
  const fin1 = await login('fin1', 'pw2');
  const admin = await login('admin', 'admin123');
  const gl = async (code: string) => Number(((await pg.query(`SELECT coalesce(sum(jl.debit)-sum(jl.credit),0) v FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.account_code='${code}' AND je.status='Posted' AND je.tenant_id=${t1}`)).rows as any[])[0].v);

  // a bank account (GL 1010) + a till with two cash drops (300 + 200 = 500 to the safe)
  const bank = await inj('POST', '/api/bank/accounts', fin1, { bank_name: 'KBank', account_no: '123-4-56789', gl_account_code: '1010' });
  const till = await inj('POST', '/api/payments/till/open', cash1, { opening_float: 1000 });
  const tillId = Number((await db.select().from(s.tillSessions).where(eq(s.tillSessions.sessionNo, till.json.session_no)))[0].id);
  await inj('POST', `/api/payments/till/${tillId}/cash-movement`, cash1, { type: 'drop', amount: 300, reason: 'ฝากเซฟ' });
  await inj('POST', `/api/payments/till/${tillId}/cash-movement`, cash1, { type: 'drop', amount: 200, reason: 'ฝากเซฟ' });

  // ── 1. undeposited drops = cash in the safe (500), drops not yet GL'd ──
  const und = await inj('GET', '/api/bank/deposits/undeposited-drops', fin1);
  ok('Undeposited drops: 2 drops, cash-in-safe 500', und.json.count === 2 && near(und.json.total, 500), JSON.stringify(und.json).slice(0, 90));

  // ── 2. SoD: the cashier (pos_till, no exec/ar) cannot bank the cash ──
  const cashierBank = await inj('POST', '/api/bank/deposits', cash1, { bank_account_id: bank.json.id });
  ok('SoD: cashier (pos_till) cannot create a bank deposit (403)', cashierBank.status === 403, `${cashierBank.status}`);

  // ── 3. FinancialController banks the safe cash → Dr 1010 Bank / Cr 1000 Cash 500 ──
  const dep = await inj('POST', '/api/bank/deposits', fin1, { bank_account_id: bank.json.id, deposit_date: '2026-06-26' });
  ok('Deposit: banks 2 drops, amount 500, BDEP- + JE-', /^BDEP-/.test(dep.json.deposit_no ?? '') && near(dep.json.amount, 500) && dep.json.drops_banked === 2 && /^JE-/.test(dep.json.journal_no ?? ''), JSON.stringify(dep.json).slice(0, 110));
  ok('Deposit GL: Dr 1010 Bank 500 / Cr 1000 Cash 500', near(await gl('1010'), 500) && near(await gl('1000'), -500), `1010=${await gl('1010')} 1000=${await gl('1000')}`);

  // ── 4. drops are now banked → cash-in-safe back to 0 ──
  const und2 = await inj('GET', '/api/bank/deposits/undeposited-drops', fin1);
  ok('After banking: cash-in-safe 0 (no undeposited drops)', und2.json.count === 0 && near(und2.json.total, 0), JSON.stringify(und2.json).slice(0, 60));

  // ── 5. re-banking with nothing to bank → 400 NO_DROPS ──
  const empty = await inj('POST', '/api/bank/deposits', fin1, { bank_account_id: bank.json.id });
  ok('Re-bank with no drops → 400 NO_DROPS', empty.status === 400 && empty.json.error?.code === 'NO_DROPS', `${empty.status} ${empty.json.error?.code}`);

  // ── 6. reconcile the deposit to the bank statement ──
  const depId = Number((await db.select().from(s.bankDeposits).where(eq(s.bankDeposits.tenantId, t1)))[0].id);
  const rec = await inj('POST', `/api/bank/deposits/${depId}/reconcile`, fin1);
  const reRec = await inj('POST', `/api/bank/deposits/${depId}/reconcile`, fin1);
  ok('Reconcile: deposit → Reconciled; re-reconcile rejected (400)', rec.json.status === 'Reconciled' && reRec.status === 400 && reRec.json.error?.code === 'ALREADY_RECONCILED', `${rec.json.status} / ${reRec.json.error?.code}`);

  // ── 7. list: 1 deposit, 0 unreconciled, cash-in-safe 0 ──
  const list = await inj('GET', '/api/bank/deposits', fin1);
  ok('List: 1 deposit, 0 unreconciled, cash-in-safe 0', list.json.count === 1 && list.json.unreconciled === 0 && near(list.json.cash_in_safe, 0), JSON.stringify({ c: list.json.count, u: list.json.unreconciled }));

  // ── 8. trial balance balanced ──
  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  ok('Trial balance balanced after banking', tb.totals?.balanced === true, JSON.stringify(tb.totals ?? {}));

  await app.close();
  await pg.close();
  console.log('\n── Bank Cash banking: safe-drop → deposit + reconciliation (นำฝากธนาคาร) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} cash-banking checks failed` : `\n✅ All ${checks.length} cash-banking checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
