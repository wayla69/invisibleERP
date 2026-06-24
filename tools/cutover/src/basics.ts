/**
 * ERP basics — Statement of Cash Flows (indirect) + AR collections/dunning + credit hold, over PGlite.
 * Cash-flow reconciles to the change in cash by construction; dunning escalates by aging; credit check holds.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover basics
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'basics-secret';
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
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([
    { code: 'HQ', name: 'HQ' },
    { code: 'CUST', name: 'Credit Customer', creditLimit: '2500', email: 'ar@cust.example', phone: '0810000000' },
    { code: 'CUST2', name: 'Defaulting Customer', creditLimit: '100000', email: 'ar@cust2.example' }, // under limit but 90+ overdue
    { code: 'CUST3', name: 'Good Customer', creditLimit: '100000', phone: '0820000000' },             // under limit, only mildly overdue
  ]).onConflictDoNothing();
  const tid = async (code: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, code)))[0].id);
  const hq = await tid('HQ');
  const cust = await tid('CUST');
  const cust2 = await tid('CUST2');
  const cust3 = await tid('CUST3');
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'emp1', passwordHash: await pw.hash('emp123'), role: 'Admin', tenantId: hq }, // claimant (ESS)
    { username: 'mgr', passwordHash: await pw.hash('mgr123'), role: 'Admin', tenantId: hq },   // approver (≠ claimant)
  ]).onConflictDoNothing();
  // Employee linked to the emp1 user (ESS self-service) + two assets for EAM maintenance.
  await db.insert(s.employees).values([{ tenantId: hq, empCode: 'EMP1', name: 'Test Employee', userName: 'emp1', monthlySalary: '30000' }]).onConflictDoNothing();
  await db.insert(s.fixedAssets).values([
    { tenantId: hq, assetNo: 'FA-EAM1', name: 'Compressor', acquireDate: '2026-01-01', acquireCost: '120000', usefulLifeMonths: 60, netBookValue: '120000', status: 'active' },
    { tenantId: hq, assetNo: 'FA-EAM2', name: 'Forklift', acquireDate: '2026-01-01', acquireCost: '80000', usefulLifeMonths: 60, netBookValue: '80000', status: 'active' },
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
  const admin = (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' })).json.token;

  // Post a balanced, already-Posted JE directly (PGlite superuser bypasses RLS) — lets us date entries
  // precisely across the cash-flow window without the maker-checker dance (that flow is tested elsewhere).
  let jeSeq = 0;
  const postJE = async (date: string, lines: { code: string; debit?: number; credit?: number }[], source = 'TEST') => {
    jeSeq++;
    const [h] = await db.insert(s.journalEntries).values({
      entryNo: `JE-T${String(jeSeq).padStart(4, '0')}`, entryDate: date, period: date.slice(0, 7),
      source, sourceRef: `${source}-${jeSeq}`, tenantId: hq, currency: 'THB', status: 'Posted', createdBy: 'seed',
    }).returning({ id: s.journalEntries.id });
    await db.insert(s.journalLines).values(lines.map((l) => ({
      entryId: Number(h.id), accountCode: l.code, debit: String(l.debit ?? 0), credit: String(l.credit ?? 0), currency: 'THB', tenantId: hq,
    })));
  };

  // ───────────────────── Statement of Cash Flows (indirect) ─────────────────────
  // Window 2026-03. Opening cash struck in Feb (before window). March: credit sale, cash expense,
  // depreciation (non-cash), inventory-on-credit, AR receipt.
  await postJE('2026-02-28', [{ code: '1000', debit: 10000 }, { code: '3000', credit: 10000 }], 'OPEN');
  await postJE('2026-03-05', [{ code: '1100', debit: 1000 }, { code: '4000', credit: 1000 }]); // credit sale → AR up, revenue
  await postJE('2026-03-10', [{ code: '5100', debit: 200 }, { code: '1000', credit: 200 }]);    // cash operating expense
  await postJE('2026-03-15', [{ code: '5200', debit: 300 }, { code: '1590', credit: 300 }]);    // depreciation (non-cash)
  await postJE('2026-03-18', [{ code: '1200', debit: 500 }, { code: '2000', credit: 500 }]);    // inventory bought on credit
  await postJE('2026-03-20', [{ code: '1000', debit: 400 }, { code: '1100', credit: 400 }]);    // AR receipt (cash in)

  const cf = (await inj('GET', '/api/ledger/cash-flow?from=2026-03-01&to=2026-03-31', admin)).json;
  // net income = 1000 − 200 − 300 = 500; +dep 300; WC: AR +600→−600, Inv +500→−500, AP +500→+500 ⇒ op = 200
  ok('Cash flow: net income = 500', near(cf.operating?.net_income, 500), `ni=${cf.operating?.net_income}`);
  const dep = (cf.operating?.adjustments ?? []).find((a: any) => a.account_code === '1590');
  ok('Cash flow: depreciation add-back = 300 (non-cash)', near(dep?.amount, 300), `dep=${dep?.amount}`);
  ok('Cash flow: net cash from operating = 200', near(cf.operating?.net, 200), `op=${cf.operating?.net}`);
  ok('Cash flow: investing = 0, financing = 0 (opening pre-window)', near(cf.investing?.net, 0) && near(cf.financing?.net, 0), `inv=${cf.investing?.net} fin=${cf.financing?.net}`);
  ok('Cash flow: net change in cash = 200', near(cf.net_change_in_cash, 200), `chg=${cf.net_change_in_cash}`);
  ok('Cash flow: beginning cash = 10000, ending = 10200', near(cf.cash_beginning, 10000) && near(cf.cash_ending, 10200), `beg=${cf.cash_beginning} end=${cf.cash_ending}`);
  ok('Cash flow: RECONCILED (activities ≡ Δcash) + no unclassified accounts', cf.reconciled === true && (cf.unclassified_accounts ?? []).length === 0, `rec=${cf.reconciled} unc=${JSON.stringify(cf.unclassified_accounts)}`);

  // Negative control: a year-end CLOSE in the window must not distort the statement (it's excluded).
  await postJE('2026-03-31', [{ code: '4000', debit: 1000 }, { code: '5100', credit: 200 }, { code: '5200', credit: 300 }, { code: '3100', credit: 500 }], 'CLOSE');
  const cf2 = (await inj('GET', '/api/ledger/cash-flow?from=2026-03-01&to=2026-03-31', admin)).json;
  ok('Cash flow: CLOSE entry excluded → net income + reconciliation unchanged', near(cf2.operating?.net_income, 500) && cf2.reconciled === true, `ni=${cf2.operating?.net_income} rec=${cf2.reconciled}`);

  // ───────────────────── AR collections / dunning + credit hold ─────────────────────
  await db.insert(s.arInvoices).values([
    { invoiceNo: 'INV-A', invoiceDate: daysAgo(70), dueDate: daysAgo(40), tenantId: cust, amount: '1000', paidAmount: '0', status: 'Unpaid', createdBy: 'seed' },
    { invoiceNo: 'INV-B', invoiceDate: daysAgo(130), dueDate: daysAgo(100), tenantId: cust, amount: '2000', paidAmount: '0', status: 'Unpaid', createdBy: 'seed' },
    { invoiceNo: 'INV-C', invoiceDate: daysAgo(20), dueDate: daysAgo(5), tenantId: cust, amount: '500', paidAmount: '500', status: 'Paid', createdBy: 'seed' },
    { invoiceNo: 'INV-D', invoiceDate: daysAgo(150), dueDate: daysAgo(120), tenantId: cust2, amount: '500', paidAmount: '0', status: 'Unpaid', createdBy: 'seed' }, // 120d overdue, well under limit
    { invoiceNo: 'INV-E', invoiceDate: daysAgo(45), dueDate: daysAgo(20), tenantId: cust3, amount: '500', paidAmount: '0', status: 'Unpaid', createdBy: 'seed' },  // only 20d overdue
  ]).onConflictDoNothing();

  const wl = (await inj('GET', '/api/finance/ar/collections', admin)).json;
  const a = (wl.rows ?? []).find((r: any) => r.invoice_no === 'INV-A');
  const b = (wl.rows ?? []).find((r: any) => r.invoice_no === 'INV-B');
  const c = (wl.rows ?? []).find((r: any) => r.invoice_no === 'INV-C');
  ok('Collections worklist lists open overdue invoices, excludes Paid', !!a && !!b && !c, `A=${!!a} B=${!!b} C=${!!c}`);
  ok('Collections: INV-A (40d) recommends second_notice; INV-B (100d) recommends legal', a?.recommended_stage === 'second_notice' && b?.recommended_stage === 'legal', `A=${a?.recommended_stage} B=${b?.recommended_stage}`);
  ok('Collections worklist sorted by days overdue (oldest first)', (wl.rows?.[0]?.invoice_no) === 'INV-D', `first=${wl.rows?.[0]?.invoice_no}`);

  const dun = await inj('POST', '/api/finance/ar/collections/INV-A/dunning', admin, { stage: 'second_notice', channel: 'email', notes: 'Sent 2nd notice' });
  ok('Record dunning action → DUN- issued', /^DUN-/.test(dun.json.dunning_no ?? '') && dun.json.stage === 'second_notice', JSON.stringify(dun.json).slice(0, 80));
  ok('Dunning notice dispatched to customer email (sent)', dun.json.message_status === 'sent' && dun.json.recipient === 'ar@cust.example', `st=${dun.json.message_status} to=${dun.json.recipient}`);
  const mlog = (await inj('GET', '/api/messaging/log?limit=50', admin)).json;
  const dunMsg = (mlog.messages ?? []).find((m: any) => m.campaign === 'dunning:second_notice' && m.recipient === 'ar@cust.example');
  ok('Dunning notice logged with per-stage body', !!dunMsg && /INV-A/.test(dunMsg.body) && dunMsg.channel === 'email', `found=${!!dunMsg}`);

  const wl2 = (await inj('GET', '/api/finance/ar/collections', admin)).json;
  const a2 = (wl2.rows ?? []).find((r: any) => r.invoice_no === 'INV-A');
  ok('After dunning: INV-A current_stage=second_notice, no further escalation', a2?.current_stage === 'second_notice' && a2?.escalate === false, `stage=${a2?.current_stage} esc=${a2?.escalate}`);

  const hist = (await inj('GET', '/api/finance/ar/collections/INV-A/history', admin)).json;
  ok('Dunning history records the action', hist.count === 1 && hist.actions?.[0]?.stage === 'second_notice', `n=${hist.count}`);

  const paidDun = await inj('POST', '/api/finance/ar/collections/INV-C/dunning', admin, { stage: 'reminder' });
  ok('Dunning on a paid invoice rejected (ALREADY_PAID)', paidDun.status === 400 && paidDun.json?.error?.code === 'ALREADY_PAID', `st=${paidDun.status} code=${paidDun.json?.error?.code}`);

  // Credit position: exposure 3000 (INV-A 1000 + INV-B 2000) > limit 2500 → over limit; INV-B 100d → serious overdue.
  const cs = (await inj('GET', `/api/finance/ar/credit-status?tenant_id=${cust}`, admin)).json;
  ok('Credit status: exposure 3000 vs limit 2500 → over_limit + on_hold', near(cs.exposure, 3000) && cs.over_limit === true && cs.on_hold === true, `exp=${cs.exposure} hold=${cs.on_hold}`);
  ok('Credit status: serious_overdue (100d > 90)', cs.serious_overdue === true && cs.max_overdue_days >= 100, `mx=${cs.max_overdue_days}`);

  const cc = (await inj('POST', '/api/finance/ar/credit-check', admin, { tenant_id: cust, amount: 100 })).json;
  ok('Credit check: further credit DENIED for held customer', cc.approved === false && (cc.reason === 'CREDIT_LIMIT_EXCEEDED' || cc.reason === 'SERIOUS_OVERDUE'), `appr=${cc.approved} reason=${cc.reason}`);

  // ───────────────────── Credit hold wired into POS/portal order entry ─────────────────────
  const order = (c: string) => ({ customer_name: c, items: [{ item_id: 'WIDGET', order_qty: 1, unit_price: 10 }] });
  // CUST2: under limit (100k) but 120d overdue → blocked by the serious-overdue hold (REV-12, unified rule).
  const o2 = await inj('POST', '/api/pos/orders', admin, order('CUST2'));
  ok('Order entry: 90+ days overdue blocked at POS (CREDIT_OVERDUE) even within limit', o2.status === 409 && o2.json?.error?.code === 'CREDIT_OVERDUE', `st=${o2.status} code=${o2.json?.error?.code}`);
  // CUST (over the 2500 limit) → the parity-locked credit-limit block still fires first.
  const o1 = await inj('POST', '/api/pos/orders', admin, order('CUST'));
  ok('Order entry: over-limit still blocked at POS (CREDIT_LIMIT) — parity preserved', o1.status === 409 && o1.json?.error?.code === 'CREDIT_LIMIT', `st=${o1.status} code=${o1.json?.error?.code}`);
  // CUST3: under limit and only 20d overdue → order allowed (no over-block).
  const o3 = await inj('POST', '/api/pos/orders', admin, order('CUST3'));
  ok('Order entry: customer in good standing can still order', o3.status === 201 && /^SO-/.test(o3.json?.order_no ?? ''), `st=${o3.status} no=${o3.json?.order_no}`);

  // ───────────────────── Automated dunning — scheduled job + direct sweep ─────────────────────
  // Register a DAILY scheduled job that runs the dunning sweep, and confirm it's in the schedulable catalog.
  const rt = (await inj('GET', '/api/bi/report-types', admin)).json;
  ok('AR dunning is a schedulable job type (rides the report scheduler)', (rt.report_types ?? []).some((t: any) => t.key === 'ar_collections_dunning'), '');
  const sub = await inj('POST', '/api/bi/subscriptions', admin, { name: 'Nightly dunning', report_type: 'ar_collections_dunning', frequency: 'daily' });
  ok('Schedule a daily AR-dunning job', sub.json?.report_type === 'ar_collections_dunning' && sub.json?.frequency === 'daily' && !!sub.json?.next_run_at, JSON.stringify(sub.json).slice(0, 90));

  // Scheduler tick (cron → POST /subscriptions/run) fires the due job, which executes the sweep.
  // INV-A already at second_notice (skipped); INV-B→legal, INV-D→legal, INV-E→first_notice advance ⇒ 3.
  const ran = (await inj('POST', '/api/bi/subscriptions/run', admin)).json;
  const dunRun = (ran.runs ?? []).find((r: any) => r.report_type === 'ar_collections_dunning');
  ok('Scheduler tick runs the dunning sweep + records a run (advanced 3)', ran.ran_count >= 1 && dunRun?.status === 'success' && /advanced 3 of/i.test(dunRun?.summary ?? ''), `ran=${ran.ran_count} sum="${dunRun?.summary}"`);

  // The sweep dispatched the dunning notices too: INV-B/INV-D via email, INV-E via SMS (CUST3 has only a phone).
  const mlog2 = (await inj('GET', '/api/messaging/log?limit=100', admin)).json.messages ?? [];
  const legalEmails = mlog2.filter((m: any) => m.campaign === 'dunning:legal' && m.channel === 'email' && m.status === 'sent').length;
  const smsNotice = mlog2.find((m: any) => m.campaign === 'dunning:first_notice' && m.channel === 'sms' && m.recipient === '0820000000');
  ok('Swept dunning notices delivered: ≥2 legal emails + 1 SMS (channel auto-picked from contact)', legalEmails >= 2 && !!smsNotice, `legalEmails=${legalEmails} sms=${!!smsNotice}`);

  // The direct cron-callable sweep now advances nothing — scheduled + direct paths share the same DUN state.
  const sw2 = (await inj('POST', '/api/finance/ar/collections/sweep', admin)).json;
  ok('Dunning is idempotent across scheduled + direct sweeps', sw2.advanced === 0, `adv2=${sw2.advanced}`);

  // ───────────────────── ESS expense → AP reimbursement ─────────────────────
  const emp1 = (await inj('POST', '/api/login', undefined, { username: 'emp1', password: 'emp123' })).json.token;
  const mgr = (await inj('POST', '/api/login', undefined, { username: 'mgr', password: 'mgr123' })).json.token;
  const exp = await inj('POST', '/api/ess/expenses', emp1, { category: 'travel', amount: 500, description: 'Taxi' });
  const expId = exp.json?.id;
  ok('Employee submits an expense claim', exp.status === 201 && exp.json?.status === 'Pending', `st=${exp.status} id=${expId}`);
  const selfApprove = await inj('POST', `/api/ess/expenses/${expId}/decide`, emp1, { approve: true });
  ok('Self-approval of own expense blocked (SoD)', (selfApprove.status === 400 || selfApprove.status === 403) && selfApprove.json?.error?.code === 'SOD_SELF_APPROVAL', `st=${selfApprove.status} code=${selfApprove.json?.error?.code}`);
  const appr = await inj('POST', `/api/ess/expenses/${expId}/decide`, mgr, { approve: true });
  ok('Manager approval raises an AP reimbursement payable (AP-…)', /^AP-/.test(appr.json?.ap_txn_no ?? '') && appr.json?.payable === true, JSON.stringify(appr.json).slice(0, 90));
  const apList = (await inj('GET', '/api/finance/ap?status=Unpaid&limit=50', admin)).json;
  const reimb = (apList.transactions ?? []).find((t: any) => t.Invoice_No === `EXP-${expId}`);
  ok('Reimbursement appears in AP as a payable (500) — settle-able via AP', !!reimb && near(reimb.Outstanding_Amount, 500), `found=${!!reimb} out=${reimb?.Outstanding_Amount}`);
  const payReimb = await inj('PATCH', `/api/finance/ap/transactions/${appr.json.ap_txn_no}/pay`, admin, { amount: 500 });
  ok('Reimbursement paid through the normal AP pay flow', payReimb.json?.status === 'Paid', `st=${payReimb.json?.status}`);

  // ───────────────────── EAM: asset maintenance ─────────────────────
  const wo = await inj('POST', '/api/eam/work-orders', admin, { asset_no: 'FA-EAM1', type: 'corrective', priority: 'high', description: 'Seal leak', vendor_name: 'ACME Repairs', cost_estimate: 1000 });
  const woNo = wo.json?.wo_no;
  ok('Raise a corrective maintenance work order', wo.status === 201 && /^MWO-/.test(woNo ?? '') && wo.json?.status === 'open', `st=${wo.status} wo=${woNo}`);
  const comp = await inj('PATCH', `/api/eam/work-orders/${woNo}/status`, admin, { status: 'completed', actual_cost: 1000, vendor_name: 'ACME Repairs', vat_treatment: 'exempt', downtime_hours: 4 });
  ok('Complete WO → raises an AP payable for the maintenance cost', comp.json?.status === 'completed' && /^AP-/.test(comp.json?.ap_txn_no ?? ''), JSON.stringify(comp.json));
  const badT = await inj('PATCH', `/api/eam/work-orders/${woNo}/status`, admin, { status: 'in_progress' });
  ok('Illegal WO transition rejected (completed→in_progress)', badT.status === 400 && badT.json?.error?.code === 'BAD_TRANSITION', `st=${badT.status} code=${badT.json?.error?.code}`);
  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  const acct5700 = (tb.rows ?? []).find((r: any) => r.account_code === '5710');
  ok('Maintenance cost posts to 5710 Repairs & Maintenance', near(acct5700?.debit, 1000), `dr=${acct5700?.debit}`);
  const apM = (await inj('GET', '/api/finance/ap?status=Unpaid&limit=50', admin)).json;
  ok('Maintenance cost is an AP payable', (apM.transactions ?? []).some((t: any) => t.Invoice_No === woNo && near(t.Outstanding_Amount, 1000)), '');

  // PM schedules: time-based (due now) + meter-based (over the interval) → due-generation sweep.
  await inj('POST', '/api/eam/pm-schedules', admin, { asset_no: 'FA-EAM1', name: 'Quarterly service', interval_days: 90, next_due_date: daysAgo(1) });
  await inj('POST', '/api/eam/pm-schedules', admin, { asset_no: 'FA-EAM2', name: 'Engine hours', meter_interval: 100 });
  await inj('POST', '/api/eam/assets/FA-EAM2/meter', admin, { meter_value: 150 }); // 150 ≥ 0+100 → meter-due
  ok('PM generation is a schedulable job type', (rt.report_types ?? []).some((t: any) => t.key === 'eam_pm_generate') || (await inj('GET', '/api/bi/report-types', admin)).json.report_types.some((t: any) => t.key === 'eam_pm_generate'), '');
  await inj('POST', '/api/bi/subscriptions', admin, { name: 'Daily PM', report_type: 'eam_pm_generate', frequency: 'daily' });
  const ranPm = (await inj('POST', '/api/bi/subscriptions/run', admin)).json;
  const pmRun = (ranPm.runs ?? []).find((r: any) => r.report_type === 'eam_pm_generate');
  ok('Scheduler raises preventive WOs for due schedules (2: time + meter)', pmRun?.status === 'success' && /raised 2 of/i.test(pmRun?.summary ?? ''), `sum="${pmRun?.summary}"`);
  const pmAgain = (await inj('POST', '/api/eam/pm/run', admin)).json;
  ok('PM generation idempotent (open WO + advanced due date)', pmAgain.generated === 0, `gen2=${pmAgain.generated}`);
  const woPrev = (await inj('GET', '/api/eam/work-orders?type=preventive', admin)).json;
  ok('Generated preventive work orders are listed', (woPrev.work_orders ?? []).length >= 2, `n=${woPrev.count}`);

  console.log('\n── ERP basics — Cash Flows + Collections/Dunning + ESS-AP + EAM ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} basics checks failed` : `\n✅ All ${checks.length} basics checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
