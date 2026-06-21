/**
 * Accounting Tier 3 — FX Revaluation (ตีราคาอัตราแลกเปลี่ยน) over PGlite:
 * period-end rates, unrealized FX report, revaluation JE to 5400 (AR gain / AP loss).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover fxreval
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'fx-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }]).onConflictDoNothing();
  const hq = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0].id);
  await db.insert(s.users).values([{ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }]).onConflictDoNothing();
  // foreign open balances (booked at their rate): USD AR $100 @ 35; EUR AP €100 @ 39
  await db.insert(s.arInvoices).values({ invoiceNo: 'INV-FX-USD', currency: 'USD', fxRate: '35', amount: '100', paidAmount: '0', status: 'Unpaid', invoiceDate: '2031-12-01', tenantId: hq }).onConflictDoNothing();
  await db.insert(s.apTransactions).values({ txnNo: 'AP-FX-EUR', currency: 'EUR', fxRate: '39', amount: '100', paidAmount: '0', status: 'Unpaid', invoiceDate: '2031-12-01', tenantId: hq }).onConflictDoNothing();

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
  const admin = (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' })).json.token as string;
  const leg = (j: any, c: string, side: string) => (j?.lines ?? []).filter((l: any) => l.account_code === c).reduce((a: number, l: any) => a + Number(l[side]), 0);
  const fxEntry = async (ref2: string) => (await inj('GET', '/api/ledger/journal?limit=20', admin)).json.entries.find((e: any) => e.source === 'FXREVAL' && e.source_ref === ref2);

  const accJson = JSON.stringify((await inj('GET', '/api/ledger/accounts', admin)).json);
  ok('COA seeded with 5400 FX Gain/Loss', accJson.includes('5400'));

  const sr = await inj('POST', '/api/fx/rates', admin, { currency: 'USD', rate_date: '2031-12-31', rate: 36, shared: true });
  ok('Set USD rate 36', (sr.status === 200 || sr.status === 201) && near(sr.json.rate, 36), `${sr.status}`);
  await inj('POST', '/api/fx/rates', admin, { currency: 'EUR', rate_date: '2031-12-31', rate: 40, shared: true });
  const lr = await inj('GET', '/api/fx/rates?currency=USD', admin);
  ok('List rates returns USD 36', (lr.json.rates ?? []).some((r: any) => near(r.rate, 36)));

  // report before revalue (USD): AR booked 3500 / current 3600 / delta 100
  const rep = await inj('GET', '/api/fx/unrealized?as_of=2031-12-31&currency=USD', admin);
  ok('Report USD: AR booked 3500 / current 3600 / delta 100', near(rep.json.ar?.[0]?.booked_thb, 3500) && near(rep.json.ar?.[0]?.current_thb, 3600) && near(rep.json.ar?.[0]?.delta, 100), JSON.stringify(rep.json.ar?.[0]));
  ok('Report USD totals: ar_delta 100', near(rep.json.totals?.ar_delta, 100), JSON.stringify(rep.json.totals));

  // revalue USD → AR gain Dr1100/Cr5400 100
  const rvUsd = await inj('POST', '/api/fx/revalue', admin, { as_of: '2031-12-31', currency: 'USD' });
  ok('Revalue USD: ar_delta 100, ap_delta 0, JE-', near(rvUsd.json.ar_delta, 100) && near(rvUsd.json.ap_delta, 0) && /^JE-/.test(rvUsd.json.entry_no ?? ''), JSON.stringify(rvUsd.json).slice(0, 100));
  const jUsd = await fxEntry('2031-12-31:USD');
  ok('AR gain GL: Dr1100=100 / Cr5400=100', near(leg(jUsd, '1100', 'debit'), 100) && near(leg(jUsd, '5400', 'credit'), 100), JSON.stringify(jUsd?.lines));

  // revalue EUR → AP loss Dr5400/Cr2000 100
  const rvEur = await inj('POST', '/api/fx/revalue', admin, { as_of: '2031-12-31', currency: 'EUR' });
  ok('Revalue EUR: ap_delta 100 (loss), JE-', near(rvEur.json.ap_delta, 100) && /^JE-/.test(rvEur.json.entry_no ?? ''), JSON.stringify(rvEur.json).slice(0, 100));
  const jEur = await fxEntry('2031-12-31:EUR');
  ok('AP loss GL: Dr5400=100 / Cr2000=100', near(leg(jEur, '5400', 'debit'), 100) && near(leg(jEur, '2000', 'credit'), 100), JSON.stringify(jEur?.lines));

  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json.totals ?? {};
  ok('Trial balance balanced after FX revaluation', near(tb.debit ?? tb.total_debit, tb.credit ?? tb.total_credit), JSON.stringify(tb).slice(0, 60));

  const rvUsd2 = await inj('POST', '/api/fx/revalue', admin, { as_of: '2031-12-31', currency: 'USD' });
  ok('Revalue idempotent (re-run → already, no dup JE)', rvUsd2.json.already === true && rvUsd2.json.entry_no == null, JSON.stringify(rvUsd2.json).slice(0, 60));

  const noRate = await inj('POST', '/api/fx/revalue', admin, { as_of: '2031-12-31', currency: 'GBP' });
  ok('No-rate guard: revalue GBP → 400 NO_RATE', noRate.status === 400 && noRate.json.error?.code === 'NO_RATE', `${noRate.status} ${noRate.json.error?.code}`);

  await app.close();
  await pg.close();

  console.log('\n── Accounting Tier 3 — FX Revaluation (ตีราคาอัตราแลกเปลี่ยน) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} fx-reval checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} fx-reval checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
