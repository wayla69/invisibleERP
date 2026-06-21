/**
 * Accounting Tier 3 — Intercompany (ระหว่างกิจการ) over PGlite:
 * mirrored due-from (1150) / due-to (2150) across two tenants, settlement, elimination reconciliation.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover intercompany
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ic-secret';
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
  const [admin, sales1] = [await login('admin', 'admin123'), await login('sales1', 'pw1')];
  const leg = (j: any, c: string, side: string) => (j?.lines ?? []).filter((l: any) => l.account_code === c).reduce((a: number, l: any) => a + Number(l[side]), 0);
  const jBy = async (source: string, sref: string) => (await inj('GET', '/api/ledger/journal?limit=60', admin)).json.entries.find((e: any) => e.source === source && e.source_ref === sref);

  const accJson = JSON.stringify((await inj('GET', '/api/ledger/accounts', admin)).json);
  ok('COA seeded with 1150 + 2150', accJson.includes('1150') && accJson.includes('2150'));

  // IC#1: HQ recharges T1 (shared-cost 1000)
  const ic1 = await inj('POST', '/api/intercompany', admin, { from_tenant_id: hq, to_tenant_id: t1, amount: 1000, date: '2031-07-10', category: 'shared-cost', description: 'rent recharge' });
  ok('Create IC#1 (HQ→T1, 1000): IC- + both journals + Open', /^IC-/.test(ic1.json.ic_no ?? '') && /^JE-/.test(ic1.json.from_journal_no ?? '') && /^JE-/.test(ic1.json.to_journal_no ?? '') && ic1.json.status === 'Open', `${ic1.status} ${JSON.stringify(ic1.json).slice(0, 100)}`);
  ok('IC#1 FROM(HQ): Dr1150=1000 / Cr5100=1000', near(leg(await jBy('IC', ic1.json.ic_no), '1150', 'debit'), 1000) && near(leg(await jBy('IC', ic1.json.ic_no), '5100', 'credit'), 1000));
  ok('IC#1 TO(T1): Dr5100=1000 / Cr2150=1000', near(leg(await jBy('IC', `${ic1.json.ic_no}:TO`), '5100', 'debit'), 1000) && near(leg(await jBy('IC', `${ic1.json.ic_no}:TO`), '2150', 'credit'), 1000));

  // IC#2: T1 bills T2 a service (transfer 400)
  const ic2 = await inj('POST', '/api/intercompany', admin, { from_tenant_id: t1, to_tenant_id: t2, amount: 400, date: '2031-07-11', category: 'transfer' });
  ok('Create IC#2 (T1→T2, transfer 400): creditor Cr4000, debtor Dr5100', near(leg(await jBy('IC', ic2.json.ic_no), '4000', 'credit'), 400) && near(leg(await jBy('IC', `${ic2.json.ic_no}:TO`), '2150', 'credit'), 400), `${ic2.status}`);

  // reconciliation after 2 IC: due-from total == due-to total == 1400, eliminates
  const rec1 = await inj('GET', '/api/intercompany/reconciliation', admin);
  ok('Reconciliation: due-from == due-to == 1400, eliminates', near(rec1.json.total_due_from, 1400) && near(rec1.json.total_due_to, 1400) && rec1.json.eliminates === true && near(rec1.json.difference, 0), JSON.stringify({ f: rec1.json.total_due_from, t: rec1.json.total_due_to, e: rec1.json.eliminates }));
  ok('Reconciliation by_pair: HQ→T1 outstanding 1000', rec1.json.by_pair.some((p: any) => p.from_tenant_id === hq && p.to_tenant_id === t1 && near(p.outstanding, 1000)), JSON.stringify(rec1.json.by_pair));

  // partial settle IC#1 (T1 pays HQ 600)
  const set1 = await inj('POST', `/api/intercompany/${ic1.json.ic_no}/settle`, admin, { amount: 600, date: '2031-07-20' });
  ok('Partial settle IC#1 600 → Partial, settled 600', set1.json.status === 'Partial' && near(set1.json.settled_amount, 600), JSON.stringify(set1.json).slice(0, 80));
  ok('Settlement GL: debtor T1 Dr2150/Cr1000=600; creditor HQ Dr1000/Cr1150=600', near(leg(await jBy('IC-SETTLE', `${ic1.json.ic_no}:TO:600`), '2150', 'debit'), 600) && near(leg(await jBy('IC-SETTLE', `${ic1.json.ic_no}:600`), '1150', 'credit'), 600));
  const rec2 = await inj('GET', '/api/intercompany/reconciliation', admin);
  ok('Reconciliation after partial: HQ→T1 outstanding 400, totals 800==800', rec2.json.by_pair.some((p: any) => p.from_tenant_id === hq && p.to_tenant_id === t1 && near(p.outstanding, 400)) && near(rec2.json.total_due_from, 800) && near(rec2.json.total_due_to, 800) && rec2.json.eliminates, JSON.stringify({ f: rec2.json.total_due_from, t: rec2.json.total_due_to }));

  // full settle remainder
  const set2 = await inj('POST', `/api/intercompany/${ic1.json.ic_no}/settle`, admin, { amount: 400, date: '2031-07-21' });
  ok('Full settle IC#1 remainder → Settled, settled 1000', set2.json.status === 'Settled' && near(set2.json.settled_amount, 1000), JSON.stringify(set2.json).slice(0, 70));
  const rec3 = await inj('GET', '/api/intercompany/reconciliation', admin);
  ok('Reconciliation after full settle: due-from == due-to == 400 (IC#2 only)', near(rec3.json.total_due_from, 400) && near(rec3.json.total_due_to, 400) && rec3.json.eliminates, JSON.stringify({ f: rec3.json.total_due_from, t: rec3.json.total_due_to }));

  // overpay rejected
  const over = await inj('POST', `/api/intercompany/${ic2.json.ic_no}/settle`, admin, { amount: 9999 });
  ok('Overpay rejected → 400 IC_OVERPAY', over.status === 400 && over.json.error?.code === 'IC_OVERPAY', `${over.status} ${over.json.error?.code}`);
  // HQ-only guard
  const noHq = await inj('POST', '/api/intercompany', sales1, { from_tenant_id: t1, to_tenant_id: t2, amount: 100 });
  ok('HQ-only guard: non-Admin create → 403 IC_HQ_ONLY', noHq.status === 403 && noHq.json.error?.code === 'IC_HQ_ONLY', `${noHq.status} ${noHq.json.error?.code}`);
  // RLS
  const l1 = await inj('GET', '/api/intercompany', sales1);
  const lAdmin = await inj('GET', '/api/intercompany', admin);
  ok('RLS: T1 sees IC#2 (T1 creditor) not IC#1 (HQ-owned); HQ sees both', (l1.json.ic_transactions ?? []).some((x: any) => x.ic_no === ic2.json.ic_no) && !(l1.json.ic_transactions ?? []).some((x: any) => x.ic_no === ic1.json.ic_no) && lAdmin.json.count >= 2, `t1=${l1.json.count} admin=${lAdmin.json.count}`);

  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json.totals ?? {};
  ok('Group trial balance balanced after IC + settlement', near(tb.debit ?? tb.total_debit, tb.credit ?? tb.total_credit), JSON.stringify(tb).slice(0, 60));

  await app.close();
  await pg.close();

  console.log('\n── Accounting Tier 3 — Intercompany (ระหว่างกิจการ) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} intercompany checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} intercompany checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
