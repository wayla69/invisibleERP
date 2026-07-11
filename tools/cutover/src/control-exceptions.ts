/**
 * GRC-4 (GOV-02) — Control-Exception Disposition + KCI. ToE for the managed continuous-monitoring program:
 * boots the real Nest app over PGlite, seeds data that trips each NEW detector (split PO, weekend manual JE,
 * dormant-vendor reactivation) plus a duplicate invoice, scans, then exercises the disposition lifecycle
 * (owner/due/root-cause → remediate → closed), the KCI roll-up (open by detector/severity/family, overdue,
 * MTTR) and RLS isolation across tenants.
 *
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover control-exceptions
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ctlx-secret';
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
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: !!cond, detail });

// A deterministic weekend date (Saturday) so the weekend-JE detector fires regardless of when CI runs.
function nextSaturday(from: string): string {
  const d = new Date(`${from}T00:00:00Z`);
  while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'T1', name: 'บริษัทหนึ่ง' }, { code: 'T2', name: 'บริษัทสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [t1, t2] = [await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'ctl1', passwordHash: await pw.hash('pw'), role: 'Sales', tenantId: t1 }, // holds 'exec' — controls reader/dispositioner, tenant T1
    { username: 'ctl2', passwordHash: await pw.hash('pw'), role: 'Sales', tenantId: t2 }, // tenant T2 — RLS isolation probe
  ]).onConflictDoNothing();

  const sat = nextSaturday('2026-06-01');

  // ── Seed T1 data that trips each detector ──
  // 1. Split PO: 3 approved POs to one (T1-owned) vendor within 7 days, each < 50,000 but summing to 60,000.
  //    purchase_orders is not tenant-scoped, so the detector attributes the split to the vendor's tenant —
  //    seed the vendor under T1 so the finding (and RLS isolation) is genuinely tenant-scoped.
  await db.insert(s.vendors).values({ tenantId: t1, vendorCode: 'SPLIT', name: 'SplitCo' }).onConflictDoNothing();
  const splitVendor = (await db.select().from(s.vendors).where(eq(s.vendors.vendorCode, 'SPLIT')))[0];
  await db.insert(s.purchaseOrders).values([
    { poNo: 'PO-SPLIT-1', vendorId: splitVendor.id, vendorName: 'SplitCo', poDate: '2026-06-01', totalAmount: '20000', status: 'Approved' },
    { poNo: 'PO-SPLIT-2', vendorId: splitVendor.id, vendorName: 'SplitCo', poDate: '2026-06-03', totalAmount: '20000', status: 'Approved' },
    { poNo: 'PO-SPLIT-3', vendorId: splitVendor.id, vendorName: 'SplitCo', poDate: '2026-06-05', totalAmount: '20000', status: 'Approved' },
  ]).onConflictDoNothing();
  // 2. Weekend manual JE.
  await db.insert(s.journalEntries).values({ entryNo: 'JE-WKND-1', entryDate: sat, source: 'Manual', memo: 'ปรับปรุงวันหยุด', status: 'Posted', tenantId: t1 }).onConflictDoNothing();
  const wknd = (await db.select().from(s.journalEntries).where(eq(s.journalEntries.entryNo, 'JE-WKND-1')))[0];
  await db.insert(s.journalLines).values([
    { entryId: wknd.id, accountCode: '5000', debit: '5000', credit: '0', tenantId: t1 },
    { entryId: wknd.id, accountCode: '1000', debit: '0', credit: '5000', tenantId: t1 },
  ]).onConflictDoNothing();
  // 3. Dormant-vendor reactivation: two AP txns >180 days apart.
  // 4. Duplicate invoice (also a duplicate amount) — gives a critical-severity finding for the KCI cut.
  await db.insert(s.apTransactions).values([
    { txnNo: 'AP-DORM-1', tenantId: t1, vendorName: 'DormantCo', invoiceNo: 'D-1', invoiceDate: '2025-01-01', amount: '3000', status: 'Unpaid' },
    { txnNo: 'AP-DORM-2', tenantId: t1, vendorName: 'DormantCo', invoiceNo: 'D-2', invoiceDate: '2026-06-01', amount: '4000', status: 'Unpaid' },
    { txnNo: 'AP-DUP-1', tenantId: t1, vendorName: 'DupCo', invoiceNo: 'INV-DUP', invoiceDate: '2026-06-10', amount: '1000', status: 'Unpaid' },
    { txnNo: 'AP-DUP-2', tenantId: t1, vendorName: 'DupCo', invoiceNo: 'INV-DUP', invoiceDate: '2026-06-10', amount: '1000', status: 'Unpaid' },
  ]).onConflictDoNothing();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const inj = async (method: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: method as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'pw' })).json.token as string;
  const u1 = await login('ctl1');
  const u2 = await login('ctl2');
  ok('login: controls users authenticate', !!u1 && !!u2);

  // ── Scan (T1) ──
  const jlBefore = (await db.select().from(s.journalLines)).length;
  const scan = await inj('POST', '/api/controls/scan', u1);
  ok('scan runs and returns candidates', (scan.status === 200 || scan.status === 201) && (scan.json.candidates ?? 0) >= 4, `candidates=${scan.json.candidates}`);

  const find1 = await inj('GET', '/api/controls/findings', u1);
  const findings: any[] = find1.json.findings ?? [];
  const keys = findings.map((f) => f.control_key);
  ok('detector: split_po finding raised', keys.includes('split_po'), JSON.stringify(keys));
  ok('detector: weekend_je finding raised', keys.includes('weekend_je'), JSON.stringify(keys));
  ok('detector: dormant_vendor finding raised', keys.includes('dormant_vendor'), JSON.stringify(keys));

  const splitF = findings.find((f) => f.control_key === 'split_po');
  ok('finding carries rcm_ref (split_po → EXP-02)', splitF?.rcm_ref === 'EXP-02', `${splitF?.rcm_ref}`);
  ok('finding carries rcm_ref (weekend_je → GL-05)', findings.find((f) => f.control_key === 'weekend_je')?.rcm_ref === 'GL-05', '');
  ok('new finding defaults disposition=open', splitF?.disposition === 'open', `${splitF?.disposition}`);

  // Idempotency: a re-scan raises no NEW findings.
  await inj('POST', '/api/controls/scan', u1);
  const find1b = await inj('GET', '/api/controls/findings', u1);
  ok('scan is idempotent by fingerprint (no duplicates on re-scan)', (find1b.json.findings ?? []).length === findings.length, `first=${findings.length} second=${(find1b.json.findings ?? []).length}`);

  // ── Disposition lifecycle ──
  const invalid = await inj('POST', `/api/controls/findings/${splitF.id}/disposition`, u1, { disposition: 'bogus' });
  ok('disposition rejects an unknown status (400)', invalid.status === 400, `${invalid.status}`);

  const disp = await inj('POST', `/api/controls/findings/${splitF.id}/disposition`, u1, { disposition: 'investigating', owner: 'auditor.jane', due_date: '2020-01-01', root_cause: 'PO split across buyers' });
  ok('disposition sets owner + due_date + root_cause', (disp.status === 200 || disp.status === 201) && disp.json.finding?.disposition === 'investigating' && disp.json.finding?.owner === 'auditor.jane' && disp.json.finding?.root_cause === 'PO split across buyers', JSON.stringify(disp.json.finding ?? disp.json));

  // KCI while the investigating finding is past its due date → overdue.
  const kci1 = await inj('GET', '/api/controls/kci', u1);
  ok('KCI: investigating finding still counts as open', (kci1.json.total_open ?? 0) >= 4, `total_open=${kci1.json.total_open}`);
  ok('KCI: overdue reflects a past due_date', (kci1.json.overdue ?? 0) >= 1, `overdue=${kci1.json.overdue}`);
  ok('KCI: by_family rolls up Expenditure + General Ledger', (kci1.json.by_family ?? []).some((f: any) => f.family === 'Expenditure') && (kci1.json.by_family ?? []).some((f: any) => f.family === 'General Ledger'), JSON.stringify(kci1.json.by_family));
  ok('KCI: by_detector reports split_po open count', (kci1.json.by_detector ?? []).find((d: any) => d.control_key === 'split_po')?.open >= 1, JSON.stringify((kci1.json.by_detector ?? []).find((d: any) => d.control_key === 'split_po')));

  // Remediate → closed, stamped, dropped from open.
  const rem = await inj('POST', `/api/controls/findings/${splitF.id}/disposition`, u1, { disposition: 'remediated', root_cause: 'consolidated to one PO' });
  ok('remediate closes the finding with remediated_by/at', (rem.status === 200 || rem.status === 201) && rem.json.finding?.disposition === 'remediated' && !!rem.json.finding?.remediated_by && !!rem.json.finding?.remediated_at, JSON.stringify(rem.json.finding ?? rem.json));

  const kci2 = await inj('GET', '/api/controls/kci', u1);
  ok('KCI: remediated finding dropped from total_open', (kci2.json.total_open ?? 99) === (kci1.json.total_open ?? 0) - 1, `before=${kci1.json.total_open} after=${kci2.json.total_open}`);
  ok('KCI: overdue drops after remediation', (kci2.json.overdue ?? 99) === (kci1.json.overdue ?? 0) - 1, `before=${kci1.json.overdue} after=${kci2.json.overdue}`);
  ok('KCI: mean-time-to-remediate computed once a finding is closed', kci2.json.mttr_days !== null && kci2.json.mttr_days >= 0, `mttr=${kci2.json.mttr_days}`);

  // Disposition-filtered list.
  const remList = await inj('GET', '/api/controls/findings?disposition=remediated', u1);
  ok('findings filter by disposition', (remList.json.findings ?? []).length === 1 && (remList.json.findings ?? [])[0]?.control_key === 'split_po', `${(remList.json.findings ?? []).length}`);

  // ── RLS isolation ──
  const scan2 = await inj('POST', '/api/controls/scan', u2);
  ok('T2 scan finds nothing (no T2 data)', (scan2.json.candidates ?? -1) === 0, `candidates=${scan2.json.candidates}`);
  const find2 = await inj('GET', '/api/controls/findings', u2);
  ok('RLS: T2 never sees T1 findings', (find2.json.findings ?? []).length === 0, `t2 findings=${(find2.json.findings ?? []).length}`);
  const kciT2 = await inj('GET', '/api/controls/kci', u2);
  ok('RLS: T2 KCI is empty', (kciT2.json.total_open ?? -1) === 0, `t2 total_open=${kciT2.json.total_open}`);

  // ── No GL impact ──
  const jlAfter = (await db.select().from(s.journalLines)).length;
  ok('monitor posts NOTHING to the GL (journal lines unchanged)', jlAfter === jlBefore, `before=${jlBefore} after=${jlAfter}`);

  // ── Report ──
  const pass = checks.filter((c) => c.ok).length;
  console.log('\n── GRC-4 (GOV-02) Control-Exception Disposition + KCI ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.ok ? '' : `  — ${c.detail}`}`);
  console.log(`\n${pass}/${checks.length} checks passed`);
  await app.close();
  process.exit(pass === checks.length ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
