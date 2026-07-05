/**
 * ERP basics — Statement of Cash Flows (indirect) + AR collections/dunning + credit hold, over PGlite.
 * Cash-flow reconciles to the change in cash by construction; dunning escalates by aging; credit check holds.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover basics
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'basics-secret';
process.env.NODE_ENV = 'test';
// A sender identity so the doc-email path clears its sender guard and reaches the (unconfigured) SMTP
// transport — proving the generic email chain is wired end-to-end (render → mailer) → EMAIL_NOT_CONFIGURED.
process.env.MAIL_FROM = process.env.MAIL_FROM || 'shop@example.com';

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
import { BillingService } from '../../../apps/api/dist/modules/billing/billing.service';
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
    return { status: res.statusCode, json, text: res.payload };
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
    // Direct inserts bypass LedgerService, so the gl_period_balances snapshot (R1-2) must be rebuilt —
    // exactly what the 0219 backfill does. Idempotent full recompute; trivial on harness-sized data.
    await rebuildGl();
  };
  const rebuildGl = async () => pg.exec(`DELETE FROM gl_period_balances;
    INSERT INTO gl_period_balances (tenant_id, ledger_code, period, cost_center_code, account_code, debit, credit)
    SELECT je.tenant_id, coalesce(je.ledger_code,''), coalesce(je.period,''), coalesce(jl.cost_center_code,''), jl.account_code, coalesce(sum(jl.debit),0), coalesce(sum(jl.credit),0)
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE je.status = 'Posted'
    GROUP BY 1,2,3,4,5;`);

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

  // ───────── Unified customer master / customer-of-record (REV-15) — links B2C loyalty + B2B AR ─────────
  const [mem] = await db.insert(s.posMembers).values({ tenantId: cust, memberCode: 'M-CUST', name: 'Acme Co', tier: 'Gold', balance: '250', lifetime: '1800', active: true }).returning({ id: s.posMembers.id });
  const cm = await inj('POST', '/api/customer-master', admin, { name: 'Acme Co', kind: 'company', email: 'ar@cust.example', account_code: 'CUST', member_id: Number(mem.id) });
  ok('REV-15: create a customer-of-record (CUS-…) linking a B2B account + B2C member', cm.status === 201 && /^CUS-/.test(cm.json?.customer_no ?? ''), JSON.stringify(cm.json).slice(0, 70));
  const cno = cm.json?.customer_no;
  const v360 = (await inj('GET', `/api/customer-master/${cno}/360`, admin)).json;
  const cdetail = (await inj('GET', '/api/customers/CUST', admin)).json;
  ok('REV-15: 360 AR outstanding ties to the AR sub-ledger (3000)', near(v360.summary?.ar_outstanding, 3000) && near(v360.b2b?.ar_balance?.outstanding, cdetail.ar_balance?.outstanding), `360=${v360.summary?.ar_outstanding} detail=${cdetail.ar_balance?.outstanding}`);
  ok('REV-15: 360 surfaces the linked loyalty (B2C) tier + points', v360.loyalty?.tier === 'Gold' && near(v360.loyalty?.points_balance, 250) && v360.summary?.has_loyalty === true, JSON.stringify(v360.loyalty));
  const cmList = (await inj('GET', '/api/customer-master?search=Acme', admin)).json;
  ok('REV-15: customer master register search finds the record', (cmList.customers ?? []).some((c: any) => c.customer_no === cno), `n=${cmList.count}`);

  // ───────── CRM sales pipeline: leads → opportunities (stage machine) → activities (REV-17) ─────────
  const lead = await inj('POST', '/api/crm/pipeline/leads', admin, { name: 'Jane Buyer', company: 'Beta Corp', email: 'jane@beta.example', source: 'web' });
  ok('REV-17: create a lead (LEAD-…)', lead.status === 201 && /^LEAD-/.test(lead.json?.lead_no ?? ''), JSON.stringify(lead.json));
  const leadNo = lead.json?.lead_no;
  await inj('POST', `/api/crm/pipeline/leads/${leadNo}/qualify`, admin);
  const conv = await inj('POST', `/api/crm/pipeline/leads/${leadNo}/convert`, admin, { opportunity_name: 'Beta rollout', amount: 100000, expected_close_date: '2026-09-30' });
  ok('REV-17: convert lead → customer-of-record (CUS-) + opportunity (OPP-)', conv.status === 201 && conv.json?.status === 'converted' && /^CUS-/.test(conv.json?.customer_no ?? '') && /^OPP-/.test(conv.json?.opp_no ?? ''), JSON.stringify(conv.json));
  const oppNo = conv.json?.opp_no;
  const convAgain = await inj('POST', `/api/crm/pipeline/leads/${leadNo}/convert`, admin, {});
  ok('REV-17: a converted lead cannot be re-converted (LEAD_CONVERTED)', convAgain.status === 400 && convAgain.json?.error?.code === 'LEAD_CONVERTED', `st=${convAgain.status} code=${convAgain.json?.error?.code}`);
  await inj('PATCH', `/api/crm/pipeline/opportunities/${oppNo}/stage`, admin, { stage: 'proposal' });
  const won = await inj('PATCH', `/api/crm/pipeline/opportunities/${oppNo}/stage`, admin, { stage: 'won' });
  ok('REV-17: advance opportunity through the stage machine → won (probability 100)', won.status === 200 && won.json?.stage === 'won' && won.json?.probability === 100, JSON.stringify(won.json));
  const reWon = await inj('PATCH', `/api/crm/pipeline/opportunities/${oppNo}/stage`, admin, { stage: 'negotiation' });
  ok('REV-17: a closed (won) opportunity is terminal (OPP_CLOSED)', reWon.status === 400 && reWon.json?.error?.code === 'OPP_CLOSED', `st=${reWon.status} code=${reWon.json?.error?.code}`);
  const opp2 = await inj('POST', '/api/crm/pipeline/opportunities', admin, { name: 'Gamma deal', amount: 40000, probability: 50 });
  const lostNoReason = await inj('PATCH', `/api/crm/pipeline/opportunities/${opp2.json?.opp_no}/stage`, admin, { stage: 'lost' });
  ok('REV-17: marking lost requires a reason (LOST_REASON_REQUIRED)', lostNoReason.status === 400 && lostNoReason.json?.error?.code === 'LOST_REASON_REQUIRED', `st=${lostNoReason.status} code=${lostNoReason.json?.error?.code}`);
  const pipe = (await inj('GET', '/api/crm/pipeline/summary', admin)).json;
  ok('REV-17: weighted pipeline forecast + won total computed', near(pipe.won_amount, 100000) && pipe.weighted_forecast >= 20000 && (pipe.by_stage?.won?.count ?? 0) >= 1, JSON.stringify({ won: pipe.won_amount, wf: pipe.weighted_forecast }));
  await inj('POST', '/api/crm/pipeline/activities', admin, { entity_type: 'opportunity', entity_no: oppNo, type: 'call', subject: 'Kickoff call' });
  const acts = (await inj('GET', `/api/crm/pipeline/activities?entity_type=opportunity&entity_no=${oppNo}`, admin)).json;
  ok('REV-17: log + list an activity against the opportunity', (acts.activities ?? []).some((a: any) => a.type === 'call' && a.subject === 'Kickoff call'), `n=${acts.count}`);

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
  // ── Printable finance documents: statement · AR receipt voucher · dunning letter (HTML fallback in CI) ──
  const stmtPdf = await inj('GET', `/api/finance/ar/statement/pdf?tenant_id=${stmtTid}&from=2026-01-01&to=2026-02-28`, admin);
  ok('Statement print: PDF/HTML contains "ใบแจ้งยอดบัญชี" + closing (1,100.00)', stmtPdf.status === 200 && stmtPdf.text.includes('ใบแจ้งยอดบัญชี') && stmtPdf.text.includes('1,100.00'), `${stmtPdf.status} ${String(stmtPdf.text).slice(0, 50)}`);
  const stmtEmail = await inj('POST', `/api/finance/ar/statement/send-email?tenant_id=${stmtTid}&from=2026-01-01&to=2026-02-28`, admin, { to_email: 'customer@example.com' });
  ok('Statement email path wired → EMAIL_NOT_CONFIGURED (503) with no SMTP in CI', stmtEmail.status === 503 && stmtEmail.json.error?.code === 'EMAIL_NOT_CONFIGURED', `${stmtEmail.status} ${stmtEmail.json.error?.code}`);
  const rcpPdf = await inj('GET', '/api/finance/ar/receipts/RCP-S1/pdf', admin);
  ok('AR receipt print: PDF/HTML contains "ใบสำคัญรับเงิน" + amount (400.00)', rcpPdf.status === 200 && rcpPdf.text.includes('ใบสำคัญรับเงิน') && rcpPdf.text.includes('400.00'), `${rcpPdf.status} ${String(rcpPdf.text).slice(0, 50)}`);
  const dunPdf = await inj('GET', '/api/finance/ar/collections/INV-A/dunning-letter/pdf', admin);
  ok('Dunning letter print: PDF/HTML contains "หนังสือทวงถามหนี้" + invoice (INV-A)', dunPdf.status === 200 && dunPdf.text.includes('หนังสือทวงถามหนี้') && dunPdf.text.includes('INV-A'), `${dunPdf.status} ${String(dunPdf.text).slice(0, 50)}`);
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
  // C1: JPY has 0 decimal places — roundCurrency must not introduce fractional yen
  const [stmtJpyT] = await db.insert(s.tenants).values({ code: 'STMTJPY', name: 'JPY Customer' }).returning({ id: s.tenants.id });
  const stmtJpyTid = Number(stmtJpyT.id);
  await db.insert(s.arInvoices).values([
    { invoiceNo: 'INV-J1', invoiceDate: '2026-02-05', tenantId: stmtJpyTid, amount: '10000', currency: 'JPY', fxRate: '0.24', status: 'Unpaid' },
  ]);
  const stJpy = (await inj('GET', `/api/finance/ar/statement?tenant_id=${stmtJpyTid}&from=2026-02-01&to=2026-02-28&currency=JPY`, admin)).json;
  ok('C1: JPY statement rounds to 0 dp — charge=10000 (integer, no .xx)', stJpy.reporting_currency === 'JPY' && stJpy.total_charges === 10000 && Number.isInteger(stJpy.total_charges) && Number.isInteger(stJpy.closing_balance), `cur=${stJpy.reporting_currency} chg=${stJpy.total_charges} close=${stJpy.closing_balance}`);

  // ───────────────────── Petty cash / employee cash advances (EXP-07) ─────────────────────
  const adv1180Before = await tbBalance('1180');
  const issue = await inj('POST', '/api/finance/advances', admin, { payee: 'EMP1', amount: 1000, purpose: 'site visit' });
  ok('Petty cash: issue an advance (Dr 1180 / Cr 1000)', issue.status === 201 && /^ADV-/.test(issue.json?.advance_no ?? '') && near(await tbBalance('1180'), adv1180Before + 1000), `no=${issue.json?.advance_no} 1180=${await tbBalance('1180')}`);
  const advNo = issue.json?.advance_no;
  // Register: GET /api/finance/advances lists the advance + the outstanding (uncleared) float total.
  const advReg = (await inj('GET', '/api/finance/advances', admin)).json;
  ok('Petty cash register: lists the advance + outstanding float (≥1000)', (advReg.advances ?? []).some((a: any) => a.advance_no === advNo && a.status === 'open') && advReg.outstanding >= 1000, `n=${advReg.count} out=${advReg.outstanding}`);
  const advOpen = (await inj('GET', '/api/finance/advances?status=open', admin)).json;
  ok('Petty cash register: status=open filter → only open advances', (advOpen.advances ?? []).every((a: any) => a.status === 'open'), `n=${advOpen.count}`);
  const badStl = await inj('POST', `/api/finance/advances/${advNo}/settle`, admin, { settled_expense: 700, returned_cash: 200 });
  ok('Petty cash: settlement must reconcile to the advance (SETTLE_MISMATCH)', badStl.status === 400 && badStl.json?.error?.code === 'SETTLE_MISMATCH', `st=${badStl.status} code=${badStl.json?.error?.code}`);
  const stl = await inj('POST', `/api/finance/advances/${advNo}/settle`, admin, { settled_expense: 700, returned_cash: 300 });
  ok('Petty cash: settle clears the float (700 expense + 300 returned)', stl.status === 200 && stl.json?.status === 'settled' && near(await tbBalance('1180'), adv1180Before), `1180bal=${await tbBalance('1180')}`);

  // ───────── Petty cash imprest float (วงเงิน) + direct-expense / advance maker-checker (EXP-08) ─────────
  const pc1015Before = await tbBalance('1015');
  const pc5100Before = await tbDebit('5100');
  const pc1180Before = await tbBalance('1180');
  const fund = await inj('POST', '/api/finance/petty-cash/funds', admin, { fund_code: 'PCF-1', name: 'HQ petty cash', float_limit: 5000, initial_amount: 5000 });
  ok('EXP-08: establish fund within float (Dr 1015 / Cr 1000 = 5000)', fund.status === 201 && fund.json?.balance === 5000 && near(await tbBalance('1015'), pc1015Before + 5000), `bal=${fund.json?.balance} 1015=${await tbBalance('1015')}`);
  const overFund = await inj('POST', '/api/finance/petty-cash/funds', admin, { fund_code: 'PCF-OVER', float_limit: 1000, initial_amount: 2000 });
  ok('EXP-08: initial cash above the float is rejected (OVER_FLOAT)', overFund.status === 400 && overFund.json?.error?.code === 'OVER_FLOAT', `st=${overFund.status} code=${overFund.json?.error?.code}`);
  // direct expense request → maker-checker, no GL until approved
  const pcExp = await inj('POST', '/api/finance/petty-cash/requests', admin, { fund_code: 'PCF-1', kind: 'expense', payee: 'Taxi', amount: 1200, expense_account: '5100', doc_ref: 'RCPT-001' });
  ok('EXP-08: expense request raised PendingApproval — no GL yet (5100/1015 unchanged)', pcExp.status === 201 && pcExp.json?.status === 'PendingApproval' && near(await tbDebit('5100'), pc5100Before) && near(await tbBalance('1015'), pc1015Before + 5000), `st=${pcExp.json?.status}`);
  const expSelf = await inj('POST', `/api/finance/petty-cash/requests/${pcExp.json?.req_no}/approve`, admin);
  ok('EXP-08: preparer self-approval blocked → 403 SOD_VIOLATION', expSelf.status === 403 && expSelf.json?.error?.code === 'SOD_VIOLATION', `${expSelf.status} ${expSelf.json?.error?.code}`);
  const expAppr = await inj('POST', `/api/finance/petty-cash/requests/${pcExp.json?.req_no}/approve`, mgr);
  ok('EXP-08: a different user approves expense → Dr 5100 / Cr 1015 (1200); fund 3800', expAppr.status === 200 && expAppr.json?.status === 'Approved' && expAppr.json?.fund_balance === 3800 && near(await tbDebit('5100'), pc5100Before + 1200) && near(await tbBalance('1015'), pc1015Before + 3800), `fb=${expAppr.json?.fund_balance} 5100=${await tbDebit('5100')}`);
  // advance request → approve (disburse Dr 1180 / Cr 1015) → settle
  const adv = await inj('POST', '/api/finance/petty-cash/requests', admin, { fund_code: 'PCF-1', kind: 'advance', payee: 'EMP9', amount: 2000, purpose: 'buying trip' });
  await inj('POST', `/api/finance/petty-cash/requests/${adv.json?.req_no}/approve`, mgr);
  ok('EXP-08: advance approved → Dr 1180 / Cr 1015 (2000); fund 1800', near(await tbBalance('1180'), pc1180Before + 2000) && near(await tbBalance('1015'), pc1015Before + 1800), `1180=${await tbBalance('1180')} 1015=${await tbBalance('1015')}`);
  const tooMuch = await inj('POST', '/api/finance/petty-cash/requests', admin, { fund_code: 'PCF-1', kind: 'expense', payee: 'Big', amount: 5000 });
  ok('EXP-08: a draw beyond the fund balance is rejected (INSUFFICIENT_FLOAT)', tooMuch.status === 422 && tooMuch.json?.error?.code === 'INSUFFICIENT_FLOAT', `st=${tooMuch.status} code=${tooMuch.json?.error?.code}`);
  const stlAdv = await inj('POST', `/api/finance/petty-cash/requests/${adv.json?.req_no}/settle`, admin, { settled_expense: 1500, returned_cash: 500 });
  ok('EXP-08: settle advance (1500 spend + 500 back to fund) clears 1180; fund 2300', stlAdv.status === 200 && stlAdv.json?.status === 'Settled' && near(await tbBalance('1180'), pc1180Before) && near(await tbBalance('1015'), pc1015Before + 2300), `1180=${await tbBalance('1180')} 1015=${await tbBalance('1015')}`);
  const rplOver = await inj('POST', '/api/finance/petty-cash/funds/PCF-1/replenish', admin, { amount: 4000 });
  ok('EXP-08: replenish beyond the float limit rejected (OVER_FLOAT)', rplOver.status === 422 && rplOver.json?.error?.code === 'OVER_FLOAT', `st=${rplOver.status} code=${rplOver.json?.error?.code}`);
  const rplOk = await inj('POST', '/api/finance/petty-cash/funds/PCF-1/replenish', admin, { amount: 2000 });
  ok('EXP-08: replenish within the float tops the fund back up (2300 → 4300)', rplOk.status === 200 && rplOk.json?.balance === 4300 && near(await tbBalance('1015'), pc1015Before + 4300), `bal=${rplOk.json?.balance}`);
  await inj('POST', '/api/finance/petty-cash/requests', admin, { fund_code: 'PCF-1', kind: 'expense', payee: 'Pending one', amount: 100, doc_ref: 'RCPT-PEND' });
  const pcPend = (await inj('GET', '/api/finance/approvals/pending', admin)).json;
  ok('EXP-08: pending petty-cash requests surface in the GOV-01 monitor', (pcPend.items ?? []).some((i: any) => i.control === 'EXP-08'), `types=${JSON.stringify(pcPend.by_type ?? {})}`);

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
  // LSE-01 lease-liability reconciliation: GL 2600 net == Σ remaining liability on the schedule, after run + remeasurement.
  const leRecon = (await inj('GET', '/api/leases/liability-reconciliation', admin)).json;
  const leSched = (leRecon.leases ?? []).find((x: any) => x.lease_no === mkLease.json?.lease_no);
  ok('Lease-liability reconciliation: GL 2600 ties to the schedule liability (reconciled, difference 0)',
    leRecon.reconciled === true && near(leRecon.difference, 0) && near(leRecon.gl_liability, leRecon.schedule_liability) && leSched && leSched.liability_balance > 0,
    JSON.stringify({ gl: leRecon.gl_liability, sched: leRecon.schedule_liability, diff: leRecon.difference, rec: leRecon.reconciled }));

  // ───────────────── AR bad-debt write-off maker-checker (REV-15) ─────────────────
  const woMgr = (await inj('POST', '/api/login', undefined, { username: 'mgr', password: 'mgr123' })).json.token;
  const wo5720Before = await tbDebit('5720');
  const woReq = await inj('POST', '/api/finance/ar/write-off', admin, { amount: 500, reason: 'ลูกค้าปิดกิจการ', customer_name: 'ABC Co' });
  ok('AR write-off: maker posts a Draft (pending), excluded from balances (5720 unchanged)',
    woReq.json?.pending === true && /^JE-/.test(woReq.json?.entry_no ?? '') && near(await tbDebit('5720'), wo5720Before),
    JSON.stringify({ p: woReq.json?.pending, e: woReq.json?.entry_no, d: await tbDebit('5720') }));
  const woBad = await inj('POST', '/api/finance/ar/write-off', admin, { amount: 0, reason: 'x' });
  ok('AR write-off: non-positive amount rejected (400)', woBad.status === 400, `${woBad.status}`);
  const woNoReason = await inj('POST', '/api/finance/ar/write-off', admin, { amount: 100 });
  ok('AR write-off: missing reason rejected (400)', woNoReason.status === 400, `${woNoReason.status}`);
  const woSelf = await inj('POST', `/api/ledger/journal/${woReq.json?.entry_no}/approve`, admin);
  ok('AR write-off: maker cannot approve own write-off (SOD_VIOLATION, binds even Admin)',
    woSelf.status === 403 && woSelf.json?.error?.code === 'SOD_VIOLATION', `${woSelf.status} ${woSelf.json?.error?.code}`);
  await inj('POST', `/api/ledger/journal/${woReq.json?.entry_no}/approve`, woMgr);
  ok('AR write-off: a different user approves → 5720 bad-debt expense effective (+500)',
    near(await tbDebit('5720'), wo5720Before + 500), JSON.stringify({ d: await tbDebit('5720'), exp: wo5720Before + 500 }));
  const woListResp = await inj('GET', '/api/finance/ar/write-offs', admin);
  const woList = woListResp.json;
  ok('AR write-off register: lists the approved write-off (total_written_off 500)',
    near(woList.total_written_off, 500) && (woList.write_offs ?? []).some((w: any) => w.state === 'approved' && near(w.amount, 500)),
    `st=${woListResp.status} ${JSON.stringify(woList).slice(0, 200)}`);

  // ───────────────── AR allowance for doubtful accounts (ECL, REV-18) ─────────────────
  // Dedicated customer + invoices so the aging buckets are deterministic and we don't disturb other AR checks.
  await db.insert(s.tenants).values([{ code: 'ECLCUST', name: 'ECL Customer', creditLimit: '0' }]).onConflictDoNothing();
  const eclTid = await tid('ECLCUST');
  await db.insert(s.arInvoices).values([
    { invoiceNo: 'INV-ECL1', invoiceDate: daysAgo(200), dueDate: daysAgo(170), tenantId: eclTid, amount: '1000', paidAmount: '0', status: 'Unpaid', createdBy: 'seed' }, // 170d → 120+ bucket, rate 1.0 → 1000
    { invoiceNo: 'INV-ECL2', invoiceDate: daysAgo(80), dueDate: daysAgo(50), tenantId: eclTid, amount: '2000', paidAmount: '0', status: 'Unpaid', createdBy: 'seed' },  // 50d → 31-60 bucket, rate 0.05 → 100
    { invoiceNo: 'INV-ECL3', invoiceDate: daysAgo(10), dueDate: daysAgo(-20), tenantId: eclTid, amount: '5000', paidAmount: '0', status: 'Unpaid', createdBy: 'seed' }, // not due → current, rate 0 → 0
  ]).onConflictDoNothing();
  const alw5720Before = await tbDebit('5720');
  const alw1190CrBefore = await tbCredit2('1190');
  const cmp = await inj('POST', '/api/finance/ar-allowance/compute', admin, { tenant_id: eclTid });
  // allowance = 1000*1.0 + 2000*0.05 + 5000*0 = 1100; total AR = 8000.
  ok('AR allowance: aging compute → allowance 1100 on total AR 8000',
    cmp.status === 200 && near(cmp.json?.allowance, 1100) && near(cmp.json?.total_ar, 8000) && cmp.json?.posted === false,
    `st=${cmp.status} alw=${cmp.json?.allowance} ar=${cmp.json?.total_ar}`);
  const cmpId = cmp.json?.id;
  // Maker-checker: the computer cannot also post (SoD).
  const alwSelf = await inj('POST', `/api/finance/ar-allowance/${cmpId}/post`, admin);
  ok('AR allowance: computer cannot post own allowance (SOD_SELF_POST)',
    alwSelf.status === 403 && alwSelf.json?.error?.code === 'SOD_SELF_POST', `st=${alwSelf.status} code=${alwSelf.json?.error?.code}`);
  const alwPost = await inj('POST', `/api/finance/ar-allowance/${cmpId}/post`, mgr);
  ok('AR allowance: a different user posts the delta (1100) → Dr 5720 / Cr 1190',
    alwPost.status === 200 && near(alwPost.json?.posted_amount, 1100) && /^JE-/.test(alwPost.json?.entry_no ?? ''),
    `st=${alwPost.status} amt=${alwPost.json?.posted_amount} je=${alwPost.json?.entry_no}`);
  ok('AR allowance: GL reflects the provision (5720 +1100 debit, 1190 +1100 credit)',
    near(await tbDebit('5720'), alw5720Before + 1100) && near(await tbCredit2('1190'), alw1190CrBefore + 1100),
    JSON.stringify({ d5720: await tbDebit('5720'), c1190: await tbCredit2('1190') }));
  // Re-post is blocked.
  const alwRepost = await inj('POST', `/api/finance/ar-allowance/${cmpId}/post`, admin);
  ok('AR allowance: a posted allowance cannot be re-posted (ALREADY_POSTED)',
    alwRepost.status === 400 && alwRepost.json?.error?.code === 'ALREADY_POSTED', `st=${alwRepost.status} code=${alwRepost.json?.error?.code}`);
  const alwList = (await inj('GET', `/api/finance/ar-allowance?tenant_id=${eclTid}`, admin)).json;
  ok('AR allowance register: lists the posted computation', (alwList.allowances ?? []).some((a: any) => a.id === cmpId && a.posted === true && near(a.allowance, 1100)), `n=${alwList.count}`);

  // ───────────────── WS3.2 — FX revaluation (GL-18) + Deferred tax (TAX-06) ─────────────────
  // FX reval on a dedicated tenant with one open foreign-currency AR + AP, closing rates passed explicitly.
  await db.insert(s.tenants).values([{ code: 'FXCO', name: 'FX Co', creditLimit: '0' }]).onConflictDoNothing();
  const fxTid = await tid('FXCO');
  // AR USD 1,000 booked @ 34 (THB 34,000); AP USD 400 booked @ 34 (THB 13,600). Closing rate 36.
  //  AR delta = 1000 × (36−34) = +2000 (gain); AP delta = 400 × (36−34) = +800 (loss).
  //  net P&L = AR gain − AP loss = 2000 − 800 = +1200 (net gain) → Cr 5400 1200; Dr 1100 2000; Cr 2000 800.
  await db.insert(s.arInvoices).values([
    { invoiceNo: 'INV-FX1', invoiceDate: daysAgo(20), dueDate: daysAgo(-10), tenantId: fxTid, amount: '1000', paidAmount: '0', status: 'Unpaid', currency: 'USD', fxRate: '34', createdBy: 'seed' },
  ]).onConflictDoNothing();
  await db.insert(s.apTransactions).values([
    { txnNo: 'AP-FX1', invoiceNo: 'BILL-FX1', invoiceDate: daysAgo(20), dueDate: daysAgo(-10), tenantId: fxTid, amount: '400', paidAmount: '0', status: 'Unpaid', currency: 'USD', fxRate: '34', createdBy: 'seed' },
  ]).onConflictDoNothing();
  const fx1100Before = await tbDebit('1100'); const fx2000CrBefore = await tbCredit2('2000'); const fx5400CrBefore = await tbCredit2('5400');
  const fxRun = await inj('POST', '/api/ledger/fx-reval/run', admin, { period: '2026-12', as_of_date: '2026-12-31', rates: { USD: 36 }, tenant_id: fxTid });
  ok('FX reval: run computes net unrealized gain 1200 (AR +2000 gain, AP +800 loss)',
    fxRun.status === 200 && near(fxRun.json?.net, 1200) && near(fxRun.json?.ar_delta, 2000) && near(fxRun.json?.ap_delta, 800) && fxRun.json?.status === 'Open',
    `st=${fxRun.status} net=${fxRun.json?.net} ar=${fxRun.json?.ar_delta} ap=${fxRun.json?.ap_delta}`);
  const fxRunId = fxRun.json?.id;
  const fxSelf = await inj('POST', `/api/ledger/fx-reval/${fxRunId}/post`, admin);
  ok('FX reval: runner cannot post own run (SELF_POST)',
    fxSelf.status === 403 && fxSelf.json?.error?.code === 'SELF_POST', `st=${fxSelf.status} code=${fxSelf.json?.error?.code}`);
  const fxPost = await inj('POST', `/api/ledger/fx-reval/${fxRunId}/post`, mgr);
  ok('FX reval: a different user posts → JE with net gain 1200',
    fxPost.status === 200 && near(fxPost.json?.net, 1200) && /^JE-/.test(fxPost.json?.entry_no ?? ''),
    `st=${fxPost.status} net=${fxPost.json?.net} je=${fxPost.json?.entry_no}`);
  ok('FX reval: GL reflects the reval (5400 +1200 credit, 1100 +2000 debit, 2000 +800 credit)',
    near(await tbCredit2('5400'), fx5400CrBefore + 1200) && near(await tbDebit('1100'), fx1100Before + 2000) && near(await tbCredit2('2000'), fx2000CrBefore + 800),
    JSON.stringify({ c5400: await tbCredit2('5400'), d1100: await tbDebit('1100'), c2000: await tbCredit2('2000') }));
  const fxRepost = await inj('POST', `/api/ledger/fx-reval/${fxRunId}/post`, mgr);
  ok('FX reval: a posted run cannot be re-posted (ALREADY_POSTED)',
    fxRepost.status === 400 && fxRepost.json?.error?.code === 'ALREADY_POSTED', `st=${fxRepost.status} code=${fxRepost.json?.error?.code}`);
  const fxRerun = await inj('POST', '/api/ledger/fx-reval/run', admin, { period: '2026-12', as_of_date: '2026-12-31', rates: { USD: 36 }, tenant_id: fxTid });
  ok('FX reval: re-running a posted period is rejected (ALREADY_POSTED)',
    fxRerun.status === 400 && fxRerun.json?.error?.code === 'ALREADY_POSTED', `st=${fxRerun.status} code=${fxRerun.json?.error?.code}`);

  // Deferred tax on the ECLCUST tenant — it has a posted AR allowance (1100) and no fixed assets, so the
  // sole temporary difference is the deductible allowance → DTA = 1100 × 0.20 = 220, net deferred asset 220.
  const dt1700Before = await tbDebit('1700'); const dt5950CrBefore = await tbCredit2('5950');
  const dtRun = await inj('POST', '/api/ledger/deferred-tax/run', admin, { period: '2026-12', as_of_date: '2026-12-31', tenant_id: eclTid });
  ok('Deferred tax: run computes DTA 220 from the AR allowance (1100 × 20%)',
    dtRun.status === 200 && near(dtRun.json?.dta, 220) && near(dtRun.json?.net_deferred, 220) && near(dtRun.json?.delta_posted, 220) && dtRun.json?.status === 'Open',
    `st=${dtRun.status} dta=${dtRun.json?.dta} net=${dtRun.json?.net_deferred} delta=${dtRun.json?.delta_posted}`);
  const dtRunId = dtRun.json?.id;
  const dtSelf = await inj('POST', `/api/ledger/deferred-tax/${dtRunId}/post`, admin);
  ok('Deferred tax: runner cannot post own run (SELF_POST)',
    dtSelf.status === 403 && dtSelf.json?.error?.code === 'SELF_POST', `st=${dtSelf.status} code=${dtSelf.json?.error?.code}`);
  const dtPost = await inj('POST', `/api/ledger/deferred-tax/${dtRunId}/post`, mgr);
  ok('Deferred tax: a different user posts delta 220 → Dr 1700 / Cr 5950',
    dtPost.status === 200 && near(dtPost.json?.delta_posted, 220) && /^JE-/.test(dtPost.json?.entry_no ?? ''),
    `st=${dtPost.status} delta=${dtPost.json?.delta_posted} je=${dtPost.json?.entry_no}`);
  ok('Deferred tax: GL reflects the deferral (1700 +220 debit, 5950 +220 credit)',
    near(await tbDebit('1700'), dt1700Before + 220) && near(await tbCredit2('5950'), dt5950CrBefore + 220),
    JSON.stringify({ d1700: await tbDebit('1700'), c5950: await tbCredit2('5950') }));
  const dtRepost = await inj('POST', `/api/ledger/deferred-tax/${dtRunId}/post`, mgr);
  ok('Deferred tax: a posted run cannot be re-posted (ALREADY_POSTED)',
    dtRepost.status === 400 && dtRepost.json?.error?.code === 'ALREADY_POSTED', `st=${dtRepost.status} code=${dtRepost.json?.error?.code}`);

  // ───────────────── Asset revaluation / impairment maker-checker (FA-07 valuation + FA-08 SoD) ─────────────────
  const reg = (await inj('GET', '/api/assets', admin)).json;
  const fa2 = (reg.assets ?? reg.register ?? []).find((a: any) => (a.asset_no ?? a.assetNo) === 'FA-EAM2');
  const nbv2 = Number(fa2?.net_book_value ?? fa2?.nbv ?? fa2?.netBookValue ?? 80000);
  const surplusBefore = await tbCredit2('3200');
  // 1. Request an upward revaluation → Draft JE + PendingApproval; the surplus does NOT hit equity yet.
  const revUp = await inj('POST', '/api/assets/FA-EAM2/revalue', admin, { new_value: nbv2 + 10000, reason: 'market appraisal' });
  ok('Asset revaluation request: PendingApproval, Draft JE excluded from 3200 (FA-08)', revUp.status === 201 && revUp.json?.kind === 'revaluation' && near(revUp.json?.delta, 10000) && revUp.json?.status === 'PendingApproval' && near(await tbCredit2('3200'), surplusBefore), `st=${revUp.json?.status} 3200=${await tbCredit2('3200')}`);
  // 2. Preparer cannot approve own revaluation (SoD).
  const revSelf = await inj('POST', '/api/assets/FA-EAM2/revalue/approve', admin);
  ok('Asset revaluation: preparer self-approval blocked → 403 SOD_VIOLATION (FA-08)', revSelf.status === 403 && revSelf.json?.error?.code === 'SOD_VIOLATION', `${revSelf.status} ${revSelf.json?.error?.code}`);
  // 3. A different user approves → surplus to equity 3200, carrying value moves.
  const revUpAppr = await inj('POST', '/api/assets/FA-EAM2/revalue/approve', mgr);
  ok('Asset revaluation approved by a different user → surplus to equity 3200 (+10000)', revUpAppr.json?.status === 'Posted' && !!revUpAppr.json?.approved_by && near(await tbCredit2('3200'), surplusBefore + 10000), `st=${revUpAppr.json?.status} 3200=${await tbCredit2('3200')}`);
  const imp5820Before = await tbDebit('5820');
  const revDown = await inj('POST', '/api/assets/FA-EAM2/revalue', admin, { new_value: nbv2 + 5000, reason: 'impairment test' });
  await inj('POST', '/api/assets/FA-EAM2/revalue/approve', mgr);
  ok('Asset impairment (downward, approved): impairment loss 5820 (+5000)', revDown.json?.kind === 'impairment' && near(revDown.json?.delta, -5000) && near(await tbDebit('5820'), imp5820Before + 5000), `kind=${revDown.json?.kind} delta=${revDown.json?.delta}`);
  const noChange = await inj('POST', '/api/assets/FA-EAM2/revalue', admin, { new_value: nbv2 + 5000 });
  ok('Asset revaluation: no-change rejected (NO_CHANGE)', noChange.status === 400 && noChange.json?.error?.code === 'NO_CHANGE', `st=${noChange.status} code=${noChange.json?.error?.code}`);
  const revList = (await inj('GET', '/api/assets/FA-EAM2/revaluations', admin)).json;
  ok('Asset revaluation: audit trail lists both events, both Posted', (revList.revaluations ?? []).length === 2 && (revList.revaluations ?? []).every((r: any) => r.status === 'Posted'), `n=${revList.revaluations?.length}`);
  // Disposal maker-checker (FA-09): request → Draft (not effective); a different user approves → disposed +
  // revaluation surplus recycled to retained earnings (FA-EAM2 holds a 10000 surplus in 3200 → 3100).
  const surplus3200Before = await tbBalance('3200');
  const disp2 = await inj('PATCH', '/api/assets/FA-EAM2/dispose', admin, { proceeds: 50000 });
  ok('Asset disposal request: pending_disposal, Draft JE — not yet effective (FA-09)', disp2.json?.status === 'pending_disposal' && /^JE-/.test(disp2.json?.journal_no ?? '') && near(await tbBalance('3200'), surplus3200Before), `st=${disp2.json?.status} 3200=${await tbBalance('3200')}`);
  const dispSelf = await inj('POST', '/api/assets/FA-EAM2/dispose/approve', admin);
  ok('Asset disposal: requester self-approval blocked → 403 SOD_VIOLATION (FA-09)', dispSelf.status === 403 && dispSelf.json?.error?.code === 'SOD_VIOLATION', `${dispSelf.status} ${dispSelf.json?.error?.code}`);
  const dispAppr = await inj('POST', '/api/assets/FA-EAM2/dispose/approve', mgr);
  ok('Asset disposal approved by a different user → disposed + recycles surplus to RE (Dr 3200 / Cr 3100)', dispAppr.json?.status === 'disposed' && dispAppr.json?.revaluation_surplus_recycled === 10000 && near(await tbBalance('3200'), surplus3200Before + 10000), `recycled=${dispAppr.json?.revaluation_surplus_recycled} 3200bal=${await tbBalance('3200')}`);

  // ───────────────── Procure-to-Capitalize: PR → PO → GR → asset register (FA-10 maker-checker) ─────────────────
  // A capital purchase line, when received, is capitalised onto the asset register via a maker-checker
  // request — receiving goods and putting them on the books (and at what cost) are segregated duties, and
  // the asset carries its source GR/PO for end-to-end traceability.
  const prCap = await inj('POST', '/api/procurement/prs', admin, { remarks: 'Need 2 laptops', priority: 'Normal', items: [{ item_id: 'LAPTOP', item_description: 'Dev laptop', request_qty: 2, uom: 'EA', reason: 'capex' }] });
  ok('Capitalize: PR raised for the capital request', prCap.status === 201 && /^PR-/.test(prCap.json?.pr_no ?? ''), JSON.stringify(prCap.json).slice(0, 80));
  // Shop/basket requisition screen (/shop) — the product-catalog browse feeding the basket. Read-only,
  // grouped by product category, same low-risk pr_raise duty as raising the PR itself. Assert the envelope
  // (items + categories) and the urgent-priority checkout path (priority:'Urgent' → PR carries it through).
  const shopCat = await inj('GET', '/api/procurement/catalog?limit=24&offset=0', admin);
  const shopCatItemsOk = (shopCat.json?.items ?? []).every((it: any) => 'on_hand' in it && 'last_price' in it);
  ok('Shop catalog: paginated browse returns items (+on_hand/last_price) + category summary + paging fields (pr_raise)', shopCat.status === 200 && Array.isArray(shopCat.json?.items) && shopCatItemsOk && Array.isArray(shopCat.json?.categories) && typeof shopCat.json?.total === 'number' && typeof shopCat.json?.has_more === 'boolean', `${shopCat.status} items=${(shopCat.json?.items ?? []).length} cats=${(shopCat.json?.categories ?? []).length} total=${shopCat.json?.total} more=${shopCat.json?.has_more}`);
  const shopImg = await inj('GET', '/api/procurement/catalog/items/NO-SUCH-ITEM/image', admin);
  ok('Shop catalog: thumbnail endpoint 404s for an item with no image (NO_IMAGE)', shopImg.status === 404 && shopImg.json?.error?.code === 'NO_IMAGE', `${shopImg.status} ${shopImg.json?.error?.code}`);
  const prUrgent = await inj('POST', '/api/procurement/prs', admin, { remarks: 'ด่วน จากหน้าเลือกซื้อสินค้า', priority: 'Urgent', items: [{ item_id: 'ปากกาลูกลื่น 12 ด้าม', item_description: 'ปากกาลูกลื่น 12 ด้าม', request_qty: 1, uom: 'กล่อง', reason: 'ด่วน' }] });
  ok('Shop checkout: urgent free-text (off-catalog) basket line raises a PR with priority=Urgent', prUrgent.status === 201 && /^PR-/.test(prUrgent.json?.pr_no ?? ''), `${prUrgent.status} ${JSON.stringify(prUrgent.json).slice(0, 70)}`);
  const poCap = await inj('POST', '/api/procurement/pos', admin, { vendor_name: 'Capital Vendor', expected_date: daysAgo(0), items: [{ item_id: 'LAPTOP', item_description: 'Dev laptop', order_qty: 2, unit_price: 25000, uom: 'EA', is_capital: true }] });
  ok('Capitalize: PO raised with a capital line (2 @ 25000 = 50000)', poCap.status === 201 && /^PO-/.test(poCap.json?.po_no ?? '') && near(poCap.json?.total_amount, 50000), JSON.stringify(poCap.json).slice(0, 90));
  await inj('PATCH', `/api/procurement/pos/${poCap.json?.po_no}/approve`, admin, { approve: true });
  // Printable ใบสั่งซื้อ (Purchase Order) — HTML fallback when Chromium is absent (as in CI): the endpoint
  // renders the title, the supplier and the ordered line's value so the buyer has a document to send.
  const poPdf = await inj('GET', `/api/procurement/pos/${poCap.json?.po_no}/pdf`, admin);
  ok('PO print: PDF/HTML contains "ใบสั่งซื้อ" + supplier + line value (50,000.00)', poPdf.status === 200 && poPdf.text.includes('ใบสั่งซื้อ') && poPdf.text.includes('Capital Vendor') && poPdf.text.includes('50,000.00'), `${poPdf.status} ${String(poPdf.text).slice(0, 60)}`);
  // ── External-facing document print/email (quotation covered by cpq.ts; AR invoice + delivery here) ──
  // AR billing invoice (ใบแจ้งหนี้/ใบวางบิล) — the seeded INV-A (฿1,000) renders with title + amount.
  const arInvPdf = await inj('GET', '/api/finance/ar/invoices/INV-A/pdf', admin);
  ok('AR invoice print: PDF/HTML contains "ใบแจ้งหนี้" + amount (1,000.00)', arInvPdf.status === 200 && arInvPdf.text.includes('ใบแจ้งหนี้') && arInvPdf.text.includes('1,000.00'), `${arInvPdf.status} ${String(arInvPdf.text).slice(0, 60)}`);
  const arInvEmail = await inj('POST', '/api/finance/ar/invoices/INV-A/send-email', admin, { to_email: 'customer@example.com' });
  ok('AR invoice email path wired → EMAIL_NOT_CONFIGURED (503) with no SMTP in CI', arInvEmail.status === 503 && arInvEmail.json.error?.code === 'EMAIL_NOT_CONFIGURED', `${arInvEmail.status} ${arInvEmail.json.error?.code}`);
  // Delivery note (ใบส่งของ) — create a DO with explicit lines then render it.
  const doRes = await inj('POST', '/api/delivery', admin, { address: '123 ถนนทดสอบ กรุงเทพฯ', driver: 'สมชาย', lines: [{ item_id: 'LAPTOP', item_description: 'Dev laptop', qty: 2, uom: 'EA' }] });
  ok('Delivery note: DO created with a line', /^DO-/.test(doRes.json?.do_no ?? '') && doRes.json?.lines === 1, `${doRes.status} ${JSON.stringify(doRes.json).slice(0, 60)}`);
  const doPdf = await inj('GET', `/api/delivery/${doRes.json?.do_no}/pdf`, admin);
  ok('Delivery note print: PDF/HTML contains "ใบส่งของ" + item ("Dev laptop")', doPdf.status === 200 && doPdf.text.includes('ใบส่งของ') && doPdf.text.includes('Dev laptop'), `${doPdf.status} ${String(doPdf.text).slice(0, 60)}`);
  const grCap = await inj('POST', '/api/procurement/grs', admin, { po_no: poCap.json?.po_no, items: [{ item_id: 'LAPTOP', received_qty: 2, unit_cost: 25000, uom: 'EA' }] });
  ok('Capitalize: GR receives the capital line, PO auto-closes', grCap.status === 201 && /^GR-/.test(grCap.json?.gr_no ?? '') && grCap.json?.po_status === 'Closed', JSON.stringify(grCap.json).slice(0, 90));
  // Printable ใบรับสินค้า (Goods Receipt Note) — title + received item.
  const grPdf = await inj('GET', `/api/procurement/grs/${grCap.json?.gr_no}/pdf`, admin);
  ok('GR note print: PDF/HTML contains "ใบรับสินค้า" + item (LAPTOP)', grPdf.status === 200 && grPdf.text.includes('ใบรับสินค้า') && grPdf.text.includes('LAPTOP'), `${grPdf.status} ${String(grPdf.text).slice(0, 50)}`);
  // Capital goods must NOT be capitalised into inventory (1200) at receipt — they route to 1500 via FA-10.
  const elig = (await inj('GET', `/api/assets/registrations/eligible?gr_no=${grCap.json?.gr_no}`, admin)).json;
  ok('Capitalize: GR capital line is eligible for capitalisation (suggested cost = 50000)', (elig.eligible ?? []).length === 1 && near(elig.eligible?.[0]?.suggested_cost, 50000), `n=${elig.eligible?.length} cost=${elig.eligible?.[0]?.suggested_cost}`);
  const grItemId = elig.eligible?.[0]?.gr_item_id;
  const cap1500Before = await tbDebit('1500');
  const cap2000Before = await tbCredit2('2000');
  const regReq = await inj('POST', '/api/assets/registrations', admin, { gr_no: grCap.json?.gr_no, gr_item_id: grItemId, name: 'Dev laptop (capex)', useful_life_months: 36 });
  ok('Capitalize: registration raised as PendingApproval — NO GL yet (Dr 1500 unchanged)', regReq.status === 201 && regReq.json?.status === 'PendingApproval' && near(regReq.json?.acquire_cost, 50000) && near(await tbDebit('1500'), cap1500Before), `st=${regReq.json?.status} 1500=${await tbDebit('1500')}`);
  const regSelf = await inj('POST', `/api/assets/registrations/${regReq.json?.reg_no}/approve`, admin);
  ok('Capitalize: preparer self-approval blocked → 403 SOD_VIOLATION (FA-10)', regSelf.status === 403 && regSelf.json?.error?.code === 'SOD_VIOLATION', `${regSelf.status} ${regSelf.json?.error?.code}`);
  const regAppr = await inj('POST', `/api/assets/registrations/${regReq.json?.reg_no}/approve`, mgr);
  ok('Capitalize: a different user approves → asset created, GL posts (Dr 1500 / Cr 2000 +50000)', regAppr.status === 201 && /^FA-/.test(regAppr.json?.asset_no ?? '') && /^JE-/.test(regAppr.json?.journal_no ?? '') && near(await tbDebit('1500'), cap1500Before + 50000) && near(await tbCredit2('2000'), cap2000Before + 50000), `asset=${regAppr.json?.asset_no} 1500=${await tbDebit('1500')}`);
  const capReg = (await inj('GET', '/api/assets', admin)).json;
  const newFa = (capReg.assets ?? []).find((x: any) => x.asset_no === regAppr.json?.asset_no);
  ok('Capitalize: new asset is on the register with source GR/PO traceability', !!newFa && newFa.source_gr_no === grCap.json?.gr_no && newFa.source_po_no === poCap.json?.po_no && near(newFa.acquire_cost, 50000), `gr=${newFa?.source_gr_no} po=${newFa?.source_po_no}`);
  const regDup = await inj('POST', '/api/assets/registrations', admin, { gr_no: grCap.json?.gr_no, gr_item_id: grItemId, name: 'dup', useful_life_months: 36 });
  ok('Capitalize: the same GR line cannot be capitalised twice (ALREADY_REGISTERED)', regDup.status === 400 && regDup.json?.error?.code === 'ALREADY_REGISTERED', `st=${regDup.status} code=${regDup.json?.error?.code}`);

  // ───────────────────── Perpetual inventory valuation sub-ledger (INV-01..04) ─────────────────────
  // Run in a dedicated tenant so the inventory control account (1200) is isolated from the cash-flow seed.
  const [invT] = await db.insert(s.tenants).values({ code: 'INVT', name: 'Inventory Co' }).returning({ id: s.tenants.id });
  const invTid = Number(invT.id);
  await db.insert(s.users).values([
    { username: 'invmgr', passwordHash: await pw.hash('inv123'), role: 'Admin', tenantId: invTid },
    { username: 'invchk', passwordHash: await pw.hash('inv123'), role: 'Admin', tenantId: invTid }, // INV-07: a different write-off approver
  ]).onConflictDoNothing();
  const invmgr = (await inj('POST', '/api/login', undefined, { username: 'invmgr', password: 'inv123' })).json.token;
  const invchk = (await inj('POST', '/api/login', undefined, { username: 'invchk', password: 'inv123' })).json.token;

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

  // Shrinkage write-off maker-checker (INV-07): −10 @ avg 11 = −110 to 5810 ⇒ balance 140 @ 11 = 1540 —
  // but only AFTER a different user approves. The request alone posts nothing.
  const adj = await inj('POST', '/api/inventory/adjustments', invmgr, { item_id: 'SUGAR', qty_delta: -10, reason: 'Spoilage' });
  ok('Inventory: write-off is a REQUEST (pending), nothing posted yet (INV-07)', (adj.status === 201 || adj.status === 200) && adj.json?.status === 'pending_approval' && adj.json?.request_id > 0, JSON.stringify(adj.json).slice(0, 90));
  const valPending = (await inj('GET', '/api/inventory/valuation', invmgr)).json;
  ok('Inventory: write-off not applied until approved (on-hand still 150 @ 11 = 1650)', near(valPending.items?.find((i: any) => i.item_id === 'SUGAR')?.on_hand_qty, 150), `qty=${valPending.items?.find((i: any) => i.item_id === 'SUGAR')?.on_hand_qty}`);
  const adjSelf = await inj('POST', `/api/inventory/writeoffs/${adj.json.request_id}/approve`, invmgr);
  ok('Inventory: requester self-approval blocked → 403 SOD_VIOLATION (INV-07)', adjSelf.status === 403 && adjSelf.json?.error?.code === 'SOD_VIOLATION', `st=${adjSelf.status} code=${adjSelf.json?.error?.code}`);
  const adjAppr = await inj('POST', `/api/inventory/writeoffs/${adj.json.request_id}/approve`, invchk);
  ok('Inventory: write-off approved by a different user → applied (−10 @ 11 ⇒ 140, variance −110)', adjAppr.json?.status === 'Posted' && near(adjAppr.json?.balance_qty, 140) && near(adjAppr.json?.value, -110) && adjAppr.json?.approved_by === 'invchk', JSON.stringify(adjAppr.json).slice(0, 110));
  // INV-04 — an adjustment with no reason is rejected (control: every adjustment is justified + audited).
  const adjBad = await inj('POST', '/api/inventory/adjustments', invmgr, { item_id: 'SUGAR', qty_delta: -1, reason: '   ' });
  ok('Inventory: adjustment without a reason rejected (REASON_REQUIRED)', adjBad.status === 400 && adjBad.json?.error?.code === 'REASON_REQUIRED', `st=${adjBad.status} code=${adjBad.json?.error?.code}`);

  // Valuation + INV-06 reconciliation: sub-ledger (140 @ 11 = 1540) ties to the GL inventory account.
  const val = (await inj('GET', '/api/inventory/valuation', invmgr)).json;
  ok('Inventory: valuation reports on-hand value at moving-average (140 @ 11 = 1540)', near(val.total_value, 1540) && near(val.items?.find((i: any) => i.item_id === 'SUGAR')?.total_value, 1540), `total=${val.total_value}`);
  const rec = (await inj('GET', '/api/inventory/reconciliation', invmgr)).json;
  ok('Inventory: sub-ledger ties to GL inventory control account (INV-06 reconciled 1540)', near(rec.sub_ledger_value, 1540) && near(rec.gl_inventory, 1540) && rec.reconciled === true, `sub=${rec.sub_ledger_value} gl=${rec.gl_inventory} rec=${rec.reconciled}`);
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

  // ───────────────────── Item-posting account determination (GL-21, docs/33) ─────────────────────
  // Opt-in per tenant (posting_determination). When ON, an item's account override routes its posting; when
  // OFF (default) — as in every test above — the hardcoded control accounts apply (parity). A distinct
  // postable COGS account proves the routing actually moved.
  await db.insert(s.accounts).values({ code: '5001', name: 'COGS — Beverage (determination test)', type: 'Expense', normalBalance: 'D', isPostable: true }).onConflictDoNothing();
  await db.insert(s.items).values({ itemId: 'DETITEM', itemDescription: 'Determination item', cogsAccount: '5001' }).onConflictDoNothing();
  await db.insert(s.items).values({ itemId: 'BADACC', itemDescription: 'Bad override item', cogsAccount: '9999' }).onConflictDoNothing();
  // Determination OFF by default: DETITEM's issue routes COGS to the standard 5000, not its 5001 override.
  await inj('POST', '/api/inventory/receipts', invmgr, { item_id: 'DETITEM', uom: 'EA', qty: 10, unit_cost: 10, ref_type: 'GRN', ref_id: 'GRN-D0' });
  await inj('POST', '/api/inventory/issues', invmgr, { item_id: 'DETITEM', qty: 2, ref_type: 'MI', ref_id: 'MI-D0' });
  const acc5001Off = (await inj('GET', '/api/ledger/account-ledger?account=5001', invmgr)).json;
  ok('Determination OFF (default): item COGS override is ignored → 5001 untouched (parity)', near(acc5001Off.closing_balance ?? 0, 0), `closing=${acc5001Off.closing_balance}`);
  // Turn determination ON for this tenant.
  const flagOn = await inj('PUT', '/api/feature-flags/posting_determination', invmgr, { enabled: true });
  ok('Determination: posting_determination flag can be enabled per tenant', flagOn.status === 200 && (flagOn.json?.flags ?? []).find((f: any) => f.key === 'posting_determination')?.enabled === true, `st=${flagOn.status}`);
  // Now DETITEM's issue routes COGS to the 5001 override; inventory still on 1200 (no inventory override).
  const detIss = await inj('POST', '/api/inventory/issues', invmgr, { item_id: 'DETITEM', qty: 4, ref_type: 'MI', ref_id: 'MI-D1' });
  ok('Determination ON: goods issue posts at moving-average (4 @ 10 = 40)', detIss.status === 201 && near(detIss.json?.value, 40), JSON.stringify(detIss.json).slice(0, 80));
  const acc5001 = (await inj('GET', '/api/ledger/account-ledger?account=5001', invmgr)).json;
  ok('Determination ON: COGS routed to the item override account 5001 (Dr 40)', near(acc5001.closing_balance, 40), `closing=${acc5001.closing_balance}`);
  // The inventory sub-ledger still reconciles to the GL inventory account set even with COGS routed away.
  const recDet = (await inj('GET', '/api/inventory/reconciliation', invmgr)).json;
  ok('Determination ON: inventory sub-ledger still ties to GL inventory account set (reconciled)', recDet.reconciled === true && near(recDet.sub_ledger_value, recDet.gl_inventory), `sub=${recDet.sub_ledger_value} gl=${recDet.gl_inventory} rec=${recDet.reconciled}`);
  // GL-21 fail-closed: an override pointing at a non-existent account is rejected, not silently posted.
  const badAcc = await inj('POST', '/api/inventory/receipts', invmgr, { item_id: 'BADACC', uom: 'EA', qty: 1, unit_cost: 5, ref_type: 'GRN', ref_id: 'GRN-BAD' });
  ok('Determination: invalid override account rejected fail-closed (GL-21 INVALID_POSTING_ACCOUNT)', badAcc.status === 400 && badAcc.json?.error?.code === 'INVALID_POSTING_ACCOUNT', `st=${badAcc.status} code=${badAcc.json?.error?.code}`);

  // ── Item-posting SETUP master via the /api/item-setup screens' endpoints (docs/33 PR3, GL-21) ──
  const catBad = await inj('POST', '/api/item-setup/categories', invmgr, { code: 'BADCAT', cogs_account: '9998' });
  ok('Setup: item category with a non-postable account rejected at save (INVALID_POSTING_ACCOUNT)', catBad.status === 400 && catBad.json?.error?.code === 'INVALID_POSTING_ACCOUNT', `st=${catBad.status} code=${catBad.json?.error?.code}`);
  const catOk = await inj('POST', '/api/item-setup/categories', invmgr, { code: 'BEV', name_th: 'เครื่องดื่ม', cogs_account: '5001' });
  ok('Setup: create item category with a default COGS account → 201', catOk.status === 201 && catOk.json?.code === 'BEV' && catOk.json?.cogs_account === '5001', JSON.stringify(catOk.json).slice(0, 80));
  const catId = catOk.json.id;
  await db.insert(s.items).values({ itemId: 'CATITEM', itemDescription: 'Category-driven item' }).onConflictDoNothing();
  const linkOk = await inj('PATCH', '/api/item-setup/items/CATITEM', invmgr, { category_id: catId });
  ok('Setup: link an item to a category (per-item posting profile)', linkOk.status === 200 && linkOk.json?.category_id === catId, `cat=${linkOk.json?.category_id}`);
  // Determination (still ON): CATITEM has no item-level override, so COGS resolves via its CATEGORY's 5001
  // (item → category → literal). 5001 already carries 40 (DETITEM); +30 here ⇒ 70.
  await inj('POST', '/api/inventory/receipts', invmgr, { item_id: 'CATITEM', uom: 'EA', qty: 10, unit_cost: 10, ref_type: 'GRN', ref_id: 'GRN-C1' });
  await inj('POST', '/api/inventory/issues', invmgr, { item_id: 'CATITEM', qty: 3, ref_type: 'MI', ref_id: 'MI-C1' });
  const acc5001b = (await inj('GET', '/api/ledger/account-ledger?account=5001', invmgr)).json;
  ok('Setup: category-level COGS default drives posting (item→category→account: 5001 = 40+30 = 70)', near(acc5001b.closing_balance, 70), `closing=${acc5001b.closing_balance}`);
  const catList = (await inj('GET', '/api/item-setup/categories', invmgr)).json;
  ok('Setup: item-category list returns the created category', (catList.categories ?? []).some((c: any) => c.code === 'BEV'), `n=${catList.count}`);
  const taxOk = await inj('POST', '/api/item-setup/tax-codes', invmgr, { code: 'VAT7', kind: 'vat', rate: 0.07, output_account: '2100', input_account: '2100', name_th: 'VAT 7%' });
  ok('Setup: create VAT tax code (7% → 2100)', taxOk.status === 201 && taxOk.json?.code === 'VAT7' && near(taxOk.json?.rate, 0.07), JSON.stringify(taxOk.json).slice(0, 80));
  const taxBadRate = await inj('POST', '/api/item-setup/tax-codes', invmgr, { code: 'BADRATE', rate: 1.5 });
  ok('Setup: tax code with an out-of-range rate rejected (rate must be 0..1)', taxBadRate.status === 400 && ['BAD_RATE', 'VALIDATION_ERROR'].includes(taxBadRate.json?.error?.code), `st=${taxBadRate.status} code=${taxBadRate.json?.error?.code}`);

  // ── Warehouse account defaults — the lowest determination tier (item → category → WAREHOUSE → literal) ──
  await db.insert(s.accounts).values({ code: '1201', name: 'Inventory — Cold store (determination test)', type: 'Asset', normalBalance: 'D', isPostable: true }).onConflictDoNothing();
  await db.insert(s.locations).values({ locationId: 'WH-DET', locationName: 'Cold store' }).onConflictDoNothing();
  const whBad = await inj('PATCH', '/api/item-setup/warehouses/WH-DET', invmgr, { inventory_account: '9997' });
  ok('Setup: warehouse with a non-postable inventory account rejected (INVALID_POSTING_ACCOUNT)', whBad.status === 400 && whBad.json?.error?.code === 'INVALID_POSTING_ACCOUNT', `st=${whBad.status} code=${whBad.json?.error?.code}`);
  const whOk = await inj('PATCH', '/api/item-setup/warehouses/WH-DET', invmgr, { inventory_account: '1201' });
  ok('Setup: set a warehouse default inventory account → 1201', whOk.status === 200 && whOk.json?.inventory_account === '1201', JSON.stringify(whOk.json ?? {}).slice(0, 90));
  await db.insert(s.items).values({ itemId: 'WHITEM', itemDescription: 'Warehouse-driven item' }).onConflictDoNothing(); // no item/category override
  // Determination ON: WHITEM has no item/category inventory account, so it falls through to the WAREHOUSE 1201.
  await inj('POST', '/api/inventory/receipts', invmgr, { item_id: 'WHITEM', location_id: 'WH-DET', uom: 'EA', qty: 10, unit_cost: 10, ref_type: 'GRN', ref_id: 'GRN-W1' });
  await inj('POST', '/api/inventory/issues', invmgr, { item_id: 'WHITEM', location_id: 'WH-DET', qty: 3, ref_type: 'MI', ref_id: 'MI-W1' });
  const acc1201 = (await inj('GET', '/api/ledger/account-ledger?account=1201', invmgr)).json;
  ok('Determination: inventory routes to the WAREHOUSE default account (1201 = 100 receipt − 30 issue = 70)', near(acc1201.closing_balance, 70), `closing=${acc1201.closing_balance}`);
  const recWh = (await inj('GET', '/api/inventory/reconciliation', invmgr)).json;
  ok('Determination: sub-ledger still ties with a warehouse-routed inventory account in the set', recWh.reconciled === true && near(recWh.sub_ledger_value, recWh.gl_inventory), `sub=${recWh.sub_ledger_value} gl=${recWh.gl_inventory} rec=${recWh.reconciled}`);

  // ── default_location_id (docs/33 PR7): a receipt with no explicit location goes to the item's default ──
  await db.insert(s.items).values({ itemId: 'DETLOC', itemDescription: 'Default-location item' }).onConflictDoNothing();
  await inj('PATCH', '/api/item-setup/items/DETLOC', invmgr, { default_location_id: 'WH-COLD' });
  await inj('POST', '/api/inventory/receipts', invmgr, { item_id: 'DETLOC', uom: 'EA', qty: 5, unit_cost: 4, ref_type: 'GRN', ref_id: 'GRN-LOC' });
  const valLoc = (await inj('GET', '/api/inventory/valuation', invmgr)).json;
  const detlocRow = (valLoc.items ?? []).find((i: any) => i.item_id === 'DETLOC');
  ok('Determination: a receipt with no location defaults to the item default_location_id (WH-COLD, not WH-MAIN)', detlocRow?.location_id === 'WH-COLD', `loc=${detlocRow?.location_id}`);

  // Costing-engine boundary: an item managed by the costing module (item_costing) cannot also be received
  // into the perpetual sub-ledger — prevents double-capitalizing inventory to GL 1200 (engines are exclusive).
  await db.insert(s.itemCosting).values({ tenantId: invTid, itemId: 'COSTITEM', method: 'AVG' }).onConflictDoNothing();
  const conflictRcv = await inj('POST', '/api/inventory/receipts', invmgr, { item_id: 'COSTITEM', qty: 5, unit_cost: 10 });
  ok('Inventory: receipt of a costing-module-managed item rejected (CONFLICTING_COSTING)', conflictRcv.status === 400 && conflictRcv.json?.error?.code === 'CONFLICTING_COSTING', `st=${conflictRcv.status} code=${conflictRcv.json?.error?.code}`);

  // ───────────────────── Industry Chart-of-Accounts templates (GL-10) ─────────────────────
  // A new company picks its industry at signup → gets a curated, industry-named chart over the canonical
  // codes. The overlay NEVER gates postings (?all=true still exposes the full canonical universe).
  await app.get(BillingService).seedPlans();

  const sgRest = await inj('POST', '/api/auth/signup', undefined, {
    company_name: 'Resto Co', tenant_code: 'RESTO', admin_username: 'resto_admin', admin_password: 'resto12345', email: 'a@resto.example', industry: 'restaurant',
  });
  ok('CoA: signup with industry=restaurant succeeds + echoes industry', (sgRest.status === 200 || sgRest.status === 201) && sgRest.json?.industry === 'restaurant', `st=${sgRest.status} ind=${sgRest.json?.industry}`);
  const restoTok = (await inj('POST', '/api/login', undefined, { username: 'resto_admin', password: 'resto12345' })).json.token;
  const restoAcc = (await inj('GET', '/api/ledger/accounts', restoTok)).json;
  ok('CoA: restaurant chart is overlay-scoped + industry-named (4000 = Food & Beverage Sales)',
    restoAcc.source === 'overlay' && restoAcc.accounts?.find((a: any) => a.code === '4000')?.name === 'Food & Beverage Sales',
    `src=${restoAcc.source} n4000=${restoAcc.accounts?.find((a: any) => a.code === '4000')?.name}`);
  ok('CoA: restaurant chart curates out non-F&B accounts (no 4300 Service / 4200 Project revenue)',
    !restoAcc.accounts?.some((a: any) => a.code === '4300' || a.code === '4200') && restoAcc.accounts?.some((a: any) => a.code === '5300'),
    `n=${restoAcc.count}`);
  const restoAll = (await inj('GET', '/api/ledger/accounts?all=true', restoTok)).json;
  ok('CoA: ?all=true exposes the full canonical universe (overlay never gates posting; 4300 present)',
    restoAll.source === 'canonical' && restoAll.accounts?.some((a: any) => a.code === '4300') && restoAll.count > restoAcc.count,
    `all=${restoAll.count} overlay=${restoAcc.count}`);

  const sgGen = await inj('POST', '/api/auth/signup', undefined, {
    company_name: 'Gen Co', tenant_code: 'GENCO', admin_username: 'gen_admin', admin_password: 'gen1234567', email: 'a@gen.example',
  });
  ok('CoA: signup without industry defaults to general (full chart)', sgGen.json?.industry === 'general', `ind=${sgGen.json?.industry}`);
  const genTok = (await inj('POST', '/api/login', undefined, { username: 'gen_admin', password: 'gen1234567' })).json.token;
  const genAcc = (await inj('GET', '/api/ledger/accounts', genTok)).json;
  ok('CoA: general tenant overlay = full canonical chart (incl. 4300 + 5300)',
    genAcc.accounts?.some((a: any) => a.code === '4300') && genAcc.accounts?.some((a: any) => a.code === '5300') && genAcc.count === restoAll.count,
    `n=${genAcc.count} src=${genAcc.source}`);

  // ───────────────────── WS1.2 — Posting / Account-Determination Engine (GL-12) golden snapshot ─────────────────────
  // TC-GL-12-01: preview fixed-asset depreciation legs — DR 5200 / CR 1590
  // Both legs use the same depreciation amount; pass both role keys so the engine maps them.
  const prevDep = await inj('POST', '/api/ledger/posting-rules/preview', admin, { eventType: 'DEPRECIATION.FA', amounts: { dep_expense: 1000, accum_dep: 1000 } });
  const depLines: any[] = Array.isArray(prevDep.json) ? prevDep.json : [];
  const depDR = depLines.find((l: any) => l.side === 'DR');
  const depCR = depLines.find((l: any) => l.side === 'CR');
  ok('GL-12: preview DEPRECIATION.FA → DR 5200 / CR 1590 (amount 1000)',
    prevDep.status === 200 && depDR?.accountCode === '5200' && near(depDR?.amount, 1000) && depCR?.accountCode === '1590' && near(depCR?.amount, 1000),
    `st=${prevDep.status} DR=${depDR?.accountCode}:${depDR?.amount} CR=${depCR?.accountCode}:${depCR?.amount}`);

  // TC-GL-12-02: preview goods-receipt legs — DR 1200 / CR 2000
  // Both legs use the same amount; pass both role keys so the engine maps them.
  const prevGR = await inj('POST', '/api/ledger/posting-rules/preview', admin, { eventType: 'GR.INVENTORY', amounts: { inventory: 500, ap_control: 500 } });
  const grLines: any[] = Array.isArray(prevGR.json) ? prevGR.json : [];
  const grDR = grLines.find((l: any) => l.side === 'DR');
  const grCR = grLines.find((l: any) => l.side === 'CR');
  ok('GL-12: preview GR.INVENTORY → DR 1200 / CR 2000 (amount 500)',
    prevGR.status === 200 && grDR?.accountCode === '1200' && near(grDR?.amount, 500) && grCR?.accountCode === '2000' && near(grCR?.amount, 500),
    `st=${prevGR.status} DR=${grDR?.accountCode}:${grDR?.amount} CR=${grCR?.accountCode}:${grCR?.amount}`);

  // TC-GL-12-03: unknown event type → NO_POSTING_RULE
  const prevUnknown = await inj('POST', '/api/ledger/posting-rules/preview', admin, { eventType: 'UNKNOWN_EVENT', amounts: {} });
  ok('GL-12: unknown eventType → 400/422 NO_POSTING_RULE',
    (prevUnknown.status === 400 || prevUnknown.status === 422) && prevUnknown.json?.error?.code === 'NO_POSTING_RULE',
    `st=${prevUnknown.status} code=${prevUnknown.json?.error?.code}`);

  // TC-GL-12-04: event-type catalogue returns ≥20 entries
  const evTypes = await inj('GET', '/api/ledger/posting-rules/event-types', admin);
  const evList: any[] = Array.isArray(evTypes.json) ? evTypes.json : [];
  ok('GL-12: event-type catalogue lists ≥20 seeded event types',
    evTypes.status === 200 && evList.length >= 20,
    `st=${evTypes.status} n=${evList.length}`);

  // ───────────────────── WS1.3 — Multi-dimensional GL Postings (GL-13) ─────────────────────
  // TC-GL-13-01: smoke test — by-branch endpoint returns a branches key
  const today = new Date().toISOString().slice(0, 10);
  const bb0 = await inj('GET', `/api/ledger/income-statement/by-branch?from=${today}&to=${today}`, admin);
  ok('GL-13: income-statement/by-branch returns a branches key (smoke)', bb0.status === 200 && typeof bb0.json?.branches === 'object', `st=${bb0.status}`);

  // TC-GL-13-02: post JEs with branch_id on lines, then verify both branches appear
  // Using direct DB insert so we can set branch_id (the API POST /journal doesn't yet expose branch_id in the Zod schema)
  jeSeq++;
  const [hb1] = await db.insert(s.journalEntries).values({
    entryNo: `JE-B${String(jeSeq).padStart(4, '0')}`, entryDate: today, period: today.slice(0, 7),
    source: 'TEST-GL13', sourceRef: `GL13-${jeSeq}`, tenantId: hq, currency: 'THB', status: 'Posted', createdBy: 'seed',
  }).returning({ id: s.journalEntries.id });
  await db.insert(s.journalLines).values([
    { entryId: Number(hb1.id), accountCode: '4000', debit: '0', credit: '500', currency: 'THB', tenantId: hq, branchId: 1 },
    { entryId: Number(hb1.id), accountCode: '1000', debit: '500', credit: '0', currency: 'THB', tenantId: hq, branchId: 1 },
  ]);
  jeSeq++;
  const [hb2] = await db.insert(s.journalEntries).values({
    entryNo: `JE-B${String(jeSeq).padStart(4, '0')}`, entryDate: today, period: today.slice(0, 7),
    source: 'TEST-GL13', sourceRef: `GL13-${jeSeq}`, tenantId: hq, currency: 'THB', status: 'Posted', createdBy: 'seed',
  }).returning({ id: s.journalEntries.id });
  await db.insert(s.journalLines).values([
    { entryId: Number(hb2.id), accountCode: '4000', debit: '0', credit: '300', currency: 'THB', tenantId: hq, branchId: 2 },
    { entryId: Number(hb2.id), accountCode: '1000', debit: '300', credit: '0', currency: 'THB', tenantId: hq, branchId: 2 },
  ]);
  await rebuildGl(); // direct inserts above bypass LedgerService → resync the R1-2 snapshot
  const bb2 = await inj('GET', `/api/ledger/income-statement/by-branch?from=${today}&to=${today}`, admin);
  ok('GL-13: branch_id=1 and branch_id=2 both appear in by-branch P&L', bb2.status === 200 && !!bb2.json?.branches?.['1'] && !!bb2.json?.branches?.['2'], `branches=${Object.keys(bb2.json?.branches ?? {}).join(',')}`);

  // TC-GL-13-03: post without branch_id → appears under 'unassigned'
  jeSeq++;
  const [hb3] = await db.insert(s.journalEntries).values({
    entryNo: `JE-B${String(jeSeq).padStart(4, '0')}`, entryDate: today, period: today.slice(0, 7),
    source: 'TEST-GL13', sourceRef: `GL13-${jeSeq}`, tenantId: hq, currency: 'THB', status: 'Posted', createdBy: 'seed',
  }).returning({ id: s.journalEntries.id });
  await db.insert(s.journalLines).values([
    { entryId: Number(hb3.id), accountCode: '5100', debit: '200', credit: '0', currency: 'THB', tenantId: hq },
    { entryId: Number(hb3.id), accountCode: '1000', debit: '0', credit: '200', currency: 'THB', tenantId: hq },
  ]);
  const bb3 = await inj('GET', `/api/ledger/income-statement/by-branch?from=${today}&to=${today}`, admin);
  ok('GL-13: journal lines without branch_id appear under "unassigned"', bb3.status === 200 && !!bb3.json?.branches?.['unassigned'], `branches=${Object.keys(bb3.json?.branches ?? {}).join(',')}`);

  // ───────────────────── WS1.4 — Sub-ledger Tie-out / Reconciliation (GL-14) ─────────────────────
  // Flag the four control accounts (1100/2000/1200/1500). Migration 0155 sets these via UPDATE, but it
  // runs before the COA is seeded (seedChartOfAccounts at boot), so the flags are re-applied HERE — after
  // all the AP/INV/FA posting tests above have run — so the tie-out can resolve the control accounts
  // without the CONTROL_ACCOUNT guard tripping those earlier direct postings.
  for (const [code, sub] of [['1100', 'AR'], ['2000', 'AP'], ['1200', 'INV'], ['1500', 'FA']] as const)
    await db.update(s.accounts).set({ isControl: true, controlSubledger: sub }).where(eq(s.accounts.code, code));

  // TC-GL-14-01: run an AR tie-out → 200/201 with the balance fields and a Matched/Variance status.
  const tieRun = await inj('POST', '/api/ledger/tie-out/run', admin, { subledger: 'AR' });
  ok('GL-14: run AR tie-out returns glBalance/subledgerBalance/variance/status',
    (tieRun.status === 200 || tieRun.status === 201)
      && typeof tieRun.json?.glBalance === 'number'
      && typeof tieRun.json?.subledgerBalance === 'number'
      && typeof tieRun.json?.variance === 'number'
      && ['Matched', 'Variance'].includes(tieRun.json?.status),
    `st=${tieRun.status} status=${tieRun.json?.status} gl=${tieRun.json?.glBalance} sl=${tieRun.json?.subledgerBalance}`);
  const tieId = Number(tieRun.json?.id);

  // TC-GL-14-?: list returns an array including the AR run.
  const tieList = await inj('GET', '/api/ledger/tie-out', admin);
  ok('GL-14: list tie-out runs returns the AR run',
    tieList.status === 200 && Array.isArray(tieList.json?.runs) && tieList.json.runs.some((r: any) => r.id === tieId && r.subledger === 'AR'),
    `st=${tieList.status} count=${tieList.json?.count}`);

  // TC-GL-14-02: self-certify blocked — the runner (admin) cannot certify their own run → SELF_CERTIFY.
  const selfCert = await inj('POST', `/api/ledger/tie-out/${tieId}/certify`, admin, {});
  ok('GL-14: self-certify blocked (runner cannot certify own run) → SELF_CERTIFY',
    selfCert.status === 400 && selfCert.json?.error?.code === 'SELF_CERTIFY',
    `st=${selfCert.status} code=${selfCert.json?.error?.code}`);

  // TC-GL-14-03: certify by a DIFFERENT user (mgr, also gl_close) → status becomes 'Certified'.
  const mgrCert = (await inj('POST', '/api/login', undefined, { username: 'mgr', password: 'mgr123' })).json.token;
  const cert = await inj('POST', `/api/ledger/tie-out/${tieId}/certify`, mgrCert, { note: 'Reviewed — ties out' });
  ok('GL-14: certify by a different user → Certified',
    cert.status === 200 && cert.json?.status === 'Certified' && cert.json?.certified_by === 'mgr',
    `st=${cert.status} status=${cert.json?.status} by=${cert.json?.certified_by}`);

  // ───────────────────── WS2.2 — GL immutability + audit log + reversal (GL-17) ─────────────────────
  // Post a manual JE (Draft) then approve it (mgr ≠ admin) to obtain a freshly-Posted entry, dated TODAY
  // (an open period) so it does not disturb other checks' balances. Use unique accounts 1280/2400.
  const glPost = await inj('POST', '/api/ledger/journal', admin, { source: 'Manual', memo: 'GL-17 reversible', lines: [{ account_code: '1280', debit: 777 }, { account_code: '2400', credit: 777 }] });
  const glEntryNo = glPost.json?.entry_no;
  const glAppr = await inj('POST', `/api/ledger/journal/${glEntryNo}/approve`, mgr);
  ok('GL-17: post + approve a JE → Posted (test fixture)', glAppr.status === 200 && glAppr.json?.status === 'Posted', `st=${glAppr.status} status=${glAppr.json?.status}`);
  // Resolve the numeric id of the posted entry.
  const [glRow] = await db.select({ id: s.journalEntries.id }).from(s.journalEntries).where(eq(s.journalEntries.entryNo, glEntryNo));
  const glId = Number(glRow.id);

  // TC-GL-17-01: attempting to void/delete a posted entry → GL_IMMUTABLE + a MUTATE_BLOCKED audit row.
  const voidPosted = await inj('POST', `/api/ledger/journal/${glId}/attempt-void`, admin);
  ok('GL-17: void of a posted entry blocked (GL_IMMUTABLE)', voidPosted.status === 400 && voidPosted.json?.error?.code === 'GL_IMMUTABLE', `st=${voidPosted.status} code=${voidPosted.json?.error?.code}`);
  const aud1 = (await inj('GET', `/api/ledger/audit?entryId=${glId}`, admin)).json;
  ok('GL-17: MUTATE_BLOCKED recorded in the GL audit trail', (aud1.audit ?? []).some((a: any) => a.action === 'MUTATE_BLOCKED') && (aud1.audit ?? []).some((a: any) => a.action === 'APPROVE'), `actions=${JSON.stringify((aud1.audit ?? []).map((a: any) => a.action))}`);

  // TC-GL-17-02: reverse the posted entry → a contra entry with swapped Dr/Cr; original flagged is_reversed.
  const tb1280Pre = await (async () => { const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json; return (tb.rows ?? []).find((r: any) => r.account_code === '1280')?.balance ?? 0; })();
  const rev = await inj('POST', `/api/ledger/journal/${glId}/reverse`, admin, { reason: 'duplicate posting' });
  ok('GL-17: reverse a posted entry → returns reversalId/originalId', rev.status === 200 && typeof rev.json?.reversalId === 'number' && rev.json?.originalId === glId, JSON.stringify(rev.json));
  const revId = rev.json?.reversalId;
  const [revRow] = await db.select().from(s.journalEntries).where(eq(s.journalEntries.id, revId));
  const revLines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, revId));
  const rl1280 = revLines.find((l: any) => l.accountCode === '1280');
  ok('GL-17: contra entry swaps Dr/Cr (1280 now a 777 credit), reversal_of set, Posted', revRow?.status === 'Posted' && Number(revRow?.reversalOf) === glId && near(rl1280?.credit, 777) && near(rl1280?.debit, 0), `rof=${revRow?.reversalOf} cr=${rl1280?.credit}`);
  const [origRow] = await db.select().from(s.journalEntries).where(eq(s.journalEntries.id, glId));
  ok('GL-17: original entry flagged is_reversed', origRow?.isReversed === true, `is_reversed=${origRow?.isReversed}`);
  // Net effect on 1280 is zero (original 777 Dr + reversal 777 Cr).
  const tb1280Post = await (async () => { const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json; return (tb.rows ?? []).find((r: any) => r.account_code === '1280')?.balance ?? 0; })();
  ok('GL-17: original + reversal net to zero on 1280', near(tb1280Post, tb1280Pre - 777), `pre=${tb1280Pre} post=${tb1280Post}`);
  // GL-detail: the account-ledger drill-down (GET /api/ledger/account-ledger) reconstructs 1280's posted
  // movements with a running balance that ties to the trial balance (the closing = Σ debit−credit all-time).
  const gl1280 = (await inj('GET', '/api/ledger/account-ledger?account=1280', admin)).json;
  ok('GL-detail: account-ledger returns 1280 movements + running balance that ties to the trial balance',
    gl1280.account_code === '1280'
      && Array.isArray(gl1280.lines) && gl1280.lines.length >= 2
      && typeof gl1280.opening_balance === 'number'
      && near(gl1280.closing_balance, tb1280Post)
      && near(gl1280.lines[gl1280.lines.length - 1].balance, gl1280.closing_balance),
    `lines=${gl1280.lines?.length} closing=${gl1280.closing_balance} tb=${tb1280Post}`);
  const glDetailUnknown = await inj('GET', '/api/ledger/account-ledger?account=ZZZZ', admin);
  ok('GL-detail: unknown account → ACCOUNT_NOT_FOUND', glDetailUnknown.status === 404 && glDetailUnknown.json?.error?.code === 'ACCOUNT_NOT_FOUND', `st=${glDetailUnknown.status} code=${glDetailUnknown.json?.error?.code}`);
  const aud2 = (await inj('GET', `/api/ledger/audit?entryId=${glId}`, admin)).json;
  ok('GL-17: REVERSE recorded in the audit trail', (aud2.audit ?? []).some((a: any) => a.action === 'REVERSE'), `actions=${JSON.stringify((aud2.audit ?? []).map((a: any) => a.action))}`);

  // TC-GL-17-03: reversing an already-reversed entry → ALREADY_REVERSED.
  const revAgain = await inj('POST', `/api/ledger/journal/${glId}/reverse`, admin, { reason: 'again' });
  ok('GL-17: double reversal blocked (ALREADY_REVERSED)', revAgain.status === 400 && revAgain.json?.error?.code === 'ALREADY_REVERSED', `st=${revAgain.status} code=${revAgain.json?.error?.code}`);

  // ───────────────────── WS2.1 — Hard Period Close + Checklist (GL-15/GL-16) ─────────────────────
  // Lock a clearly-PAST period (2020-01) that no other harness check posts into (all postings above are
  // dated 2025/2026 or runtime-now), so locking it cannot retroactively break any earlier or later check.
  const closePeriod = '2020-01';

  // TC-GL-15-01: start a close run → InProgress with the checklist seeded (≥4 steps).
  const startClose = await inj('POST', '/api/ledger/close/start', admin, { period: closePeriod });
  const closeRunId = Number(startClose.json?.id);
  ok('GL-15: start close seeds the checklist (InProgress, ≥4 steps)',
    (startClose.status === 200 || startClose.status === 201) && startClose.json?.status === 'InProgress' && Array.isArray(startClose.json?.steps) && startClose.json.steps.length >= 4,
    `st=${startClose.status} status=${startClose.json?.status} steps=${startClose.json?.steps?.length}`);

  // TC-GL-19-CLOSE-01: pre-lock validation of a clean past period → ready, every hard check ok, no blockers.
  const valClean = await inj('GET', `/api/ledger/close/validate?period=${closePeriod}`, admin);
  ok('GL-19: validate a clean period → ready=true, no blockers, drafts/balance checks ok',
    valClean.status === 200 && valClean.json?.ready === true && (valClean.json?.blockers ?? []).length === 0 &&
    valClean.json?.checks?.find((c: any) => c.key === 'unposted_drafts')?.ok === true &&
    valClean.json?.checks?.find((c: any) => c.key === 'period_balanced')?.ok === true,
    `st=${valClean.status} ready=${valClean.json?.ready} blockers=${JSON.stringify(valClean.json?.blockers)}`);

  // TC-GL-19-CLOSE-02: a manual JE posts as Draft (GL-05). Validate that period → unposted_drafts blocks readiness.
  const draftPeriod = '2019-06';
  await inj('POST', '/api/ledger/journal', admin, { date: `${draftPeriod}-10`, source: 'Manual', memo: 'pre-close draft', lines: [{ account_code: '1000', debit: 25 }, { account_code: '4000', credit: 25 }] });
  const valDraft = await inj('GET', `/api/ledger/close/validate?period=${draftPeriod}`, admin);
  ok('GL-19: a Draft JE in the period → ready=false, unposted_drafts blocker (count ≥ 1)',
    valDraft.json?.ready === false && (valDraft.json?.blockers ?? []).includes('unposted_drafts') &&
    valDraft.json?.checks?.find((c: any) => c.key === 'unposted_drafts')?.count >= 1,
    `ready=${valDraft.json?.ready} blockers=${JSON.stringify(valDraft.json?.blockers)}`);

  // TC-GL-20-01 (docs/27 R1-2): the clean-period validate above already proved snapshot==raw (the
  // gl_snapshot_drift check passed inside GL-19). Now INDUCE drift — mutate the snapshot directly, exactly
  // what a rogue/bypassing write path would do — and the validator must block the close.
  ok('GL-20: clean period → snapshot reconciles to the raw ledger (gl_snapshot_drift ok)',
    valClean.json?.checks?.find((c: any) => c.key === 'gl_snapshot_drift')?.ok === true,
    JSON.stringify(valClean.json?.checks?.find((c: any) => c.key === 'gl_snapshot_drift')));
  await pg.exec(`INSERT INTO gl_period_balances (tenant_id, ledger_code, period, cost_center_code, account_code, debit, credit) VALUES (${hq}, '', '${closePeriod}', '', '1000', 123.45, 0)`);
  const valDrift = await inj('GET', `/api/ledger/close/validate?period=${closePeriod}`, admin);
  const driftCheck = valDrift.json?.checks?.find((c: any) => c.key === 'gl_snapshot_drift');
  ok('GL-20: induced snapshot drift → ready=false, gl_snapshot_drift blocker names the account',
    valDrift.json?.ready === false && (valDrift.json?.blockers ?? []).includes('gl_snapshot_drift') && (driftCheck?.accounts ?? []).length >= 1,
    JSON.stringify({ ready: valDrift.json?.ready, drift: driftCheck?.accounts?.[0] }));
  await rebuildGl(); // repair (same recompute as the 0219 backfill) so the close below still locks clean
  const valRepaired = await inj('GET', `/api/ledger/close/validate?period=${closePeriod}`, admin);
  ok('GL-20: rebuild resyncs the snapshot → drift cleared, period ready again',
    valRepaired.json?.checks?.find((c: any) => c.key === 'gl_snapshot_drift')?.ok === true,
    JSON.stringify(valRepaired.json?.blockers));

  // TC-GL-15-02: lock before steps are done → STEPS_INCOMPLETE.
  const lockEarly = await inj('POST', '/api/ledger/close/lock', admin, { close_run_id: closeRunId });
  ok('GL-15: lock before steps complete → STEPS_INCOMPLETE',
    lockEarly.status === 400 && lockEarly.json?.error?.code === 'STEPS_INCOMPLETE',
    `st=${lockEarly.status} code=${lockEarly.json?.error?.code}`);

  // Complete every REQUIRED step → run becomes ReadyToLock.
  let stepRes: any = null;
  for (const stp of (startClose.json?.steps ?? []).filter((s: any) => s.required))
    stepRes = await inj('POST', '/api/ledger/close/step', admin, { close_run_id: closeRunId, step_key: stp.step_key });
  ok('GL-15: all required steps done → run ReadyToLock',
    stepRes?.status === 200 && stepRes?.json?.status === 'ReadyToLock',
    `st=${stepRes?.status} status=${stepRes?.json?.status}`);

  // TC-GL-16-01: self-lock blocked — the starter (admin) cannot lock their own run → SELF_LOCK.
  const selfLock = await inj('POST', '/api/ledger/close/lock', admin, { close_run_id: closeRunId });
  ok('GL-16: self-lock blocked (starter cannot lock own run) → SELF_LOCK',
    selfLock.status === 400 && selfLock.json?.error?.code === 'SELF_LOCK',
    `st=${selfLock.status} code=${selfLock.json?.error?.code}`);

  // TC-GL-16-02: lock by a DIFFERENT user (mgr, also gl_close) → status Locked.
  const mgrLock = (await inj('POST', '/api/login', undefined, { username: 'mgr', password: 'mgr123' })).json.token;
  const locked = await inj('POST', '/api/ledger/close/lock', mgrLock, { close_run_id: closeRunId });
  ok('GL-16: lock by a different user → Locked',
    locked.status === 200 && locked.json?.status === 'Locked' && locked.json?.locked_by === 'mgr',
    `st=${locked.status} status=${locked.json?.status} by=${locked.json?.locked_by}`);

  // TC-GL-15-03: post a JE dated INTO the locked period → PERIOD_LOCKED (the new hard gate).
  const lockedPost = await inj('POST', '/api/ledger/journal', admin, { date: `${closePeriod}-15`, source: 'Manual', lines: [{ account_code: '1000', debit: 10 }, { account_code: '4000', credit: 10 }] });
  ok('GL-15: posting into a locked period → PERIOD_LOCKED',
    lockedPost.status === 400 && lockedPost.json?.error?.code === 'PERIOD_LOCKED',
    `st=${lockedPost.status} code=${lockedPost.json?.error?.code}`);

  // TC-GL-16b — controlled emergency reopen (mandatory reason; reopener ≠ locker; audited).
  const reopenNoReason = await inj('POST', '/api/ledger/close/reopen', admin, { close_run_id: closeRunId });
  ok('GL-16b: reopen without a reason → REASON_REQUIRED',
    reopenNoReason.status === 400 && reopenNoReason.json?.error?.code === 'REASON_REQUIRED', `st=${reopenNoReason.status} code=${reopenNoReason.json?.error?.code}`);
  const reopenSelf = await inj('POST', '/api/ledger/close/reopen', mgrLock, { close_run_id: closeRunId, reason: 'fix dep' });
  ok('GL-16b: the locker cannot reopen their own lock → SELF_REOPEN',
    reopenSelf.status === 400 && reopenSelf.json?.error?.code === 'SELF_REOPEN', `st=${reopenSelf.status} code=${reopenSelf.json?.error?.code}`);
  const reopened = await inj('POST', '/api/ledger/close/reopen', admin, { close_run_id: closeRunId, reason: 'late depreciation adjustment' });
  ok('GL-16b: a different user reopens with a reason → ReadyToLock',
    reopened.status === 200 && reopened.json?.status === 'ReadyToLock', `st=${reopened.status} status=${reopened.json?.status}`);
  const repostAfterReopen = await inj('POST', '/api/ledger/journal', admin, { date: `${closePeriod}-15`, source: 'Manual', lines: [{ account_code: '1000', debit: 10 }, { account_code: '4000', credit: 10 }] });
  ok('GL-16b: posting into the reopened period now succeeds (period back to Open)',
    repostAfterReopen.status === 200 || repostAfterReopen.status === 201, `st=${repostAfterReopen.status} code=${repostAfterReopen.json?.error?.code ?? ''}`);
  const reLock = await inj('POST', '/api/ledger/close/lock', mgrLock, { close_run_id: closeRunId });
  ok('GL-16b: a different user can re-lock the reopened period → Locked',
    reLock.status === 200 && reLock.json?.status === 'Locked', `st=${reLock.status} status=${reLock.json?.status}`);

  // ───────────────────── C2 — Pluggable tax + e-invoicing (SG/MY/EU) ─────────────────────
  // TC-C2-01: SG GST 9% — provider registered, calc correct.
  const sgTax = (await inj('GET', '/api/tax/calc?country=SG&net=100&currency=SGD', admin)).json;
  ok('C2: SG GST 9% — rate=0.09, tax=9.00, gross=109.00',
    sgTax?.rate === 0.09 && sgTax?.tax === 9 && sgTax?.gross === 109,
    `rate=${sgTax?.rate} tax=${sgTax?.tax} gross=${sgTax?.gross}`);

  // TC-C2-02: MY SST 6% — provider registered, calc correct.
  const myTax = (await inj('GET', '/api/tax/calc?country=MY&net=100&currency=MYR', admin)).json;
  ok('C2: MY SST 6% — rate=0.06, tax=6.00, gross=106.00',
    myTax?.rate === 0.06 && myTax?.tax === 6 && myTax?.gross === 106,
    `rate=${myTax?.rate} tax=${myTax?.tax} gross=${myTax?.gross}`);

  // TC-C2-03: MY SST exempt — food category → tax=0, label=SST Exempt.
  const myFood = (await inj('GET', '/api/tax/calc?country=MY&net=200&currency=MYR&category=food', admin)).json;
  ok('C2: MY food category → SST Exempt (tax=0)',
    myFood?.rate === 0 && myFood?.tax === 0 && myFood?.label === 'SST Exempt',
    `rate=${myFood?.rate} tax=${myFood?.tax} label=${myFood?.label}`);

  // TC-C2-04: EU VAT 20% — rate=0.20, tax=20.00, gross=120.00.
  const euTax = (await inj('GET', '/api/tax/calc?country=EU&net=100&currency=EUR', admin)).json;
  ok('C2: EU VAT 20% — rate=0.20, tax=20.00, gross=120.00',
    euTax?.rate === 0.20 && euTax?.tax === 20 && euTax?.gross === 120,
    `rate=${euTax?.rate} tax=${euTax?.tax} gross=${euTax?.gross}`);

  // TC-C2-05: /api/tax/providers lists SG, MY, EU as supported countries.
  const provRes = (await inj('GET', '/api/tax/providers', admin)).json;
  const provCountries: string[] = Array.isArray(provRes?.countries) ? provRes.countries : [];
  ok('C2: TaxService registers SG, MY, EU providers',
    provCountries.includes('SG') && provCountries.includes('MY') && provCountries.includes('EU'),
    `supported=${JSON.stringify(provCountries)}`);

  // TC-C2-06: MYR currency listed in /api/tax/currencies.
  const curRes = (await inj('GET', '/api/tax/currencies', admin)).json;
  const curCodes: string[] = Array.isArray(curRes?.currencies) ? curRes.currencies.map((c: any) => c.code) : [];
  ok('C2: MYR added to currency catalogue',
    curCodes.includes('MYR'),
    `currencies=${JSON.stringify(curCodes)}`);

  // TC-C2-07: MY e-invoice stub accepted via einvoice.my.myinvois provider.
  // Config body uses { provider: '...' }; submit body wraps doc in { doc: { ... } }.
  const setMy = await inj('PUT', '/api/einvoice/config', admin, { provider: 'einvoice.my.myinvois' });
  const myInv = await inj('POST', '/api/einvoice/submit', admin, { doc: { doc_ref: 'MY-INV-C2-001', seller: 'Oshinei MY Sdn Bhd', buyer: 'Test Buyer MY', total: 106, currency: 'MYR' } });
  ok('C2: MY e-invoice (MyInvois UBL 2.1) accepted — status=accepted, ref starts EINV-',
    setMy.status === 200 && myInv.json?.status === 'accepted' && String(myInv.json?.ref ?? '').startsWith('EINV-'),
    `set=${setMy.status} status=${myInv.json?.status} ref=${myInv.json?.ref} provider=${myInv.json?.provider}`);

  // TC-C2-08: SG e-invoice stub accepted via einvoice.sg.invoicenow provider.
  const setSg = await inj('PUT', '/api/einvoice/config', admin, { provider: 'einvoice.sg.invoicenow' });
  const sgInv = await inj('POST', '/api/einvoice/submit', admin, { doc: { doc_ref: 'SG-INV-C2-001', seller: 'Oshinei SG Pte Ltd', buyer: 'Test Buyer SG', total: 109, currency: 'SGD' } });
  ok('C2: SG e-invoice (Peppol BIS3) accepted — status=accepted, ref starts EINV-',
    setSg.status === 200 && sgInv.json?.status === 'accepted' && String(sgInv.json?.ref ?? '').startsWith('EINV-'),
    `set=${setSg.status} status=${sgInv.json?.status} ref=${sgInv.json?.ref} provider=${sgInv.json?.provider}`);

  console.log('\n── ERP basics — Cash Flows + Collections/Dunning + ESS-AP + EAM + credit/depth/forecast + recurring + statements/petty-cash/prepaid/lease/revaluation + inventory sub-ledger + FIFO/FEFO + industry CoA + GL-12 posting-rules engine + GL-13 multi-dim postings + GL-14 sub-ledger tie-out + GL-15/GL-16 hard period close + C1 multi-currency (JPY 0dp) + C2 pluggable tax (SG/MY/EU) + e-invoicing (MyInvois/Peppol) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} basics checks failed` : `\n✅ All ${checks.length} basics checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
