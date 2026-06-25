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
  // AP disbursement maker-checker (EXP-06): paying is request (admin) → approve by a DIFFERENT user (mgr).
  const reqReimb = await inj('PATCH', `/api/finance/ap/transactions/${appr.json.ap_txn_no}/pay`, admin, { amount: 500 });
  const payReimb = await inj('POST', `/api/finance/ap/payments/${reqReimb.json.payment_no}/approve`, mgr);
  ok('Reimbursement settled through the AP maker-checker pay flow', reqReimb.json?.status === 'PendingApproval' && payReimb.json?.bill_status === 'Paid', `req=${reqReimb.json?.status} st=${payReimb.json?.bill_status}`);

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

  // ───────────────────── Credit-hold approval workflow ─────────────────────
  const mgr2 = (await inj('POST', '/api/login', undefined, { username: 'mgr', password: 'mgr123' })).json.token;
  const ph = await inj('POST', '/api/finance/ar/credit-hold', admin, { tenant_id: cust3, reason: 'Disputed balance' });
  ok('Place manual credit hold', ph.json?.credit_hold === true, JSON.stringify(ph.json));
  const csH = (await inj('GET', `/api/finance/ar/credit-status?tenant_id=${cust3}`, admin)).json;
  ok('Credit status reflects manual hold + reason + on_hold', csH.manual_hold === true && csH.on_hold === true && csH.hold_reason === 'Disputed balance', `mh=${csH.manual_hold} reason=${csH.hold_reason}`);
  const ccH = (await inj('POST', '/api/finance/ar/credit-check', admin, { tenant_id: cust3, amount: 10 })).json;
  ok('Credit-check denies a held customer (reason CREDIT_HOLD)', ccH.approved === false && ccH.reason === 'CREDIT_HOLD', `appr=${ccH.approved} reason=${ccH.reason}`);
  const heldOrder = await inj('POST', '/api/pos/orders', admin, { customer_name: 'CUST3', items: [{ item_id: 'WIDGET', order_qty: 1, unit_price: 10 }] });
  ok('Order entry blocks a held customer (CREDIT_HOLD)', heldOrder.status === 409 && heldOrder.json?.error?.code === 'CREDIT_HOLD', `st=${heldOrder.status} code=${heldOrder.json?.error?.code}`);
  const selfRel = await inj('POST', '/api/finance/ar/credit-release', admin, { tenant_id: cust3, reason: 'ok now' });
  ok('Self-release of own hold blocked (SoD)', selfRel.status === 400 && selfRel.json?.error?.code === 'SOD_SELF_RELEASE', `st=${selfRel.status} code=${selfRel.json?.error?.code}`);
  const rel = await inj('POST', '/api/finance/ar/credit-release', mgr2, { tenant_id: cust3, reason: 'Approved release' });
  ok('Independent approver releases the hold', rel.json?.credit_hold === false, JSON.stringify(rel.json));
  await inj('POST', '/api/finance/ar/credit-limit', admin, { tenant_id: cust3, new_limit: 50000, reason: 'Annual review' });
  const ce = (await inj('GET', `/api/finance/ar/credit-events?tenant_id=${cust3}`, admin)).json;
  const types = (ce.events ?? []).map((e: any) => e.event_type);
  const lc = (ce.events ?? []).find((e: any) => e.event_type === 'limit_change');
  ok('Credit-change audit logs hold/release/limit_change (old→new)', types.includes('hold') && types.includes('release') && lc?.old_limit === 100000 && lc?.new_limit === 50000, `types=${JSON.stringify(types)} lc=${lc?.old_limit}->${lc?.new_limit}`);

  // ───────────────────── EAM depth: cost lines + reliability ─────────────────────
  const woD = await inj('POST', '/api/eam/work-orders', admin, { asset_no: 'FA-EAM1', type: 'corrective', description: 'Bearing replacement' });
  const woDno = woD.json?.wo_no;
  await inj('POST', `/api/eam/work-orders/${woDno}/lines`, admin, { kind: 'labor', description: 'Tech 3h', hours: 3, unit_cost: 500 });   // 1500
  const partLine = await inj('POST', `/api/eam/work-orders/${woDno}/lines`, admin, { kind: 'part', description: 'Bearing', quantity: 2, unit_cost: 250 }); // 500
  ok('WO cost lines roll up into actual cost (1500 labor + 500 parts = 2000)', near(partLine.json?.actual_cost, 2000), `actual=${partLine.json?.actual_cost}`);
  const woLines = (await inj('GET', `/api/eam/work-orders/${woDno}/lines`, admin)).json;
  ok('WO line breakdown: labor 1500 / parts 500', near(woLines.labor_total, 1500) && near(woLines.parts_total, 500), `labor=${woLines.labor_total} parts=${woLines.parts_total}`);
  // complete without explicit actual_cost → uses the rolled-up line total; downtime captured
  const compD = await inj('PATCH', `/api/eam/work-orders/${woDno}/status`, admin, { status: 'completed', vendor_name: 'ACME Repairs', vat_treatment: 'exempt', downtime_hours: 6 });
  ok('Complete WO uses rolled-up line cost for the AP payable', compD.json?.status === 'completed' && /^AP-/.test(compD.json?.ap_txn_no ?? ''), JSON.stringify(compD.json));
  const rel2 = (await inj('GET', '/api/eam/assets/FA-EAM1/reliability', admin)).json;
  // FA-EAM1 now has 2 corrective WOs (earlier MWO + this one) + the generated preventive PM WO.
  ok('Asset reliability: ≥2 failures, downtime + cost rolled up, MTBF computed', rel2.corrective_failures >= 2 && rel2.total_downtime_hours >= 6 && rel2.total_maintenance_cost >= 2000 && rel2.mtbf_days !== null, JSON.stringify(rel2));

  // ───────────────────── Cash flow — direct method + forecast ─────────────────────
  const cfd = (await inj('GET', '/api/ledger/cash-flow-direct?from=2026-03-01&to=2026-03-31', admin)).json;
  // March cash legs: receipt +400 (contra AR) ; cash opex −200 (contra expense). op net 200; reconciles.
  ok('Cash flow (direct): receipts 400, payments −200, reconciled', near(cfd.operating?.receipts_from_customers, 400) && near(cfd.operating?.payments_to_suppliers, -200) && near(cfd.operating?.net, 200) && cfd.reconciled === true, `rec=${cfd.operating?.receipts_from_customers} pay=${cfd.operating?.payments_to_suppliers} ok=${cfd.reconciled}`);
  const fc = (await inj('GET', '/api/ledger/cash-flow-forecast?weeks=6', admin)).json;
  ok('Cash flow forecast: 7 buckets (week 0..6), opening cash + projected balances', (fc.periods ?? []).length === 7 && typeof fc.opening_cash === 'number' && fc.total_expected_inflow > 0, `n=${fc.periods?.length} open=${fc.opening_cash} in=${fc.total_expected_inflow}`);

  // ───────────────────── Recurring / template journal entries (GL-08) ─────────────────────
  const tbDebit = async (code: string) => {
    const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
    const row = (tb.rows ?? []).find((r: any) => r.account_code === code);
    return row ? Number(row.debit) : 0;
  };
  // Unbalanced template is rejected up front (can't save a broken template that fails silently each night).
  const badTpl = await inj('POST', '/api/ledger/recurring', admin, { name: 'bad', frequency: 'daily', lines: [{ account_code: '5710', debit: 1000 }, { account_code: '2100', credit: 500 }] });
  ok('Recurring: unbalanced template rejected (UNBALANCED)', badTpl.status === 400 && badTpl.json?.error?.code === 'UNBALANCED', `st=${badTpl.status} code=${badTpl.json?.error?.code}`);
  const before5710 = await tbDebit('5710');
  const mkTpl = await inj('POST', '/api/ledger/recurring', admin, { name: 'Monthly rent accrual', frequency: 'daily', memo: 'rent', lines: [{ account_code: '5710', debit: 1000 }, { account_code: '2100', credit: 1000 }] });
  ok('Recurring: create a balanced template (next_run = today)', mkTpl.status === 201 && typeof mkTpl.json?.id === 'number' && !!mkTpl.json?.next_run_date, JSON.stringify(mkTpl.json));
  const run1 = await inj('POST', '/api/ledger/recurring/run', admin);
  const recEntryNo = run1.json?.entries?.[0]?.entry_no;
  ok('Recurring: scheduled run posts the due template (1)', run1.status === 200 && run1.json?.posted === 1 && /^JE-/.test(recEntryNo ?? ''), `posted=${run1.json?.posted} no=${recEntryNo}`);
  // GL-05: it posts as DRAFT — excluded from balances until a different user approves.
  const draft5710 = await tbDebit('5710');
  ok('Recurring: posted JE is DRAFT — excluded from trial balance', near(draft5710, before5710), `before=${before5710} afterDraft=${draft5710}`);
  const pend = (await inj('GET', '/api/ledger/journal/pending', admin)).json;
  ok('Recurring: draft JE awaits maker-checker approval', (pend.entries ?? []).some((e: any) => e.entry_no === recEntryNo), `pending=${(pend.entries ?? []).length}`);
  // Idempotent: a same-day re-run advances nothing (next_run rolled forward + ux_je_idem dedupe).
  const run2 = await inj('POST', '/api/ledger/recurring/run', admin);
  ok('Recurring: same-day re-run is idempotent (0)', run2.status === 200 && run2.json?.posted === 0, `posted=${run2.json?.posted}`);
  // A DIFFERENT user approves → the accrual now lands in balances.
  const recAppr = await inj('POST', `/api/ledger/journal/${recEntryNo}/approve`, mgr);
  const posted5710 = await tbDebit('5710');
  ok('Recurring: a second user approves → accrual hits the GL (+1000)', recAppr.status === 200 && near(posted5710, before5710 + 1000), `st=${recAppr.status} after=${posted5710}`);

  const tbCredit2 = async (code: string) => {
    const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
    const row = (tb.rows ?? []).find((r: any) => r.account_code === code);
    return row ? Number(row.credit) : 0;
  };
  const tbBalance = async (code: string) => {
    const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
    const row = (tb.rows ?? []).find((r: any) => r.account_code === code);
    return row ? Number(row.balance) : 0;
  };

  // ───────────────────── Customer / vendor statements of account ─────────────────────
  const [stmtT] = await db.insert(s.tenants).values({ code: 'STMT', name: 'Statement Customer' }).returning({ id: s.tenants.id });
  const stmtTid = Number(stmtT.id);
  await db.insert(s.arInvoices).values([
    { invoiceNo: 'INV-S1', invoiceDate: '2026-01-10', dueDate: '2026-02-10', tenantId: stmtTid, amount: '1000', paidAmount: '400', status: 'Partial' },
    { invoiceNo: 'INV-S2', invoiceDate: '2026-02-10', dueDate: '2026-03-10', tenantId: stmtTid, amount: '500', paidAmount: '0', status: 'Unpaid' },
  ]);
  await db.insert(s.arReceipts).values([{ receiptNo: 'RCP-S1', receiptDate: '2026-02-15', tenantId: stmtTid, invoiceNo: 'INV-S1', amount: '400', method: 'Transfer' }]);
  const stmt = (await inj('GET', `/api/finance/ar/statement?tenant_id=${stmtTid}&from=2026-01-01&to=2026-02-28`, admin)).json;
  ok('Customer statement: opening 0, charges 1500, payments 400, closing 1100', near(stmt.opening_balance, 0) && near(stmt.total_charges, 1500) && near(stmt.total_payments, 400) && near(stmt.closing_balance, 1100), `open=${stmt.opening_balance} chg=${stmt.total_charges} pay=${stmt.total_payments} close=${stmt.closing_balance}`);
  ok('Customer statement: running balance over 3 dated lines', (stmt.lines ?? []).length === 3 && near(stmt.lines?.[stmt.lines.length - 1]?.balance, 1100), `n=${stmt.lines?.length} last=${stmt.lines?.[stmt.lines.length - 1]?.balance}`);
  const stmtFeb = (await inj('GET', `/api/finance/ar/statement?tenant_id=${stmtTid}&from=2026-02-01&to=2026-02-28`, admin)).json;
  ok('Customer statement: opening balance struck before the window (1000)', near(stmtFeb.opening_balance, 1000) && near(stmtFeb.closing_balance, 1100), `open=${stmtFeb.opening_balance} close=${stmtFeb.closing_balance}`);
  // Multi-currency: a separate customer with a THB invoice + a USD invoice (fx 34).
  const [stmt2T] = await db.insert(s.tenants).values({ code: 'STMT2', name: 'FX Customer' }).returning({ id: s.tenants.id });
  const stmt2Tid = Number(stmt2T.id);
  await db.insert(s.arInvoices).values([
    { invoiceNo: 'INV-T1', invoiceDate: '2026-02-05', tenantId: stmt2Tid, amount: '1000', currency: 'THB', fxRate: '1', status: 'Unpaid' },
    { invoiceNo: 'INV-U1', invoiceDate: '2026-02-10', tenantId: stmt2Tid, amount: '100', currency: 'USD', fxRate: '34', status: 'Unpaid' },
  ]);
  const stBase = (await inj('GET', `/api/finance/ar/statement?tenant_id=${stmt2Tid}&from=2026-02-01&to=2026-02-28`, admin)).json;
  ok('Customer statement (multi-currency): base THB converts USD at fx (1000 + 100×34 = 4400)', stBase.reporting_currency === 'THB' && near(stBase.total_charges, 4400) && (stBase.lines ?? []).length === 2, `cur=${stBase.reporting_currency} chg=${stBase.total_charges} n=${stBase.lines?.length}`);
  const stUsd = (await inj('GET', `/api/finance/ar/statement?tenant_id=${stmt2Tid}&from=2026-02-01&to=2026-02-28&currency=USD`, admin)).json;
  ok('Customer statement (multi-currency): ?currency=USD reports USD docs in their own units', stUsd.reporting_currency === 'USD' && near(stUsd.total_charges, 100) && near(stUsd.closing_balance, 100) && (stUsd.lines ?? []).every((l: any) => l.doc_currency === 'USD'), `cur=${stUsd.reporting_currency} chg=${stUsd.total_charges} close=${stUsd.closing_balance} n=${stUsd.lines?.length}`);

  // ───────────────────── Petty cash / employee cash advances (EXP-07) ─────────────────────
  const adv1180Before = await tbBalance('1180');
  const issue = await inj('POST', '/api/finance/advances', admin, { payee: 'EMP1', amount: 1000, purpose: 'site visit' });
  ok('Petty cash: issue an advance (Dr 1180 / Cr 1000)', issue.status === 201 && /^ADV-/.test(issue.json?.advance_no ?? '') && near(await tbBalance('1180'), adv1180Before + 1000), `no=${issue.json?.advance_no} 1180=${await tbBalance('1180')}`);
  const advNo = issue.json?.advance_no;
  const badStl = await inj('POST', `/api/finance/advances/${advNo}/settle`, admin, { settled_expense: 700, returned_cash: 200 });
  ok('Petty cash: settlement must reconcile to the advance (SETTLE_MISMATCH)', badStl.status === 400 && badStl.json?.error?.code === 'SETTLE_MISMATCH', `st=${badStl.status} code=${badStl.json?.error?.code}`);
  const stl = await inj('POST', `/api/finance/advances/${advNo}/settle`, admin, { settled_expense: 700, returned_cash: 300 });
  ok('Petty cash: settle clears the float (700 expense + 300 returned)', stl.status === 200 && stl.json?.status === 'settled' && near(await tbBalance('1180'), adv1180Before), `1180bal=${await tbBalance('1180')}`);

  // ───────────────────── Prepaid amortization schedules (GL-09) ─────────────────────
  const pp1280Before = await tbDebit('1280');
  const mkPp = await inj('POST', '/api/ledger/prepaid', admin, { name: 'Annual insurance', total_amount: 1200, months: 12, capitalize: true });
  ok('Prepaid: register a 12-month schedule (monthly 100), capitalized', mkPp.status === 201 && near(mkPp.json?.monthly_amount, 100) && near(await tbDebit('1280'), pp1280Before + 1200), `monthly=${mkPp.json?.monthly_amount} 1280=${await tbDebit('1280')}`);
  const runPp = await inj('POST', '/api/ledger/prepaid/run', admin);
  ok('Prepaid: scheduled run amortizes one period (100 to expense)', runPp.status === 200 && runPp.json?.posted === 1 && near(runPp.json?.entries?.[0]?.amount, 100), `posted=${runPp.json?.posted} amt=${runPp.json?.entries?.[0]?.amount}`);
  const runPp2 = await inj('POST', '/api/ledger/prepaid/run', admin);
  ok('Prepaid: same-day re-run is idempotent (0)', runPp2.status === 200 && runPp2.json?.posted === 0, `posted=${runPp2.json?.posted}`);

  // ───────────────────── Lease accounting (IFRS 16) ─────────────────────
  const rou1600Before = await tbDebit('1600');
  const mkLease = await inj('POST', '/api/leases', admin, { name: 'Office lease', term_months: 12, monthly_payment: 1000, annual_rate_pct: 12 });
  const liability = mkLease.json?.initial_liability;
  ok('Lease: commencement recognises ROU = liability = PV of payments (Dr 1600 / Cr 2600)', mkLease.status === 201 && liability > 11200 && liability < 11300 && near(await tbDebit('1600'), rou1600Before + liability) && near(await tbCredit2('2600'), liability), `liab=${liability} 1600Δ=${(await tbDebit('1600')) - rou1600Before}`);
  const runLease = await inj('POST', '/api/leases/run', admin);
  const le = runLease.json?.entries?.[0];
  ok('Lease: periodic run posts interest + principal (= payment) + ROU depreciation', runLease.status === 200 && runLease.json?.posted === 1 && near(le?.interest + le?.principal, 1000) && le?.depreciation > 0, `int=${le?.interest} prin=${le?.principal} dep=${le?.depreciation}`);
  const leList = (await inj('GET', '/api/leases', admin)).json;
  const leRow = (leList.leases ?? []).find((x: any) => x.lease_no === mkLease.json?.lease_no);
  ok('Lease: liability + ROU NBV reduced after the period', leRow && leRow.liability_balance < liability && leRow.rou_nbv < liability, `liab=${leRow?.liability_balance} rou=${leRow?.rou_nbv}`);
  // Lease modification (IFRS 16 remeasurement): raise the payment → liability + ROU step up by the delta.
  const lease1600Before = await tbDebit('1600');
  const lease2600Before = await tbCredit2('2600');
  const mod = await inj('POST', `/api/leases/${mkLease.json?.lease_no}/modify`, admin, { new_monthly_payment: 1200 });
  ok('Lease modification: remeasures liability + ROU by the delta (Dr 1600 / Cr 2600)', mod.status === 200 && mod.json?.liability_delta > 0 && mod.json?.liability_after > mod.json?.liability_before && mod.json?.rou_after > leRow.rou_nbv && near(await tbDebit('1600'), lease1600Before + mod.json.liability_delta) && near(await tbCredit2('2600'), lease2600Before + mod.json.liability_delta), `delta=${mod.json?.liability_delta} rouAfter=${mod.json?.rou_after}`);
  const modNoChange = await inj('POST', `/api/leases/${mkLease.json?.lease_no}/modify`, admin, {});
  ok('Lease modification: a no-op modification is rejected (NO_CHANGE)', modNoChange.status === 400 && modNoChange.json?.error?.code === 'NO_CHANGE', `st=${modNoChange.status} code=${modNoChange.json?.error?.code}`);

  // ───────────────────── Asset revaluation / impairment (FA-07) ─────────────────────
  const reg = (await inj('GET', '/api/assets', admin)).json;
  const fa2 = (reg.assets ?? reg.register ?? []).find((a: any) => (a.asset_no ?? a.assetNo) === 'FA-EAM2');
  const nbv2 = Number(fa2?.net_book_value ?? fa2?.nbv ?? fa2?.netBookValue ?? 80000);
  const surplusBefore = await tbCredit2('3200');
  const revUp = await inj('POST', '/api/assets/FA-EAM2/revalue', admin, { new_value: nbv2 + 10000, reason: 'market appraisal' });
  ok('Asset revaluation (upward): surplus to equity 3200 (+10000)', revUp.status === 201 && revUp.json?.kind === 'revaluation' && near(revUp.json?.delta, 10000) && near(await tbCredit2('3200'), surplusBefore + 10000), `kind=${revUp.json?.kind} delta=${revUp.json?.delta}`);
  const imp5820Before = await tbDebit('5820');
  const revDown = await inj('POST', '/api/assets/FA-EAM2/revalue', admin, { new_value: nbv2 + 5000, reason: 'impairment test' });
  ok('Asset impairment (downward): impairment loss 5820 (+5000)', revDown.status === 201 && revDown.json?.kind === 'impairment' && near(revDown.json?.delta, -5000) && near(await tbDebit('5820'), imp5820Before + 5000), `kind=${revDown.json?.kind} delta=${revDown.json?.delta}`);
  const noChange = await inj('POST', '/api/assets/FA-EAM2/revalue', admin, { new_value: nbv2 + 5000 });
  ok('Asset revaluation: no-change rejected (NO_CHANGE)', noChange.status === 400 && noChange.json?.error?.code === 'NO_CHANGE', `st=${noChange.status} code=${noChange.json?.error?.code}`);
  const revList = (await inj('GET', '/api/assets/FA-EAM2/revaluations', admin)).json;
  ok('Asset revaluation: audit trail lists both events', (revList.revaluations ?? []).length === 2, `n=${revList.revaluations?.length}`);
  // Revaluation-reserve recycling on disposal: FA-EAM2 holds a 10000 surplus in 3200 → transfers to 3100.
  const surplus3200Before = await tbBalance('3200');
  const disp2 = await inj('PATCH', '/api/assets/FA-EAM2/dispose', admin, { proceeds: 50000 });
  ok('Asset disposal recycles revaluation surplus to retained earnings (Dr 3200 / Cr 3100)', disp2.json?.revaluation_surplus_recycled === 10000 && near(await tbBalance('3200'), surplus3200Before + 10000), `recycled=${disp2.json?.revaluation_surplus_recycled} 3200bal=${await tbBalance('3200')}`);

  // ───────────────────── Perpetual inventory valuation sub-ledger (INV-01..04) ─────────────────────
  // Run in a dedicated tenant so the inventory control account (1200) is isolated from the cash-flow seed.
  const [invT] = await db.insert(s.tenants).values({ code: 'INVT', name: 'Inventory Co' }).returning({ id: s.tenants.id });
  const invTid = Number(invT.id);
  await db.insert(s.users).values({ username: 'invmgr', passwordHash: await pw.hash('inv123'), role: 'Admin', tenantId: invTid }).onConflictDoNothing();
  const invmgr = (await inj('POST', '/api/login', undefined, { username: 'invmgr', password: 'inv123' })).json.token;

  // Receipt 1: 100 @ 10 = 1000 in. Receipt 2: 100 @ 12 = 1200 in ⇒ moving avg = 2200/200 = 11.
  const r1 = await inj('POST', '/api/inventory/receipts', invmgr, { item_id: 'SUGAR', item_description: 'Sugar 1kg', uom: 'BAG', qty: 100, unit_cost: 10, ref_type: 'GRN', ref_id: 'GRN-1' });
  ok('Inventory: goods receipt posts valued stock-in (100 @ 10) + GL', r1.status === 201 && near(r1.json?.balance_qty, 100) && near(r1.json?.avg_cost, 10) && /^JE-/.test(r1.json?.gl_entry_no ?? ''), JSON.stringify(r1.json).slice(0, 90));
  const r2 = await inj('POST', '/api/inventory/receipts', invmgr, { item_id: 'SUGAR', qty: 100, unit_cost: 12, ref_type: 'GRN', ref_id: 'GRN-2' });
  ok('Inventory: second receipt recomputes moving-average cost (200 @ 11)', r2.status === 201 && near(r2.json?.balance_qty, 200) && near(r2.json?.avg_cost, 11), `bal=${r2.json?.balance_qty} avg=${r2.json?.avg_cost}`);

  // INV-02 — idempotent posting: re-posting GRN-1 is a no-op (no double stock / no double GL).
  const rDup = await inj('POST', '/api/inventory/receipts', invmgr, { item_id: 'SUGAR', qty: 100, unit_cost: 10, ref_type: 'GRN', ref_id: 'GRN-1' });
  const valAfterDup = (await inj('GET', '/api/inventory/valuation', invmgr)).json;
  ok('Inventory: duplicate receipt (same GRN ref) is idempotent (INV-02)', rDup.json?.deduped === true && near(valAfterDup.items?.find((i: any) => i.item_id === 'SUGAR')?.on_hand_qty, 200), `dedup=${rDup.json?.deduped}`);

  // Issue 50 @ avg 11 = 550 to COGS ⇒ balance 150 @ 11 = 1650.
  const iss = await inj('POST', '/api/inventory/issues', invmgr, { item_id: 'SUGAR', qty: 50, ref_type: 'MI', ref_id: 'MI-1' });
  ok('Inventory: goods issue relieves stock at moving-average (50 @ 11 → COGS 550)', iss.status === 201 && near(iss.json?.value, 550) && near(iss.json?.balance_qty, 150) && near(iss.json?.avg_cost, 11), JSON.stringify(iss.json).slice(0, 90));
  // INV-01 — negative-stock guard: issuing beyond on-hand (1000 > 150) is rejected.
  const issNeg = await inj('POST', '/api/inventory/issues', invmgr, { item_id: 'SUGAR', qty: 1000 });
  ok('Inventory: over-issue beyond on-hand rejected (INV-01 NEG_STOCK)', issNeg.status === 400 && issNeg.json?.error?.code === 'NEG_STOCK', `st=${issNeg.status} code=${issNeg.json?.error?.code}`);

  // Shrinkage adjustment: −10 @ avg 11 = −110 to 5810 ⇒ balance 140 @ 11 = 1540.
  const adj = await inj('POST', '/api/inventory/adjustments', invmgr, { item_id: 'SUGAR', qty_delta: -10, reason: 'Spoilage' });
  ok('Inventory: shrinkage adjustment writes stock down + posts variance (−10 @ 11)', adj.status === 201 && near(adj.json?.balance_qty, 140) && near(adj.json?.value, -110), JSON.stringify(adj.json).slice(0, 90));
  // INV-04 — an adjustment with no reason is rejected (control: every adjustment is justified + audited).
  const adjBad = await inj('POST', '/api/inventory/adjustments', invmgr, { item_id: 'SUGAR', qty_delta: -1, reason: '   ' });
  ok('Inventory: adjustment without a reason rejected (REASON_REQUIRED)', adjBad.status === 400 && adjBad.json?.error?.code === 'REASON_REQUIRED', `st=${adjBad.status} code=${adjBad.json?.error?.code}`);

  // Valuation + INV-05 reconciliation: sub-ledger (140 @ 11 = 1540) ties to the GL inventory account.
  const val = (await inj('GET', '/api/inventory/valuation', invmgr)).json;
  ok('Inventory: valuation reports on-hand value at moving-average (140 @ 11 = 1540)', near(val.total_value, 1540) && near(val.items?.find((i: any) => i.item_id === 'SUGAR')?.total_value, 1540), `total=${val.total_value}`);
  const rec = (await inj('GET', '/api/inventory/reconciliation', invmgr)).json;
  ok('Inventory: sub-ledger ties to GL inventory control account (INV-05 reconciled 1540)', near(rec.sub_ledger_value, 1540) && near(rec.gl_inventory, 1540) && rec.reconciled === true, `sub=${rec.sub_ledger_value} gl=${rec.gl_inventory} rec=${rec.reconciled}`);
  // Movement ledger carries the full audit trail (2 receipts + 1 issue + 1 adjust = 4 moves, each GL-linked).
  const mv = (await inj('GET', '/api/inventory/moves?item_id=SUGAR', invmgr)).json;
  ok('Inventory: movement ledger records all 4 valued moves with GL links', mv.count === 4 && (mv.moves ?? []).every((m: any) => /^JE-/.test(m.gl_entry_no ?? '')), `n=${mv.count}`);

  // ───────────────────── FIFO/FEFO cost-layer costing (Tier 1 lots) ─────────────────────
  // MILK is FEFO-costed: two dated layers; an issue consumes the SOONEST-EXPIRY layer first (not avg).
  await inj('POST', '/api/inventory/receipts', invmgr, { item_id: 'MILK', uom: 'CTN', qty: 10, unit_cost: 12, costing_method: 'fefo', lot_no: 'L1', expiry_date: '2026-07-01', ref_type: 'GRN', ref_id: 'GRN-M1' });
  const mr2 = await inj('POST', '/api/inventory/receipts', invmgr, { item_id: 'MILK', uom: 'CTN', qty: 10, unit_cost: 15, lot_no: 'L2', expiry_date: '2026-06-20', ref_type: 'GRN', ref_id: 'GRN-M2' });
  ok('FEFO: 2nd receipt inherits the fefo method + opens a layer (20 on hand, avg 13.5)', mr2.json?.costing_method === 'fefo' && near(mr2.json?.balance_qty, 20) && near(mr2.json?.avg_cost, 13.5), `m=${mr2.json?.costing_method} avg=${mr2.json?.avg_cost}`);
  // FEFO issue 12 → consume L2 (10 @ 15 = 150, expires 06-20) then L1 (2 @ 12 = 24) ⇒ COGS 174 (≠ 162 at avg).
  const mIss = await inj('POST', '/api/inventory/issues', invmgr, { item_id: 'MILK', qty: 12 });
  ok('FEFO: issue consumes soonest-expiry layer first → COGS = 174 (≠ 162 moving-avg)', near(mIss.json?.value, 174) && near(mIss.json?.balance_qty, 8), `cogs=${mIss.json?.value} bal=${mIss.json?.balance_qty}`);
  const mLayers = (await inj('GET', '/api/inventory/layers?item_id=MILK', invmgr)).json;
  ok('FEFO: one open layer remains (L1: 8 @ 12 = 96)', mLayers.count === 1 && mLayers.layers?.[0]?.lot_no === 'L1' && near(mLayers.layers?.[0]?.remaining_qty, 8) && near(mLayers.total_value, 96), `n=${mLayers.count} val=${mLayers.total_value}`);
  const milkRow = (await inj('GET', '/api/inventory/valuation', invmgr)).json.items?.find((i: any) => i.item_id === 'MILK');
  ok('FEFO: valuation shows MILK 8 @ 12 = 96, method=fefo', near(milkRow?.total_value, 96) && milkRow?.costing_method === 'fefo', `val=${milkRow?.total_value} m=${milkRow?.costing_method}`);
  const recF = (await inj('GET', '/api/inventory/reconciliation', invmgr)).json;
  ok('FEFO: layer sub-ledger still ties to the GL inventory control account (reconciled)', recF.reconciled === true && near(recF.sub_ledger_value, recF.gl_inventory), `sub=${recF.sub_ledger_value} gl=${recF.gl_inventory} rec=${recF.reconciled}`);

  console.log('\n── ERP basics — Cash Flows + Collections/Dunning + ESS-AP + EAM + credit/depth/forecast + recurring + statements/petty-cash/prepaid/lease/revaluation + inventory sub-ledger + FIFO/FEFO ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} basics checks failed` : `\n✅ All ${checks.length} basics checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
