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
// Master-data audit Phase 11: item match-merge is gated to the platform owner (god) because `items` is a
// shared cross-tenant master. Designate a dedicated god username so only it can merge (a per-tenant Admin
// like `invmgr` stays non-god and must be rejected ITEM_MERGE_HQ_ONLY).
process.env.PLATFORM_ADMIN_USERNAMES = process.env.PLATFORM_ADMIN_USERNAMES || 'itemgod';

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
    { code: 'FATAX', name: 'FA Tax Book Co' },  // FIN-6a — parallel tax-book + deferred-tax isolation tenant
  ]).onConflictDoNothing();
  const tid = async (code: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, code)))[0].id);
  const hq = await tid('HQ');
  const cust = await tid('CUST');
  const cust2 = await tid('CUST2');
  const cust3 = await tid('CUST3');
  const fatax = await tid('FATAX');
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'emp1', passwordHash: await pw.hash('emp123'), role: 'Admin', tenantId: hq }, // claimant (ESS)
    { username: 'mgr', passwordHash: await pw.hash('mgr123'), role: 'Admin', tenantId: hq },   // approver (≠ claimant)
    { username: 'faadmin', passwordHash: await pw.hash('fa123'), role: 'Admin', tenantId: fatax }, // FIN-6a maker (FATAX)
    { username: 'famgr', passwordHash: await pw.hash('fa123'), role: 'Admin', tenantId: fatax },   // FIN-6a checker (FATAX, ≠ maker)
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
  // REV-08 (audit G7): a credit-limit change is maker-checker — staged PendingApproval; the requester
  // cannot self-approve; a distinct user (approvals/exec) applies it. The ceiling moves only on approval.
  const climReq = await inj('POST', '/api/finance/ar/credit-limit', admin, { tenant_id: cust3, new_limit: 50000, reason: 'Annual review' });
  ok('G7: credit-limit change staged PendingApproval (not applied yet)', climReq.json?.pending === true && !!climReq.json?.req_no && climReq.json?.new_limit === 50000, JSON.stringify({ p: climReq.json?.pending, r: climReq.json?.req_no }));
  const climSelf = await inj('POST', `/api/finance/ar/credit-limit/${climReq.json?.req_no}/approve`, admin);
  ok('G7: requester cannot approve own credit-limit change → 403 SOD_VIOLATION', climSelf.status === 403 && climSelf.json?.error?.code === 'SOD_VIOLATION', `${climSelf.status} ${climSelf.json?.error?.code}`);
  const climAppr = await inj('POST', `/api/finance/ar/credit-limit/${climReq.json?.req_no}/approve`, mgr2);
  ok('G7: a distinct approver applies the credit-limit change (→ 50000)', climAppr.status === 200 || climAppr.status === 201 ? climAppr.json?.status === 'Approved' && climAppr.json?.new_limit === 50000 && climAppr.json?.approved_by === 'mgr' : false, JSON.stringify({ st: climAppr.status, nl: climAppr.json?.new_limit }));
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

  // ── B2 auto-reversing accruals (docs/50 Wave 1; GL-08 + GL-17 semantics) ──
  // auto_reverse is accrual-only (monthly): the sweep's first run in the NEXT business month posts a
  // flipped Draft reversal of the prior month's entry (maker-checker GL-05, idempotent per source_ref).
  const arBad = await inj('POST', '/api/ledger/recurring', admin, { name: 'bad-autorev', frequency: 'daily', auto_reverse: true, lines: [{ account_code: '5720', debit: 700 }, { account_code: '2100', credit: 700 }] });
  ok('AutoRev: non-monthly template rejected (AUTO_REVERSE_MONTHLY_ONLY)', arBad.status === 400 && arBad.json?.error?.code === 'AUTO_REVERSE_MONTHLY_ONLY', `st=${arBad.status} code=${arBad.json?.error?.code}`);
  const tbBalanceOf = async (code: string) => {
    const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
    const row = (tb.rows ?? []).find((r: any) => r.account_code === code);
    return row ? Number(row.balance) : 0;
  };
  const beforeAr5720 = await tbDebit('5720');
  const beforeArBal5720 = await tbBalanceOf('5720');
  const arTpl = await inj('POST', '/api/ledger/recurring', admin, { name: 'Accrued utilities', frequency: 'monthly', auto_reverse: true, lines: [{ account_code: '5720', debit: 700 }, { account_code: '2100', credit: 700 }] });
  ok('AutoRev: monthly accrual template created (auto_reverse=true)', arTpl.status === 201 && arTpl.json?.auto_reverse === true, JSON.stringify(arTpl.json).slice(0, 90));
  const runA = await inj('POST', '/api/ledger/recurring/run', admin);
  const arEntryNo = (runA.json?.entries ?? []).find((e: any) => e.recurring_id === arTpl.json.id)?.entry_no;
  ok('AutoRev: accrual posts on the sweep, no same-month reversal', /^JE-/.test(arEntryNo ?? '') && (runA.json?.reversals ?? []).length === 0, `no=${arEntryNo} rev=${(runA.json?.reversals ?? []).length}`);
  await inj('POST', `/api/ledger/journal/${arEntryNo}/approve`, mgr);
  ok('AutoRev: approved accrual hits the GL (+700)', near(await tbDebit('5720'), beforeAr5720 + 700), `after=${await tbDebit('5720')}`);
  // simulate the month rollover: stamp the template's last run into the PRIOR business month
  const asOf = String(runA.json?.as_of ?? '');
  const priorMonthDate = (() => { const d = new Date(`${asOf}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); })();
  await pg.query(`UPDATE recurring_journals SET last_run_date='${priorMonthDate}' WHERE id=${Number(arTpl.json.id)}`);
  const runB = await inj('POST', '/api/ledger/recurring/run', admin);
  const arRev = (runB.json?.reversals ?? [])[0];
  ok('AutoRev: first sweep of the new month posts the reversal (Draft)', (runB.json?.reversals ?? []).length === 1 && /^JE-/.test(arRev?.entry_no ?? '') && arRev?.reversed_run === priorMonthDate, JSON.stringify(runB.json?.reversals));
  const pendAr = (await inj('GET', '/api/ledger/journal/pending', admin)).json;
  ok('AutoRev: reversal is Draft awaiting maker-checker (GL-05) — GL unchanged', (pendAr.entries ?? []).some((e: any) => e.entry_no === arRev?.entry_no) && near(await tbDebit('5720'), beforeAr5720 + 700), `pending has=${(pendAr.entries ?? []).some((e: any) => e.entry_no === arRev?.entry_no)}`);
  const revAppr = await inj('POST', `/api/ledger/journal/${arRev?.entry_no}/approve`, mgr);
  ok('AutoRev: approved reversal nets the accrual back out (flipped lines; gross debit kept)', revAppr.status === 200 && near(await tbDebit('5720'), beforeAr5720 + 700) && near(await tbBalanceOf('5720'), beforeArBal5720), `st=${revAppr.status} bal=${await tbBalanceOf('5720')}`);
  const runC = await inj('POST', '/api/ledger/recurring/run', admin);
  ok('AutoRev: re-run posts no second reversal (idempotent source_ref)', (runC.json?.reversals ?? []).length === 0 && runC.json?.posted === 0, `rev=${(runC.json?.reversals ?? []).length} posted=${runC.json?.posted}`);

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

  // ───────────────────── GL allocation cycles (GL-23, FIN-7b) ─────────────────────
  // A source pool distributed to targets by ratio / driver / statistical key, posted as a balanced DRAFT JE
  // on the recurring rail (maker-checker, GL-05), idempotent per period.
  // Up-front validation: a cycle with a zero total basis can never be saved (nothing to divide by).
  const badAlloc = await inj('POST', '/api/ledger/allocation', admin, { name: 'bad', method: 'ratio', frequency: 'daily', pool_amount: 1000, source_account: '5000', targets: [{ target_account: '5710', basis: 0 }] });
  ok('Allocation: zero-basis cycle rejected (NO_BASIS)', badAlloc.status === 400 && badAlloc.json?.error?.code === 'NO_BASIS', `st=${badAlloc.status} code=${badAlloc.json?.error?.code}`);
  // Ratio method: pool 10,000 split 3:1 across 5710 / 5720 → 7,500 / 2,500; source 5000 credited 10,000.
  const bAl5710 = await tbBalance('5710'), bAl5720 = await tbBalance('5720'), bAl5000 = await tbBalance('5000');
  const mkAlloc = await inj('POST', '/api/ledger/allocation', admin, { name: 'Overhead split', method: 'ratio', frequency: 'daily', pool_amount: 10000, source_account: '5000', memo: 'OH', targets: [{ target_account: '5710', basis: 3 }, { target_account: '5720', basis: 1 }] });
  ok('Allocation: create a ratio cycle (2 targets)', mkAlloc.status === 201 && typeof mkAlloc.json?.id === 'number' && mkAlloc.json?.targets === 2 && !!mkAlloc.json?.cycle_no, JSON.stringify(mkAlloc.json));
  const runAl = await inj('POST', '/api/ledger/allocation/run', admin);
  const alEntryNo = runAl.json?.entries?.[0]?.entry_no;
  ok('Allocation: scheduled run posts the due cycle (1 balanced JE)', runAl.status === 200 && runAl.json?.posted === 1 && /^JE-/.test(alEntryNo ?? ''), `posted=${runAl.json?.posted} no=${alEntryNo}`);
  // GL-05: posts as DRAFT — excluded from balances until a different user approves.
  ok('Allocation: posted JE is DRAFT — excluded from trial balance', near(await tbBalance('5710'), bAl5710) && near(await tbBalance('5000'), bAl5000), `d5710=${(await tbBalance('5710')) - bAl5710}`);
  const pendAl = (await inj('GET', '/api/ledger/journal/pending', admin)).json;
  ok('Allocation: draft JE awaits maker-checker approval', (pendAl.entries ?? []).some((e: any) => e.entry_no === alEntryNo), `pending=${(pendAl.entries ?? []).length}`);
  // Idempotent: a same-day re-run advances nothing (next_run rolled forward + ux_je_idem dedupe).
  const runAl2 = await inj('POST', '/api/ledger/allocation/run', admin);
  ok('Allocation: same-day re-run is idempotent (0)', runAl2.status === 200 && runAl2.json?.posted === 0, `posted=${runAl2.json?.posted}`);
  // A DIFFERENT user approves → the split lands in balances: 5710 +7,500, 5720 +2,500, 5000 −10,000 (balanced).
  const alAppr = await inj('POST', `/api/ledger/journal/${alEntryNo}/approve`, mgr);
  ok('Allocation: ratio split posts balanced (5710 +7500 / 5720 +2500 / 5000 −10000)',
    alAppr.status === 200 && near((await tbBalance('5710')) - bAl5710, 7500) && near((await tbBalance('5720')) - bAl5720, 2500) && near((await tbBalance('5000')) - bAl5000, -10000),
    `st=${alAppr.status} d5710=${(await tbBalance('5710')) - bAl5710} d5720=${(await tbBalance('5720')) - bAl5720} d5000=${(await tbBalance('5000')) - bAl5000}`);
  // Driver method: pool 900 split by headcount 2:1 across 5710 / 5720 → 600 / 300.
  const bDv5710 = await tbBalance('5710'), bDv5720 = await tbBalance('5720');
  const mkDrv = await inj('POST', '/api/ledger/allocation', admin, { name: 'IT by headcount', method: 'driver', frequency: 'monthly', pool_amount: 900, source_account: '5000', targets: [{ target_account: '5710', basis: 2, memo: 'HR 2 ppl' }, { target_account: '5720', basis: 1, memo: 'Ops 1 ppl' }] });
  ok('Allocation: create a driver cycle (headcount key)', mkDrv.status === 201 && mkDrv.json?.method === 'driver', JSON.stringify(mkDrv.json));
  const runDrv = await inj('POST', '/api/ledger/allocation/run', admin);
  const drvEntryNo = runDrv.json?.entries?.find((e: any) => e.cycle_id === mkDrv.json?.id)?.entry_no;
  await inj('POST', `/api/ledger/journal/${drvEntryNo}/approve`, mgr);
  ok('Allocation: driver split posts by headcount (5710 +600 / 5720 +300)',
    !!drvEntryNo && near((await tbBalance('5710')) - bDv5710, 600) && near((await tbBalance('5720')) - bDv5720, 300),
    `d5710=${(await tbBalance('5710')) - bDv5710} d5720=${(await tbBalance('5720')) - bDv5720}`);

  // ───────────────────── Customer / vendor statements of account ─────────────────────
  const [stmtT] = await db.insert(s.tenants).values({ code: 'STMT', name: 'Statement Customer', email: 'stmt@cust.example' }).returning({ id: s.tenants.id });
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
  // to_email OPTIONAL — omitting it defaults the recipient to the party's email on file (master data). The
  // STMT tenant has an email, so the send resolves a recipient and reaches the (unconfigured) transport → 503
  // rather than 400 NO_RECIPIENT (which is what a party with no email on file would return).
  const stmtEmailDefault = await inj('POST', `/api/finance/ar/statement/send-email?tenant_id=${stmtTid}&from=2026-01-01&to=2026-02-28`, admin, {});
  ok('Statement email defaults recipient to the customer email on file when to_email omitted (→ 503, not NO_RECIPIENT)', stmtEmailDefault.status === 503 && stmtEmailDefault.json.error?.code === 'EMAIL_NOT_CONFIGURED', `${stmtEmailDefault.status} ${stmtEmailDefault.json.error?.code}`);
  const rcpPdf = await inj('GET', '/api/finance/ar/receipts/RCP-S1/pdf', admin);
  ok('AR receipt print: PDF/HTML contains "ใบสำคัญรับเงิน" + amount (400.00)', rcpPdf.status === 200 && rcpPdf.text.includes('ใบสำคัญรับเงิน') && rcpPdf.text.includes('400.00'), `${rcpPdf.status} ${String(rcpPdf.text).slice(0, 50)}`);
  const rcpList = await inj('GET', '/api/finance/ar/receipts', admin);
  ok('AR receipts list surface returns RCP-S1 (for print/email)', rcpList.status === 200 && (rcpList.json.receipts ?? []).some((r: any) => r.receipt_no === 'RCP-S1'), `${rcpList.status} n=${rcpList.json.count}`);
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
  // EXP-08 (audit G3): fund establishment raises a maker-checker FUNDING request — no cash until approved.
  const fund = await inj('POST', '/api/finance/petty-cash/funds', admin, { fund_code: 'PCF-1', name: 'HQ petty cash', float_limit: 5000, initial_amount: 5000 });
  ok('EXP-08/G3: establish fund → initial funding PendingApproval, no GL yet (balance 0, 1015 unchanged)', fund.status === 201 && fund.json?.pending === true && fund.json?.balance === 0 && !!fund.json?.funding_req_no && near(await tbBalance('1015'), pc1015Before), `pending=${fund.json?.pending} bal=${fund.json?.balance} 1015=${await tbBalance('1015')}`);
  const fundSelf = await inj('POST', `/api/finance/petty-cash/requests/${fund.json?.funding_req_no}/approve`, admin);
  ok('EXP-08/G3: fund establishment self-approval blocked → 403 SOD_VIOLATION', fundSelf.status === 403 && fundSelf.json?.error?.code === 'SOD_VIOLATION', `${fundSelf.status} ${fundSelf.json?.error?.code}`);
  const fundAppr = await inj('POST', `/api/finance/petty-cash/requests/${fund.json?.funding_req_no}/approve`, mgr);
  ok('EXP-08/G3: a different user approves the funding → Dr 1015 / Cr 1000 (5000); balance 5000', fundAppr.status === 200 && fundAppr.json?.fund_balance === 5000 && near(await tbBalance('1015'), pc1015Before + 5000), `fb=${fundAppr.json?.fund_balance} 1015=${await tbBalance('1015')}`);
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
  // EXP-08 (audit G3): replenishment is also maker-checker — raises a funding request; cash posts on approval.
  const rplOk = await inj('POST', '/api/finance/petty-cash/funds/PCF-1/replenish', admin, { amount: 2000 });
  ok('EXP-08/G3: replenish raises a PendingApproval funding request (no GL yet)', rplOk.status === 200 && rplOk.json?.pending === true && !!rplOk.json?.funding_req_no && near(await tbBalance('1015'), pc1015Before + 2300), `pending=${rplOk.json?.pending} 1015=${await tbBalance('1015')}`);
  const rplAppr = await inj('POST', `/api/finance/petty-cash/requests/${rplOk.json?.funding_req_no}/approve`, mgr);
  ok('EXP-08/G3: a different user approves replenish → tops the fund back up (2300 → 4300)', rplAppr.status === 200 && rplAppr.json?.fund_balance === 4300 && near(await tbBalance('1015'), pc1015Before + 4300), `fb=${rplAppr.json?.fund_balance}`);
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

  // ───────────────── Lessor-side lease accounting (IFRS 16 / TFRS 16 lessor) — LSE-02 (FIN-10) ─────────────────
  // Classification boundary: the major-part-of-economic-life test flips finance↔operating exactly at 75%.
  const clsOper = await inj('POST', '/api/lessor-leases/classify', admin, { name: 'boundary op', term_months: 71, monthly_payment: 100, asset_cost: 10000, fair_value: 10000, economic_life_months: 100 });
  ok('Lessor: classification boundary — term 71/100 (71%) + PV 71% of FV → OPERATING', clsOper.status === 200 && clsOper.json?.classification === 'operating' && clsOper.json?.reasons?.length === 0, JSON.stringify(clsOper.json));
  const clsFin = await inj('POST', '/api/lessor-leases/classify', admin, { name: 'boundary fin', term_months: 75, monthly_payment: 100, asset_cost: 10000, fair_value: 10000, economic_life_months: 100 });
  ok('Lessor: classification boundary — term 75/100 (75%) → FINANCE (major part of economic life)', clsFin.status === 200 && clsFin.json?.classification === 'finance' && clsFin.json?.reasons?.includes('major_part_of_economic_life'), JSON.stringify(clsFin.json));

  // FINANCE lease: derecognise the asset + book the net investment (lease receivable) at PV, interest income over the term.
  const lsr1610Before = await tbDebit('1610'), lsr1500Before = await tbCredit2('1500'), lsr4620Before = await tbCredit2('4620');
  const mkFin = await inj('POST', '/api/lessor-leases', admin, { name: 'Excavator finance lease', lessee: 'BuildCo', term_months: 12, monthly_payment: 1000, annual_rate_pct: 12, asset_cost: 11000, fair_value: 12000, transfer_ownership: true });
  ok('Lessor finance: create classifies FINANCE + net investment = PV of payments, PENDING (no GL yet)',
    mkFin.status === 201 && mkFin.json?.classification === 'finance' && mkFin.json?.net_investment > 11200 && mkFin.json?.net_investment < 11300 && mkFin.json?.status === 'pending' && near(await tbDebit('1610'), lsr1610Before),
    `cls=${mkFin.json?.classification} ni=${mkFin.json?.net_investment} 1610Δ=${(await tbDebit('1610')) - lsr1610Before}`);
  const finNo = mkFin.json?.lease_no;
  const finSelf = await inj('POST', `/api/lessor-leases/${finNo}/approve`, admin);
  ok('Lessor: the classifier cannot approve their own lease (SOD_SELF_APPROVAL)', finSelf.status === 403 && finSelf.json?.error?.code === 'SOD_SELF_APPROVAL', `st=${finSelf.status} code=${finSelf.json?.error?.code}`);
  const finAppr = await inj('POST', `/api/lessor-leases/${finNo}/approve`, mgr);
  const ni = mkFin.json?.net_investment;
  ok('Lessor finance: a distinct approver books commencement — Dr 1610 (net investment) / Cr 1500 (asset derecognised)',
    finAppr.status === 200 && finAppr.json?.status === 'active' && near(await tbDebit('1610'), lsr1610Before + ni) && near(await tbCredit2('1500'), lsr1500Before + 11000),
    `st=${finAppr.status} 1610Δ=${(await tbDebit('1610')) - lsr1610Before} 1500Δ=${(await tbCredit2('1500')) - lsr1500Before}`);
  const runFin = await inj('POST', '/api/lessor-leases/run', admin);
  const fe = (runFin.json?.entries ?? []).find((e: any) => e.lease_no === finNo);
  ok('Lessor finance: periodic run recognises interest income + collects cash (interest + principal = payment)',
    runFin.status === 200 && fe && near(fe.interest_income + fe.principal, 1000) && fe.interest_income > 0 && near(await tbCredit2('4620'), lsr4620Before + fe.interest_income),
    `int=${fe?.interest_income} prin=${fe?.principal} 4620Δ=${(await tbCredit2('4620')) - lsr4620Before}`);
  const lsrList = (await inj('GET', '/api/lessor-leases', admin)).json;
  const finRow = (lsrList.leases ?? []).find((x: any) => x.lease_no === finNo);
  ok('Lessor finance: net investment (receivable) reduced by the principal after the period', finRow && finRow.receivable_balance < ni && finRow.receivable_balance > 0, `recv=${finRow?.receivable_balance} ni=${ni}`);

  // OPERATING lease: keep the asset, straight-line rental income + continued depreciation.
  const lsr4610Before = await tbCredit2('4610'), lsr1590Before = await tbCredit2('1590');
  const mkOp = await inj('POST', '/api/lessor-leases', admin, { name: 'Office space operating lease', lessee: 'TenantCo', term_months: 12, monthly_payment: 500, asset_cost: 12000, fair_value: 12000, economic_life_months: 120 });
  ok('Lessor operating: create classifies OPERATING (short term, PV below FV) — asset stays on books', mkOp.status === 201 && mkOp.json?.classification === 'operating' && mkOp.json?.status === 'pending', JSON.stringify(mkOp.json));
  const opNo = mkOp.json?.lease_no;
  const opAppr = await inj('POST', `/api/lessor-leases/${opNo}/approve`, mgr);
  ok('Lessor operating: approval activates with NO commencement GL (net investment 0)', opAppr.status === 200 && opAppr.json?.status === 'active' && near(opAppr.json?.net_investment, 0), `st=${opAppr.status} ni=${opAppr.json?.net_investment}`);
  const runOp = await inj('POST', '/api/lessor-leases/run', admin);
  const oe = (runOp.json?.entries ?? []).find((e: any) => e.lease_no === opNo);
  ok('Lessor operating: periodic run posts straight-line rental income (Cr 4610) + continued depreciation (Dr 5200 / Cr 1590)',
    runOp.status === 200 && oe && near(oe.rental_income, 500) && oe.depreciation > 0 && near(await tbCredit2('4610'), lsr4610Before + 500) && near(await tbCredit2('1590'), lsr1590Before + oe.depreciation),
    `rent=${oe?.rental_income} dep=${oe?.depreciation} 4610Δ=${(await tbCredit2('4610')) - lsr4610Before}`);
  // LSE-02 net-investment reconciliation: GL 1610 net debit == Σ remaining receivable on the FINANCE-lease schedule.
  const lsrRecon = (await inj('GET', '/api/lessor-leases/receivable-reconciliation', admin)).json;
  ok('Lessor: net-investment reconciliation ties GL 1610 to the finance-lease receivable schedule (reconciled, difference 0)',
    lsrRecon.reconciled === true && near(lsrRecon.difference, 0) && near(lsrRecon.gl_receivable, lsrRecon.schedule_receivable) && lsrRecon.schedule_receivable > 0,
    JSON.stringify({ gl: lsrRecon.gl_receivable, sched: lsrRecon.schedule_receivable, diff: lsrRecon.difference, rec: lsrRecon.reconciled }));

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
  // Barcode scan-to-add: an item carrying a real barcode resolves by EXACT match (?barcode=), an unknown code matches nothing.
  await db.insert(s.items).values({ itemId: 'SCANITEM', itemDescription: 'Scannable item', barcode: '8850999320016' }).onConflictDoNothing();
  const shopScan = await inj('GET', '/api/procurement/catalog?barcode=8850999320016&limit=1', admin);
  ok('Shop catalog: exact barcode match resolves the one item (scan-to-add)', shopScan.status === 200 && shopScan.json?.total === 1 && shopScan.json?.items?.[0]?.item_id === 'SCANITEM', `${shopScan.status} total=${shopScan.json?.total} first=${shopScan.json?.items?.[0]?.item_id}`);
  const shopScanMiss = await inj('GET', '/api/procurement/catalog?barcode=0000000000000&limit=1', admin);
  ok('Shop catalog: unknown barcode matches nothing (total 0 → client falls back to a name lookup)', shopScanMiss.status === 200 && shopScanMiss.json?.total === 0, `${shopScanMiss.status} total=${shopScanMiss.json?.total}`);
  // /shop favourites + basket templates sync across devices via user-prefs (round-trip + dedupe + merge-by-key).
  const prefPut = await inj('PUT', '/api/user-prefs', admin, { shop_favs: ['SCANITEM', 'LAPTOP', 'SCANITEM'], shop_templates: [{ name: 'Weekly supplies', lines: [{ item_id: 'SCANITEM', qty: 3, uom: 'กล่อง' }, { item_id: 'LAPTOP', qty: 1 }] }] });
  ok('Shop prefs: PUT dedupes favourites + stores a basket template', prefPut.status < 300 && (prefPut.json?.shop_favs ?? []).length === 2 && prefPut.json?.shop_templates?.[0]?.lines?.length === 2, `favs=${(prefPut.json?.shop_favs ?? []).length} lines=${prefPut.json?.shop_templates?.[0]?.lines?.length}`);
  const prefGet = await inj('GET', '/api/user-prefs', admin);
  ok('Shop prefs: GET returns the synced favourites + template (cross-device)', prefGet.status === 200 && (prefGet.json?.shop_favs ?? []).includes('SCANITEM') && prefGet.json?.shop_templates?.[0]?.name === 'Weekly supplies', `favs=${JSON.stringify(prefGet.json?.shop_favs)} tpl=${prefGet.json?.shop_templates?.[0]?.name}`);
  const prefPatch = await inj('PUT', '/api/user-prefs', admin, { shop_favs: ['LAPTOP'] });
  ok('Shop prefs: patching shop_favs leaves shop_templates untouched (merge by key)', prefPatch.status < 300 && (prefPatch.json?.shop_favs ?? []).length === 1 && prefPatch.json?.shop_templates?.[0]?.name === 'Weekly supplies', `favs=${(prefPatch.json?.shop_favs ?? []).length} tpl=${prefPatch.json?.shop_templates?.[0]?.name}`);
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
  const grList = await inj('GET', '/api/procurement/grs', admin);
  ok('GR list surface returns the created GR (for print/email)', grList.status === 200 && (grList.json.grs ?? []).some((g: any) => g.gr_no === grCap.json?.gr_no), `${grList.status} n=${grList.json.count}`);
  // Capital goods must NOT be capitalised into inventory (1200) at receipt — they route to 1500 via FA-10.
  const elig = (await inj('GET', `/api/assets/registrations/eligible?gr_no=${grCap.json?.gr_no}`, admin)).json;
  ok('Capitalize: GR capital line is eligible for capitalisation (suggested cost = 50000)', (elig.eligible ?? []).length === 1 && near(elig.eligible?.[0]?.suggested_cost, 50000), `n=${elig.eligible?.length} cost=${elig.eligible?.[0]?.suggested_cost}`);
  const grItemId = elig.eligible?.[0]?.gr_item_id;
  const cap1500Before = await tbDebit('1500');
  const cap2000Before = await tbCredit2('2000');
  // Master-data audit Phase 2: location/department/serial_no were already accepted by RegisterFromGrBody end
  // to end (approveRegistration → acquire), but the /assets capitalize form never collected them — now it does.
  const regReq = await inj('POST', '/api/assets/registrations', admin, { gr_no: grCap.json?.gr_no, gr_item_id: grItemId, name: 'Dev laptop (capex)', useful_life_months: 36, location: 'Warehouse A', department: 'Kitchen', serial_no: 'SN-001' });
  ok('Capitalize: registration raised as PendingApproval — NO GL yet (Dr 1500 unchanged)', regReq.status === 201 && regReq.json?.status === 'PendingApproval' && near(regReq.json?.acquire_cost, 50000) && near(await tbDebit('1500'), cap1500Before), `st=${regReq.json?.status} 1500=${await tbDebit('1500')}`);
  const regSelf = await inj('POST', `/api/assets/registrations/${regReq.json?.reg_no}/approve`, admin);
  ok('Capitalize: preparer self-approval blocked → 403 SOD_VIOLATION (FA-10)', regSelf.status === 403 && regSelf.json?.error?.code === 'SOD_VIOLATION', `${regSelf.status} ${regSelf.json?.error?.code}`);
  const regAppr = await inj('POST', `/api/assets/registrations/${regReq.json?.reg_no}/approve`, mgr);
  ok('Capitalize: a different user approves → asset created, GL posts (Dr 1500 / Cr 2000 +50000)', regAppr.status === 201 && /^FA-/.test(regAppr.json?.asset_no ?? '') && /^JE-/.test(regAppr.json?.journal_no ?? '') && near(await tbDebit('1500'), cap1500Before + 50000) && near(await tbCredit2('2000'), cap2000Before + 50000), `asset=${regAppr.json?.asset_no} 1500=${await tbDebit('1500')}`);
  const capReg = (await inj('GET', '/api/assets', admin)).json;
  const newFa = (capReg.assets ?? []).find((x: any) => x.asset_no === regAppr.json?.asset_no);
  ok('Capitalize: new asset is on the register with source GR/PO traceability', !!newFa && newFa.source_gr_no === grCap.json?.gr_no && newFa.source_po_no === poCap.json?.po_no && near(newFa.acquire_cost, 50000), `gr=${newFa?.source_gr_no} po=${newFa?.source_po_no}`);
  ok('Capitalize: location/department/serial_no submitted on the capitalize form carry through to the asset',
    newFa?.location === 'Warehouse A' && newFa?.department === 'Kitchen' && newFa?.serial_no === 'SN-001',
    JSON.stringify({ location: newFa?.location, department: newFa?.department, serial_no: newFa?.serial_no }));
  const regDup = await inj('POST', '/api/assets/registrations', admin, { gr_no: grCap.json?.gr_no, gr_item_id: grItemId, name: 'dup', useful_life_months: 36 });
  ok('Capitalize: the same GR line cannot be capitalised twice (ALREADY_REGISTERED)', regDup.status === 400 && regDup.json?.error?.code === 'ALREADY_REGISTERED', `st=${regDup.status} code=${regDup.json?.error?.code}`);

  // ───────────────── FIN-6a: parallel TAX depreciation book → deferred tax (FATAX tenant) ─────────────────
  // A single asset with a Thai-tax book: cost 120000, book life 60m, TAX life 24m + 40% first-year INITIAL
  // ALLOWANCE. Tax depreciates FAR faster than book, so tax NBV < book NBV → a taxable temp diff → DTL that
  // flows straight into deferred tax (TAX-06) instead of a manual GAAP adjustment. Isolated in FATAX so the
  // book/tax/deferred figures are exact (no other assets or AR allowance).
  const faAdmin = (await inj('POST', '/api/login', undefined, { username: 'faadmin', password: 'fa123' })).json.token;
  const faMgr = (await inj('POST', '/api/login', undefined, { username: 'famgr', password: 'fa123' })).json.token;
  const acqTax = await inj('POST', '/api/assets', faAdmin, { name: 'CNC machine', acquire_date: '2026-01-01', acquire_cost: 120000, useful_life_months: 60, acquire_source: 'credit', tax_useful_life_months: 24, tax_initial_allowance_pct: 40 });
  ok('FIN-6a: acquire seeds the parallel tax book (tax NBV = cost at acquisition)', acqTax.status === 201 && /^FA-/.test(acqTax.json?.asset_no ?? ''), `st=${acqTax.status} asset=${acqTax.json?.asset_no}`);
  const faTaxAssetNo = acqTax.json?.asset_no;
  const faReg = (await inj('GET', '/api/assets', faAdmin)).json;
  const faAsset = (faReg.assets ?? []).find((a: any) => a.asset_no === faTaxAssetNo);
  ok('FIN-6a: register exposes the tax book (tax_net_book_value 120000, tax_useful_life_months 24)', near(faAsset?.tax_net_book_value, 120000) && faAsset?.tax_useful_life_months === 24 && near(faAsset?.tax_initial_allowance_pct, 40), `tnbv=${faAsset?.tax_net_book_value} tlife=${faAsset?.tax_useful_life_months}`);
  // Book depreciation for 2026-01 (Dr 5200 / Cr 1590): 120000/60 = 2000 → book NBV 118000.
  await inj('POST', '/api/assets/depreciation/run', faAdmin, { period: '2026-01' });
  // Tax depreciation for 2026-01 (NO GL): initial allowance 40% × 120000 = 48000 + 120000/24 = 5000 → 53000; tax NBV 67000.
  const taxRun = await inj('POST', '/api/assets/tax-depreciation/run', faAdmin, { period: '2026-01' });
  const taxLine = (taxRun.json?.assets ?? []).find((x: any) => x.asset_no === faTaxAssetNo);
  ok('FIN-6a: tax-depreciation run applies the initial allowance + accelerated life (53000; tax NBV 67000; NO GL)', taxRun.status === 201 && near(taxLine?.tax_depreciation, 53000) && near(taxLine?.initial_allowance, 48000) && near(taxLine?.tax_nbv_after, 67000), `dep=${taxLine?.tax_depreciation} ia=${taxLine?.initial_allowance} nbv=${taxLine?.tax_nbv_after}`);
  const taxRerun = await inj('POST', '/api/assets/tax-depreciation/run', faAdmin, { period: '2026-01' });
  ok('FIN-6a: tax-depreciation run is idempotent per period (re-run → 0 assets)', taxRerun.status === 201 && taxRerun.json?.asset_count === 0, `count=${taxRerun.json?.asset_count}`);
  // Deferred tax now reads the REAL tax book: book NBV 118000 − tax NBV 67000 = 51000 taxable temp diff → DTL 51000 × 20% = 10200.
  // (Contrast: the pre-FIN-6 factor fallback would have given only ~200 — the actual tax book is what feeds the difference.)
  const faDt = await inj('POST', '/api/ledger/deferred-tax/run', faAdmin, { period: '2026-01', as_of_date: '2026-01-31', tenant_id: fatax });
  ok('FIN-6a: deferred tax consumes the actual tax NBV → DTL 10200, net deferred −10200 (not the factor approximation)', faDt.status === 200 && near(faDt.json?.dtl, 10200) && near(faDt.json?.net_deferred, -10200) && near(faDt.json?.delta_posted, -10200), `dtl=${faDt.json?.dtl} net=${faDt.json?.net_deferred}`);
  const faDtPost = await inj('POST', `/api/ledger/deferred-tax/${faDt.json?.id}/post`, faMgr);
  ok('FIN-6a: a different user posts the deferred-tax charge (Dr 5950 / Cr 1700, Δ −10200)', faDtPost.status === 200 && near(faDtPost.json?.delta_posted, -10200) && /^JE-/.test(faDtPost.json?.entry_no ?? ''), `st=${faDtPost.status} delta=${faDtPost.json?.delta_posted} je=${faDtPost.json?.entry_no}`);

  // ───────────────── FA-13: CIP / AUC — accumulate cost → settle to a fixed asset (maker-checker) ─────────────────
  // A construction-in-progress asset accumulates cost lines into 1520 CIP (NOT depreciated) and is capitalised
  // to a normal fixed asset (Dr 1500 / Cr 1520) only after a DIFFERENT user approves a settlement request.
  const cip1500Before = await tbBalance('1500');
  const cip1520Before = await tbBalance('1520');
  const cip2000CrBefore = await tbCredit2('2000');
  const openCip = await inj('POST', '/api/assets/cip', admin, { name: 'New warehouse build', location: 'Site B', department: 'Ops' });
  ok('CIP: open a construction-in-progress asset (status Open, cost 0)', openCip.status === 201 && /^CIP-/.test(openCip.json?.cip_no ?? '') && openCip.json?.status === 'Open', `st=${openCip.status} no=${openCip.json?.cip_no}`);
  const cipNo = openCip.json?.cip_no;
  const cost1 = await inj('POST', `/api/assets/cip/${cipNo}/cost`, admin, { amount: 30000, source_type: 'gr', source_ref: 'GR-CIP-1', description: 'Foundation', pay_source: 'credit' });
  ok('CIP: add cost line 1 (30000, credit) posts Dr 1520 / Cr 2000; accumulated 30000', cost1.status === 201 && near(cost1.json?.accumulated_cost, 30000) && /^JE-/.test(cost1.json?.journal_no ?? ''), `acc=${cost1.json?.accumulated_cost} je=${cost1.json?.journal_no}`);
  const cost2 = await inj('POST', `/api/assets/cip/${cipNo}/cost`, admin, { amount: 20000, source_type: 'manual', description: 'Steelwork', pay_source: 'cash' });
  ok('CIP: add cost line 2 (20000, cash) posts Dr 1520 / Cr 1000; accumulated 50000', cost2.status === 201 && near(cost2.json?.accumulated_cost, 50000), `acc=${cost2.json?.accumulated_cost}`);
  ok('CIP: accumulated cost sits in 1520 (balance +50000), NOT yet in 1500', near(await tbBalance('1520'), cip1520Before + 50000) && near(await tbBalance('1500'), cip1500Before) && near(await tbCredit2('2000'), cip2000CrBefore + 30000), `b1520=${await tbBalance('1520')} b1500=${await tbBalance('1500')}`);
  // Settlement request (maker) — reason mandatory; posts nothing.
  const settleReq = await inj('POST', `/api/assets/cip/${cipNo}/settle`, admin, { name: 'Warehouse B', useful_life_months: 240, reason: 'Construction complete, ready for use', tax_useful_life_months: 120 });
  ok('CIP: settlement request → PendingSettlement, NO GL yet (1500 unchanged)', settleReq.status === 201 && settleReq.json?.status === 'PendingSettlement' && near(await tbBalance('1500'), cip1500Before), `st=${settleReq.json?.status} b1500=${await tbBalance('1500')}`);
  const settleSelf = await inj('POST', `/api/assets/cip/${cipNo}/settle/approve`, admin);
  ok('CIP: preparer self-approval blocked → 403 SOD_VIOLATION (FA-13)', settleSelf.status === 403 && settleSelf.json?.error?.code === 'SOD_VIOLATION', `${settleSelf.status} ${settleSelf.json?.error?.code}`);
  const settleAppr = await inj('POST', `/api/assets/cip/${cipNo}/settle/approve`, mgr);
  ok('CIP: a different user approves → asset created, reclass posts (Dr 1500 +50000 / Cr 1520 -50000)', settleAppr.status === 201 && /^FA-/.test(settleAppr.json?.asset_no ?? '') && near(settleAppr.json?.capitalized_cost, 50000) && near(await tbBalance('1500'), cip1500Before + 50000) && near(await tbBalance('1520'), cip1520Before), `asset=${settleAppr.json?.asset_no} b1500=${await tbBalance('1500')} b1520=${await tbBalance('1520')}`);
  const cipReg = (await inj('GET', '/api/assets', admin)).json;
  const cipFa = (cipReg.assets ?? []).find((x: any) => x.asset_no === settleAppr.json?.asset_no);
  ok('CIP: settled asset is on the register with source CIP traceability + its own tax book', cipFa?.source_cip_no === cipNo && near(cipFa?.acquire_cost, 50000) && near(cipFa?.tax_net_book_value, 50000), `cip=${cipFa?.source_cip_no} cost=${cipFa?.acquire_cost} tnbv=${cipFa?.tax_net_book_value}`);
  const cipAdd = await inj('POST', `/api/assets/cip/${cipNo}/cost`, admin, { amount: 1000 });
  ok('CIP: a capitalized CIP rejects further cost (CIP_NOT_OPEN)', cipAdd.status === 400 && cipAdd.json?.error?.code === 'CIP_NOT_OPEN', `${cipAdd.status} ${cipAdd.json?.error?.code}`);
  const emptyCip = await inj('POST', '/api/assets/cip', admin, { name: 'Empty project' });
  const emptySettle = await inj('POST', `/api/assets/cip/${emptyCip.json?.cip_no}/settle`, admin, { useful_life_months: 60, reason: 'test' });
  ok('CIP: a CIP with no accumulated cost cannot be settled (CIP_NO_COST)', emptySettle.status === 400 && emptySettle.json?.error?.code === 'CIP_NO_COST', `${emptySettle.status} ${emptySettle.json?.error?.code}`);

  // ───────────────────── Perpetual inventory valuation sub-ledger (INV-01..04) ─────────────────────
  // Run in a dedicated tenant so the inventory control account (1200) is isolated from the cash-flow seed.
  const [invT] = await db.insert(s.tenants).values({ code: 'INVT', name: 'Inventory Co' }).returning({ id: s.tenants.id });
  const invTid = Number(invT.id);
  await db.insert(s.users).values([
    { username: 'invmgr', passwordHash: await pw.hash('inv123'), role: 'Admin', tenantId: invTid },
    { username: 'invchk', passwordHash: await pw.hash('inv123'), role: 'Admin', tenantId: invTid }, // INV-07: a different write-off approver
    { username: 'itemgod', passwordHash: await pw.hash('god123'), role: 'Admin', tenantId: hq }, // Phase 11: the platform owner (only god may merge shared items)
  ]).onConflictDoNothing();
  const invmgr = (await inj('POST', '/api/login', undefined, { username: 'invmgr', password: 'inv123' })).json.token;
  const invchk = (await inj('POST', '/api/login', undefined, { username: 'invchk', password: 'inv123' })).json.token;
  const itemgod = (await inj('POST', '/api/login', undefined, { username: 'itemgod', password: 'god123' })).json.token;

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
  // Master-data audit Phase 2: warehouse master fields (name/zone/type/capacity/temperature/active/notes)
  // were previously read-only (locationName/zone) or entirely unexposed (type/capacity/temperature/notes).
  const whMaster = await inj('PATCH', '/api/item-setup/warehouses/WH-DET', invmgr, {
    location_name: 'Cold store B', zone: 'B', type: 'ColdStorage', capacity: 500, temperature: 'Chilled', active: true, notes: 'Backup cold store',
  });
  ok('Setup: warehouse master fields now editable (name/zone/type/capacity/temperature/notes)',
    whMaster.status === 200 && whMaster.json?.location_name === 'Cold store B' && whMaster.json?.zone === 'B' && whMaster.json?.type === 'ColdStorage' && near(whMaster.json?.capacity, 500) && whMaster.json?.temperature === 'Chilled' && whMaster.json?.notes === 'Backup cold store',
    JSON.stringify(whMaster.json).slice(0, 150));
  const whList = (await inj('GET', '/api/item-setup/warehouses', invmgr)).json;
  const whRow = (whList.warehouses ?? []).find((w: any) => w.location_id === 'WH-DET');
  ok('Setup: warehouse list projects the new master fields', whRow?.type === 'ColdStorage' && near(whRow?.capacity, 500) && whRow?.temperature === 'Chilled', JSON.stringify(whRow).slice(0, 120));
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

  // Master-data audit Phase 2: item-master fields (barcode/UOM/stock thresholds/MRP lot-sizing/capital-asset
  // routing) exist on `items` but had zero maintenance surface on /setup/items (posting-profile only).
  const itemMaster = await inj('PATCH', '/api/item-setup/items/DETLOC', invmgr, {
    barcode: '8850000000012', uom: 'BOX', base_uom: 'EA', conversion_factor: 12, unit_price: 25,
    temperature_type: 'Ambient', bu_id: 'BU1', min_stock: 10, max_stock: 200, avg_daily_usage: 3, lead_time_days: 5,
    min_order_qty: 24, order_multiple: 12, order_cost: 50, holding_cost: 0.5, is_fixed_asset: false,
  });
  ok('Setup: item-master fields now editable via /setup/items (barcode/UOM/stock thresholds/MRP lot-sizing)',
    itemMaster.status === 200 && itemMaster.json?.barcode === '8850000000012' && itemMaster.json?.uom === 'BOX' && near(itemMaster.json?.conversion_factor, 12) && near(itemMaster.json?.min_stock, 10) && near(itemMaster.json?.min_order_qty, 24),
    JSON.stringify(itemMaster.json).slice(0, 200));
  const itemGet = (await inj('GET', '/api/item-setup/items/DETLOC', invmgr)).json;
  ok('Setup: item-master fields round-trip on GET', itemGet.barcode === '8850000000012' && near(itemGet.unit_price, 25) && near(itemGet.holding_cost, 0.5), JSON.stringify(itemGet).slice(0, 150));

  // ── Item lifecycle + relationships (master-data audit Phase 10) — DETLOC/CATITEM both seeded above. ──
  const setStat = await inj('PATCH', '/api/item-setup/items/DETLOC/status', invmgr, { status: 'discontinued', superseded_by: 'CATITEM' });
  ok('Item lifecycle: mark DETLOC discontinued + point superseded_by at CATITEM', setStat.status === 200 && setStat.json?.status === 'discontinued' && setStat.json?.superseded_by != null, JSON.stringify({ st: setStat.json?.status, sup: setStat.json?.superseded_by }));
  const relSelf = await inj('POST', '/api/item-setup/items/DETLOC/relationships', invmgr, { to_item_id: 'DETLOC', rel_type: 'substitute' });
  ok('Item relationship: cannot relate to itself → 400 SELF_RELATION', relSelf.status === 400 && relSelf.json?.error?.code === 'SELF_RELATION', `${relSelf.status} ${relSelf.json?.error?.code}`);
  const relAdd = await inj('POST', '/api/item-setup/items/DETLOC/relationships', invmgr, { to_item_id: 'CATITEM', rel_type: 'substitute', note: 'ใช้แทนกันได้' });
  ok('Item relationship: add a typed relationship (substitute → CATITEM)', (relAdd.status === 201 || relAdd.status === 200) && relAdd.json?.rel_type === 'substitute' && relAdd.json?.party?.item_id === 'CATITEM', JSON.stringify(relAdd.json).slice(0, 140));
  const relDup = await inj('POST', '/api/item-setup/items/DETLOC/relationships', invmgr, { to_item_id: 'CATITEM', rel_type: 'substitute' });
  ok('Item relationship: duplicate (same from/to/type) → 409 RELATION_EXISTS', relDup.status === 409 && relDup.json?.error?.code === 'RELATION_EXISTS', `${relDup.status} ${relDup.json?.error?.code}`);
  const relListFrom = await inj('GET', '/api/item-setup/items/DETLOC/relationships', invmgr);
  ok('Item relationship: DETLOC lists it as OUTGOING', (relListFrom.json?.relationships ?? []).some((r: any) => r.direction === 'outgoing' && r.rel_type === 'substitute' && r.party.item_id === 'CATITEM'), JSON.stringify(relListFrom.json?.relationships));
  const relListTo = await inj('GET', '/api/item-setup/items/CATITEM/relationships', invmgr);
  ok('Item relationship: CATITEM sees the same link as INCOMING (from DETLOC)', (relListTo.json?.relationships ?? []).some((r: any) => r.direction === 'incoming' && r.party.item_id === 'DETLOC'), JSON.stringify(relListTo.json?.relationships));
  const relDelMissing = await inj('DELETE', '/api/item-setup/items/DETLOC/relationships/999999', invmgr);
  ok('Item relationship: delete non-existent → 404 RELATION_NOT_FOUND', relDelMissing.status === 404 && relDelMissing.json?.error?.code === 'RELATION_NOT_FOUND', `${relDelMissing.status} ${relDelMissing.json?.error?.code}`);
  const relDel = await inj('DELETE', `/api/item-setup/items/DETLOC/relationships/${relAdd.json.id}`, invmgr);
  ok('Item relationship: delete removes it from both sides', relDel.status === 200 && (await inj('GET', '/api/item-setup/items/CATITEM/relationships', invmgr)).json.relationships.length === 0, `${relDel.status}`);

  // ── Item match-merge / DQM (master-data audit Phase 11) — items are a SHARED master, so merge is god-only ──
  // Two near-identical items (same barcode + description); DUPZB carries a child stock row that must repoint.
  await db.insert(s.items).values([
    { itemId: 'DUPZA', itemDescription: 'Zeta Cola 500ml', barcode: '8859999000001' },
    { itemId: 'DUPZB', itemDescription: 'Zeta Cola 500ml', barcode: '8859999000001' },
  ]).onConflictDoNothing();
  await inj('POST', '/api/inventory/receipts', invmgr, { item_id: 'DUPZB', uom: 'EA', qty: 20, unit_cost: 8, ref_type: 'GRN', ref_id: 'GRN-DUP' });
  const dupList = await inj('GET', '/api/item-setup/items-duplicates', invmgr);
  const dupGroup = (dupList.json?.groups ?? []).find((g: any) => [g.primary.item_id, ...g.duplicates.map((d: any) => d.item_id)].includes('DUPZA') && [g.primary.item_id, ...g.duplicates.map((d: any) => d.item_id)].includes('DUPZB'));
  ok('Item DQM: detection groups DUPZA/DUPZB by barcode + description', !!dupGroup && (dupGroup.duplicates[0]?.reasons ?? []).includes('barcode') && dupGroup.duplicates[0]?.reasons.includes('description'), JSON.stringify(dupGroup?.duplicates?.[0]?.reasons));
  const mergeSelf = await inj('POST', '/api/item-setup/items-merge', itemgod, { survivor_item_id: 'DUPZA', duplicate_item_id: 'DUPZA' });
  ok('Item DQM: cannot merge an item into itself → 400 SELF_MERGE', mergeSelf.status === 400 && mergeSelf.json?.error?.code === 'SELF_MERGE', `${mergeSelf.status} ${mergeSelf.json?.error?.code}`);
  const mergeNotGod = await inj('POST', '/api/item-setup/items-merge', invmgr, { survivor_item_id: 'DUPZA', duplicate_item_id: 'DUPZB' });
  ok('Item DQM: a per-tenant Admin (non-god) cannot merge shared items → 403 ITEM_MERGE_HQ_ONLY', mergeNotGod.status === 403 && mergeNotGod.json?.error?.code === 'ITEM_MERGE_HQ_ONLY', `${mergeNotGod.status} ${mergeNotGod.json?.error?.code}`);
  const merge = await inj('POST', '/api/item-setup/items-merge', itemgod, { survivor_item_id: 'DUPZA', duplicate_item_id: 'DUPZB' });
  ok('Item DQM: the platform owner merges DUPZB into DUPZA', merge.status === 201 && merge.json?.merged === true, JSON.stringify(merge.json).slice(0, 120));
  const dupbAfter = (await inj('GET', '/api/item-setup/items/DUPZB', itemgod)).json;
  ok('Item DQM: the duplicate is soft-retired (status=merged, merged_into set — history preserved)', dupbAfter.status === 'merged' && dupbAfter.merged_into != null, JSON.stringify({ st: dupbAfter.status, into: dupbAfter.merged_into }));
  const movesSurv = (await inj('GET', '/api/inventory/moves?item_id=DUPZA', invmgr)).json;
  const movesDup = (await inj('GET', '/api/inventory/moves?item_id=DUPZB', invmgr)).json;
  ok('Item DQM: the duplicate’s child stock rows repointed to the survivor (text item_id repoint)', (movesSurv.moves ?? []).some((m: any) => m.ref_id === 'GRN-DUP') && !(movesDup.moves ?? []).some((m: any) => m.ref_id === 'GRN-DUP'), `surv=${(movesSurv.moves ?? []).length} dup=${(movesDup.moves ?? []).length}`);
  const mergeAgain = await inj('POST', '/api/item-setup/items-merge', itemgod, { survivor_item_id: 'DUPZA', duplicate_item_id: 'DUPZB' });
  ok('Item DQM: an already-merged duplicate cannot be merged again → 400 ALREADY_MERGED', mergeAgain.status === 400 && mergeAgain.json?.error?.code === 'ALREADY_MERGED', `${mergeAgain.status} ${mergeAgain.json?.error?.code}`);

  // ── Date-effective (future-dated) master attributes (master-data audit Phase 12) ──
  // A steward schedules a change to a master field; the idempotent daily job applies it only once its
  // effective date arrives. A change to a sensitive field (customer credit limit) is staged for a distinct
  // approver first (maker-checker, G7). `admin` (HQ) schedules/runs; `mgr` (a different HQ user) approves.
  const dayAhead = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  await db.insert(s.items).values({ itemId: 'SCHEDITEM', itemDescription: 'Date-effective item', unitPrice: '10' }).onConflictDoNothing();
  const schPrice = await inj('POST', '/api/scheduled-changes', admin, { entity: 'item', entity_key: 'SCHEDITEM', field: 'unit_price', new_value: '25', effective_date: daysAgo(2) });
  ok('Date-effective: schedule a (non-sensitive) item price change → scheduled, not sensitive', schPrice.status === 201 && schPrice.json?.status === 'scheduled' && schPrice.json?.sensitive === false, JSON.stringify(schPrice.json).slice(0, 120));
  const schFuture = await inj('POST', '/api/scheduled-changes', admin, { entity: 'item', entity_key: 'SCHEDITEM', field: 'status', new_value: 'inactive', effective_date: dayAhead(3) });
  ok('Date-effective: schedule a future-dated status change (not yet due)', schFuture.status === 201 && schFuture.json?.status === 'scheduled', `${schFuture.status} ${schFuture.json?.status}`);
  const schBad = await inj('POST', '/api/scheduled-changes', admin, { entity: 'item', entity_key: 'SCHEDITEM', field: 'barcode', new_value: 'x', effective_date: daysAgo(1) });
  ok('Date-effective: an unsupported field is rejected → 400 UNSUPPORTED_FIELD', schBad.status === 400 && schBad.json?.error?.code === 'UNSUPPORTED_FIELD', `${schBad.status} ${schBad.json?.error?.code}`);
  const schCredit = await inj('POST', '/api/scheduled-changes', admin, { entity: 'customer', entity_key: 'CUST', field: 'credit_limit', new_value: '99999', effective_date: daysAgo(2) });
  ok('Date-effective: a sensitive credit-limit change is STAGED pending_approval (G7), not scheduled', schCredit.status === 201 && schCredit.json?.status === 'pending_approval' && schCredit.json?.sensitive === true, JSON.stringify(schCredit.json).slice(0, 120));
  const schSelf = await inj('POST', `/api/scheduled-changes/${schCredit.json.id}/approve`, admin);
  ok('Date-effective: the scheduler cannot self-approve a sensitive change → 403 SOD_VIOLATION', schSelf.status === 403 && schSelf.json?.error?.code === 'SOD_VIOLATION', `${schSelf.status} ${schSelf.json?.error?.code}`);
  const schAppr = await inj('POST', `/api/scheduled-changes/${schCredit.json.id}/approve`, mgr);
  ok('Date-effective: a distinct approver releases the sensitive change → scheduled', schAppr.status === 201 && schAppr.json?.status === 'scheduled', `${schAppr.status} ${schAppr.json?.status}`);
  const runDue = await inj('POST', '/api/scheduled-changes/run-due', admin);
  ok('Date-effective: run-due applies only the due (scheduled) changes — the future-dated one is skipped', runDue.status === 201 && runDue.json?.applied === 2 && runDue.json?.scanned === 2, JSON.stringify(runDue.json));
  const schedItem = (await inj('GET', '/api/item-setup/items/SCHEDITEM', admin)).json;
  ok('Date-effective: the due price change is now on the item; the future status change is NOT applied', near(schedItem.unit_price, 25) && schedItem.status === 'active', JSON.stringify({ price: schedItem.unit_price, status: schedItem.status }));
  const custRow = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'CUST')))[0];
  ok('Date-effective: the approved credit-limit change was applied to the customer master', near(custRow.creditLimit, 99999), `limit=${custRow.creditLimit}`);
  const runAgain = await inj('POST', '/api/scheduled-changes/run-due', admin);
  ok('Date-effective: run-due is idempotent — a second run the same day applies nothing', runAgain.status === 201 && runAgain.json?.applied === 0, JSON.stringify(runAgain.json));

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

  // P3 — real per-industry structure: an industry chart curates canonical SUB-accounts (postable, reported)
  // under a parent; a restaurant chart never shows them (byte-identical to before); a sub-account posts and
  // rolls into the correct statutory statement line; and it nests directly under its parent in the listing.
  const sgCon = await inj('POST', '/api/auth/signup', undefined, {
    company_name: 'Con Co', tenant_code: 'CONCO', admin_username: 'con_admin', admin_password: 'con1234567', email: 'a@con.example', industry: 'construction',
  });
  ok('P3: signup with industry=construction succeeds', (sgCon.status === 200 || sgCon.status === 201) && sgCon.json?.industry === 'construction', `st=${sgCon.status}`);
  const conTok = (await inj('POST', '/api/login', undefined, { username: 'con_admin', password: 'con1234567' })).json.token;
  const conAcc = (await inj('GET', '/api/ledger/accounts', conTok)).json;
  const conCodes = new Set((conAcc.accounts ?? []).map((a: any) => a.code));
  ok('P3: construction chart curates WIP-by-phase + cost-by-resource sub-accounts (126001..126004, 580001..580004)',
    ['126001', '126002', '126003', '126004', '580001', '580002', '580003', '580004'].every((c) => conCodes.has(c)),
    `have=${['126001', '580001', '580004'].filter((c) => conCodes.has(c)).join(',')}`);
  ok('P3: a restaurant chart does NOT show the construction sub-accounts (per-industry curation)',
    !restoAcc.accounts?.some((a: any) => a.code === '126001' || a.code === '580001'), 'restaurant clean');
  // A sub-account nests directly under its canonical parent in the ordered listing.
  const conList: any[] = conAcc.accounts ?? [];
  const idxParent = conList.findIndex((a: any) => a.code === '1260');
  const idxChild1 = conList.findIndex((a: any) => a.code === '126001');
  ok('P3: sub-account 126001 nests directly under its parent 1260 in the ordered chart',
    idxParent >= 0 && idxChild1 === idxParent + 1, `parent@${idxParent} child@${idxChild1}`);
  // The sub-account is a real postable canonical account (passes the GL-21 account-universe guard, not
  // overlay-only) — a balanced JE to it is accepted (Draft, awaiting maker-checker).
  const conJe = await inj('POST', '/api/ledger/journal', conTok, { source: 'Manual', memo: 'P3 WIP capitalize', lines: [{ account_code: '126002', debit: 5000 }, { account_code: '1010', credit: 5000 }] });
  ok('P3: a sub-account (126002) is postable (real canonical account, passes GL-21, not overlay-only)', conJe.status === 201 || conJe.status === 200, `st=${conJe.status} ${JSON.stringify(conJe.json?.error ?? '')}`);
  // The DBD statutory balance sheet renders + balances for the construction tenant — the industry
  // sub-accounts (WIP-by-phase under 1260 → current assets, cost-by-resource under 5800 → cogs) integrate
  // cleanly into the statutory statement (proven metadata-correct by statement-sections.test.ts).
  const asOfP3 = new Date(Date.now() + Number(process.env.BUSINESS_TZ_OFFSET_MIN ?? 420) * 60_000).toISOString().slice(0, 10);
  const conBs = (await inj('GET', `/api/reports/fs/render/DBD-BS?as_of=${asOfP3}`, conTok)).json;
  const conTA = conBs.rows?.find((r: any) => r.key === 'total_assets')?.current;
  const conTLE = conBs.rows?.find((r: any) => r.key === 'total_liab_equity')?.current;
  ok('P3: the DBD balance sheet renders + balances for the construction tenant (sub-accounts integrate cleanly)',
    conBs.rows?.some((r: any) => r.key === 'current_assets') && near(conTA, conTLE), `ta=${conTA} tle=${conTLE}`);

  // P5 — the remaining verticals curate their own genuine sub-accounts too (nonprofit has the unusual
  // equity + functional-expense split; logistics has cost-of-service-by-resource). A restaurant never sees them.
  const sgNpo = await inj('POST', '/api/auth/signup', undefined, {
    company_name: 'Npo Co', tenant_code: 'NPOCO', admin_username: 'npo_admin', admin_password: 'npo1234567', email: 'a@npo.example', industry: 'nonprofit',
  });
  const npoTok = (await inj('POST', '/api/login', undefined, { username: 'npo_admin', password: 'npo1234567' })).json.token;
  const npoCodes = new Set(((await inj('GET', '/api/ledger/accounts', npoTok)).json.accounts ?? []).map((a: any) => a.code));
  ok('P5: nonprofit chart curates restricted/unrestricted net assets + functional-expense + grant/donation sub-accounts',
    ['310010', '310011', '510020', '510021', '510022', '430030', '430031'].every((c) => npoCodes.has(c)),
    `have=${['310010', '510020', '430030'].filter((c) => npoCodes.has(c)).join(',')}`);
  const sgLog = await inj('POST', '/api/auth/signup', undefined, {
    company_name: 'Log Co', tenant_code: 'LOGCO', admin_username: 'log_admin', admin_password: 'log1234567', email: 'a@log.example', industry: 'logistics',
  });
  const logTok = (await inj('POST', '/api/login', undefined, { username: 'log_admin', password: 'log1234567' })).json.token;
  const logCodes = new Set(((await inj('GET', '/api/ledger/accounts', logTok)).json.accounts ?? []).map((a: any) => a.code));
  ok('P5: logistics chart curates cost-of-service-by-resource sub-accounts (fuel/driver/subcontract/R&M/warehousing)',
    ['580020', '580021', '580022', '580023', '580024'].every((c) => logCodes.has(c)), `have=${['580020', '580024'].filter((c) => logCodes.has(c)).join(',')}`);
  ok('P5: an unrelated (restaurant) chart shows none of the nonprofit or logistics sub-accounts (per-industry curation)',
    !restoAcc.accounts?.some((a: any) => ['310010', '510020', '430030', '580020'].includes(a.code)), 'restaurant clean');

  // P6 — the default DBD-PL render resolves the caller's industry to a bespoke statement SHAPE that still
  // ties to the canonical income statement. Construction → cost-of-work layout (net_profit); nonprofit →
  // a Statement of Activities (change_in_net_assets); a generic tenant keeps the standard multi-step P&L.
  const fsFromP6 = '2000-01-01';
  const conIs = (await inj('GET', `/api/ledger/income-statement?from=${fsFromP6}&to=${asOfP3}`, conTok)).json;
  const conPl = (await inj('GET', `/api/reports/fs/render/DBD-PL?as_of=${asOfP3}&from=${fsFromP6}`, conTok)).json;
  const rowKey = (rows: any[], key: string) => rows?.find((r: any) => r.key === key)?.current;
  ok('P6: a construction tenant’s default DBD-PL is the cost-of-work layout (labour/materials/subcontract lines) + ties to net income',
    conPl.rows?.some((r: any) => r.key === 'cw_labor') && conPl.rows?.some((r: any) => r.key === 'cw_subcontract') && near(rowKey(conPl.rows, 'net_profit'), conIs.net_income),
    `hasCW=${conPl.rows?.some((r: any) => r.key === 'cw_labor')} np=${rowKey(conPl.rows, 'net_profit')} ni=${conIs.net_income}`);
  const npoIs = (await inj('GET', `/api/ledger/income-statement?from=${fsFromP6}&to=${asOfP3}`, npoTok)).json;
  const npoPl = (await inj('GET', `/api/reports/fs/render/DBD-PL?as_of=${asOfP3}&from=${fsFromP6}`, npoTok)).json;
  ok('P6: a nonprofit tenant’s default DBD-PL is a Statement of Activities (program/admin/fundraising + change in net assets) + ties to net income',
    npoPl.rows?.some((r: any) => r.key === 'exp_program') && npoPl.rows?.some((r: any) => r.key === 'change_in_net_assets') && near(rowKey(npoPl.rows, 'change_in_net_assets'), npoIs.net_income),
    `hasFunc=${npoPl.rows?.some((r: any) => r.key === 'exp_program')} cna=${rowKey(npoPl.rows, 'change_in_net_assets')} ni=${npoIs.net_income}`);
  const genPl = (await inj('GET', `/api/reports/fs/render/DBD-PL?as_of=${asOfP3}&from=${fsFromP6}`, genTok)).json;
  ok('P6: a generic (non-specialised) tenant keeps the standard multi-step DBD-PL (gross_profit → net_profit)',
    genPl.rows?.some((r: any) => r.key === 'gross_profit') && genPl.rows?.some((r: any) => r.key === 'net_profit') && !genPl.rows?.some((r: any) => r.key === 'change_in_net_assets'),
    JSON.stringify((genPl.rows ?? []).map((r: any) => r.key)));

  // P6b — the statutory P&L viewer lets a user pick WHICH industry layout to render, overriding their own
  // industry. A generic tenant can view the manufacturing COGS-by-element shape, or force the standard
  // multi-step P&L; the numbers are still the tenant's OWN GL so the bottom line ties to net income either way.
  const genIs = (await inj('GET', `/api/ledger/income-statement?from=${fsFromP6}&to=${asOfP3}`, genTok)).json;
  const genAsMfg = (await inj('GET', `/api/reports/fs/render/DBD-PL?as_of=${asOfP3}&from=${fsFromP6}&industry=manufacturing`, genTok)).json;
  ok('P6b: industry=manufacturing renders the COGS-by-element shape for ANY tenant + still ties to net income',
    genAsMfg.rows?.some((r: any) => r.key === 'cogs_dm') && genAsMfg.rows?.some((r: any) => r.key === 'cogs_moh') && genAsMfg.industry === 'manufacturing' && near(rowKey(genAsMfg.rows, 'net_profit'), genIs.net_income),
    `hasDM=${genAsMfg.rows?.some((r: any) => r.key === 'cogs_dm')} ind=${genAsMfg.industry} np=${rowKey(genAsMfg.rows, 'net_profit')} ni=${genIs.net_income}`);
  // A specialised tenant (construction) can force the GENERIC multi-step shape via industry=generic.
  const conForceGen = (await inj('GET', `/api/reports/fs/render/DBD-PL?as_of=${asOfP3}&from=${fsFromP6}&industry=generic`, conTok)).json;
  ok('P6b: industry=generic forces the standard multi-step P&L even for a specialised (construction) tenant',
    conForceGen.rows?.some((r: any) => r.key === 'gross_profit') && !conForceGen.rows?.some((r: any) => r.key === 'cw_labor'),
    JSON.stringify((conForceGen.rows ?? []).map((r: any) => r.key)));
  // The layouts catalog surfaces the bespoke shapes per statement (DBD-PL / DBD-BS) + the caller's own industry.
  const layoutsCat = (await inj('GET', '/api/reports/fs/industry-layouts', conTok)).json;
  const plCat = layoutsCat.statements?.['DBD-PL'];
  const bsCat = layoutsCat.statements?.['DBD-BS'];
  ok('P6b: /industry-layouts lists the bespoke P&L shapes + echoes the caller’s own industry',
    layoutsCat.own_industry === 'construction' && plCat?.own_has_layout === true && Array.isArray(plCat?.layouts) && plCat.layouts.some((l: any) => l.industry === 'manufacturing') && plCat.layouts.some((l: any) => l.industry === 'nonprofit'),
    `own=${layoutsCat.own_industry} plHasLayout=${plCat?.own_has_layout} nPl=${plCat?.layouts?.length}`);

  // P7 — the balance sheet gets the same industry-selectable treatment where the statement SHAPE differs:
  // nonprofit net-assets-by-restriction, agriculture biological assets, construction contract assets,
  // real-estate property inventory. Every layout ties out (total assets == total liabilities + equity/net assets).
  ok('P7: /industry-layouts DBD-BS lists the bespoke balance-sheet shapes (nonprofit/agriculture/construction/realestate)',
    Array.isArray(bsCat?.layouts) && ['nonprofit', 'agriculture', 'construction', 'realestate'].every((i) => bsCat.layouts.some((l: any) => l.industry === i)) && bsCat.own_has_layout === true,
    `nBs=${bsCat?.layouts?.length} bsHasLayout=${bsCat?.own_has_layout}`);
  // A nonprofit tenant's default DBD-BS is a Statement of Financial Position with net assets split by restriction.
  const npoBsSelf = (await inj('GET', `/api/reports/fs/render/DBD-BS?as_of=${asOfP3}`, npoTok)).json;
  const npoBsGen = (await inj('GET', `/api/reports/fs/render/DBD-BS?as_of=${asOfP3}&industry=generic`, npoTok)).json;
  const taRow = (rows: any[]) => rowKey(rows, 'total_assets');
  ok('P7: nonprofit DBD-BS presents net assets with/without donor restrictions + ties (assets == liab + net assets)',
    npoBsSelf.rows?.some((r: any) => r.key === 'na_restricted') && npoBsSelf.rows?.some((r: any) => r.key === 'na_unrestricted') && !npoBsSelf.rows?.some((r: any) => r.key === '_all_equity') && near(taRow(npoBsSelf.rows), rowKey(npoBsSelf.rows, 'total_liab_net_assets')),
    `hasNa=${npoBsSelf.rows?.some((r: any) => r.key === 'na_unrestricted')} hidden=${npoBsSelf.rows?.some((r: any) => r.key === '_all_equity')} ta=${taRow(npoBsSelf.rows)} tlna=${rowKey(npoBsSelf.rows, 'total_liab_net_assets')}`);
  // The industry override renders ANY BS shape over the caller's own GL; total assets identical to generic (only grouping changes).
  const conBsAsAgri = (await inj('GET', `/api/reports/fs/render/DBD-BS?as_of=${asOfP3}&industry=agriculture`, conTok)).json;
  const conBsGen = (await inj('GET', `/api/reports/fs/render/DBD-BS?as_of=${asOfP3}&industry=generic`, conTok)).json;
  ok('P7: industry=agriculture renders the biological-assets BS for ANY tenant; total assets unchanged vs generic',
    conBsAsAgri.rows?.some((r: any) => r.key === 'biological_assets') && conBsAsAgri.industry === 'agriculture' && near(taRow(conBsAsAgri.rows), taRow(conBsGen.rows)),
    `hasBio=${conBsAsAgri.rows?.some((r: any) => r.key === 'biological_assets')} taAgri=${taRow(conBsAsAgri.rows)} taGen=${taRow(conBsGen.rows)}`);
  // A construction tenant's own default DBD-BS surfaces contract WIP; nonprofit forced to generic drops the net-asset split.
  ok('P7: construction default DBD-BS surfaces contract-WIP; nonprofit industry=generic keeps the standard equity presentation',
    (await inj('GET', `/api/reports/fs/render/DBD-BS?as_of=${asOfP3}`, conTok)).json.rows?.some((r: any) => r.key === 'contract_wip') && npoBsGen.rows?.some((r: any) => r.key === 'total_equity') && !npoBsGen.rows?.some((r: any) => r.key === 'na_restricted'),
    `conWip=ok npoGenEquity=${npoBsGen.rows?.some((r: any) => r.key === 'total_equity')}`);

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
  // Business day (Asia/Bangkok, UTC+7 — matches the API's ymd()/bizYmdDash). MUST be the business day, not
  // the UTC date: JEs posted through the API are stamped entryDate=ymd() (business day), so a UTC `today`
  // used as a report window bound (e.g. the FIN-4 SOCE `fsTo` below) drops the day's own postings during the
  // Bangkok-morning / UTC-evening window (entryDate=businessDay > to=utcDay) → off-by-one window drift.
  const today = new Date(Date.now() + Number(process.env.BUSINESS_TZ_OFFSET_MIN ?? 420) * 60_000).toISOString().slice(0, 10);
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

  // ───────────────────── FIN-7a — Dimension-filtered TB / GL-detail / P&L ─────────────────────
  // Reports accept additive ?project_id=&dept_id=&branch_id= (aggregated from journal LINES — the
  // gl_period_balances snapshot is cost-center-keyed); with no filter the original paths are unchanged.
  // Seed real masters so GET /api/ledger/dimensions can label them, then one JE tagged with all three.
  const [dimBr] = await db.insert(s.branches).values({ tenantId: hq, code: 'BR-DIM', name: 'Dimension Branch' }).returning({ id: s.branches.id });
  const [dimPj] = await db.insert(s.projects).values({ tenantId: hq, projectCode: 'PJ-DIM', name: 'Dimension Project' }).returning({ id: s.projects.id });
  const [dimDp] = await db.insert(s.departments).values({ tenantId: hq, code: 'DP-DIM', name: 'Dimension Dept' }).returning({ id: s.departments.id });
  const pjId = Number(dimPj.id), dpId = Number(dimDp.id), brId = Number(dimBr.id);

  // Resync the R1-2 snapshot FIRST (TC-GL-13-03's direct insert above never rebuilt it), so the unfiltered
  // baseline below is clean and the after-vs-before delta isolates this block's own JE.
  await rebuildGl();
  const tbAllBefore = (await inj('GET', '/api/ledger/trial-balance', admin)).json; // unfiltered baseline
  jeSeq++;
  const [hd1] = await db.insert(s.journalEntries).values({
    entryNo: `JE-D${String(jeSeq).padStart(4, '0')}`, entryDate: today, period: today.slice(0, 7),
    source: 'TEST-FIN7A', sourceRef: `FIN7A-${jeSeq}`, tenantId: hq, currency: 'THB', status: 'Posted', createdBy: 'seed',
  }).returning({ id: s.journalEntries.id });
  await db.insert(s.journalLines).values([
    { entryId: Number(hd1.id), accountCode: '5100', debit: '250', credit: '0', currency: 'THB', tenantId: hq, projectId: pjId, departmentId: dpId, branchId: brId },
    { entryId: Number(hd1.id), accountCode: '1000', debit: '0', credit: '250', currency: 'THB', tenantId: hq, projectId: pjId, departmentId: dpId, branchId: brId },
  ]);
  await rebuildGl(); // direct insert bypasses LedgerService → resync the R1-2 snapshot for the unfiltered path

  // TB filtered by project → ONLY this JE's two accounts, each net ±250 (use `balance`, not gross debit).
  const tbPj = await inj('GET', `/api/ledger/trial-balance?project_id=${pjId}`, admin);
  const tbPjRows: any[] = tbPj.json?.rows ?? [];
  ok('FIN-7a: TB filtered by project returns only that project\'s lines (5100 +250 / 1000 −250, balanced)',
    tbPj.status === 200 && tbPjRows.length === 2
      && near(tbPjRows.find((r) => r.account_code === '5100')?.balance, 250)
      && near(tbPjRows.find((r) => r.account_code === '1000')?.balance, -250)
      && tbPj.json?.totals?.balanced === true && tbPj.json?.project_id === pjId,
    `st=${tbPj.status} rows=${tbPjRows.map((r) => `${r.account_code}:${r.balance}`).join(',')}`);

  // dept + branch slices see the same single JE; an unused branch id returns an empty (still balanced) TB.
  const tbDp = await inj('GET', `/api/ledger/trial-balance?dept_id=${dpId}`, admin);
  const tbBrNone = await inj('GET', `/api/ledger/trial-balance?branch_id=999999`, admin);
  ok('FIN-7a: dept_id slice sees the tagged JE only; unused branch_id → empty rows',
    (tbDp.json?.rows ?? []).length === 2 && near(tbDp.json?.totals?.debit, 250)
      && tbBrNone.status === 200 && (tbBrNone.json?.rows ?? []).length === 0,
    `dept rows=${(tbDp.json?.rows ?? []).length} none=${(tbBrNone.json?.rows ?? []).length}`);

  // Unfiltered TB is UNCHANGED in shape/semantics: same snapshot path, no dimension echo keys, totals move
  // only by the new JE's 250/250, and it still balances.
  const tbAllAfter = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  ok('FIN-7a: unfiltered TB unchanged (snapshot path — no dim keys; totals move only by the new 250/250; balanced)',
    !('project_id' in tbAllAfter) && !('dept_id' in tbAllAfter) && !('branch_id' in tbAllAfter)
      && near(tbAllAfter.totals?.debit, Number(tbAllBefore.totals?.debit) + 250)
      && near(tbAllAfter.totals?.credit, Number(tbAllBefore.totals?.credit) + 250)
      && tbAllAfter.totals?.balanced === true,
    `before=${tbAllBefore.totals?.debit} after=${tbAllAfter.totals?.debit}`);

  // Account-ledger drill-down honours the slice: only the tagged 5100 line, closing = the slice's own 250.
  const al5100Pj = (await inj('GET', `/api/ledger/account-ledger?account=5100&project_id=${pjId}`, admin)).json;
  const al5100All = (await inj('GET', '/api/ledger/account-ledger?account=5100', admin)).json;
  ok('FIN-7a: account-ledger project slice returns only the tagged line (closing 250); unfiltered has more',
    al5100Pj.count === 1 && near(al5100Pj.closing_balance, 250) && al5100Pj.project_id === pjId
      && al5100All.count > al5100Pj.count && !('project_id' in al5100All),
    `slice=${al5100Pj.count}/${al5100Pj.closing_balance} all=${al5100All.count}`);

  // P&L slice: the project's expense is exactly 250 → net −250.
  const isPj = (await inj('GET', `/api/ledger/income-statement?from=${today}&to=${today}&project_id=${pjId}`, admin)).json;
  ok('FIN-7a: income statement filtered by project → expense 250, net −250',
    near(isPj.expense, 250) && near(isPj.net_income, -250) && isPj.project_id === pjId,
    `exp=${isPj.expense} net=${isPj.net_income}`);

  // Dimension helper lists the in-use values with master labels (feeds the web dropdowns).
  const dimsRes = await inj('GET', '/api/ledger/dimensions', admin);
  ok('FIN-7a: GET /api/ledger/dimensions lists in-use project/dept/branch with labels',
    dimsRes.status === 200
      && (dimsRes.json?.projects ?? []).some((p: any) => p.id === pjId && p.code === 'PJ-DIM')
      && (dimsRes.json?.departments ?? []).some((p: any) => p.id === dpId && p.code === 'DP-DIM')
      && (dimsRes.json?.branches ?? []).some((p: any) => p.id === brId && p.code === 'BR-DIM'),
    `st=${dimsRes.status} pj=${JSON.stringify(dimsRes.json?.projects)}`);

  // Junk dimension param fails closed with the standard envelope (json.error.code, per AllExceptionsFilter).
  const tbBad = await inj('GET', '/api/ledger/trial-balance?project_id=abc', admin);
  ok('FIN-7a: non-integer project_id → 400 BAD_QUERY', tbBad.status === 400 && tbBad.json?.error?.code === 'BAD_QUERY', `st=${tbBad.status} code=${tbBad.json?.error?.code}`);

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
  // GL-05 (audit G2): the original preparer (admin) cannot reverse their own independently-approved entry —
  // the reverser must differ (maker-checker), or the reversal would silently undo the GL-05 control.
  const revSelfG2 = await inj('POST', `/api/ledger/journal/${glId}/reverse`, admin, { reason: 'self-reverse' });
  ok('GL-17/G2: preparer cannot reverse own entry (403 SOD_VIOLATION)', revSelfG2.status === 403 && revSelfG2.json?.error?.code === 'SOD_VIOLATION', `st=${revSelfG2.status} code=${revSelfG2.json?.error?.code}`);
  const rev = await inj('POST', `/api/ledger/journal/${glId}/reverse`, mgr, { reason: 'duplicate posting' });
  ok('GL-17: reverse a posted entry (by a DISTINCT user) → returns reversalId/originalId', rev.status === 200 && typeof rev.json?.reversalId === 'number' && rev.json?.originalId === glId, JSON.stringify(rev.json));
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

  // ── B1 Close Manager (docs/50 Wave 3): per-tenant configurable close tasks over the GL-15 checklist ──
  // A custom REQUIRED task (with owner/due-offset) gates the lock exactly like a standard step; a
  // dependency gates sign-off ORDER; an override template re-titles a standard step. No templates ⇒
  // byte-identical (every earlier GL-15/16 check above ran template-free).
  const tplBad = await inj('PUT', '/api/ledger/close/task-templates', admin, { templates: [{ step_key: 'a_task', title: 'x', depends_on_key: 'a_task' }] });
  ok('B1: self-dependency rejected (SELF_DEPENDENCY)', tplBad.status === 400 && tplBad.json?.error?.code === 'SELF_DEPENDENCY', `st=${tplBad.status} code=${tplBad.json?.error?.code}`);
  const tplBad2 = await inj('PUT', '/api/ledger/close/task-templates', admin, { templates: [{ step_key: 'a_task', title: 'x', depends_on_key: 'no_such_step' }] });
  ok('B1: unknown dependency rejected (UNKNOWN_DEPENDENCY)', tplBad2.status === 400 && tplBad2.json?.error?.code === 'UNKNOWN_DEPENDENCY', `st=${tplBad2.status} code=${tplBad2.json?.error?.code}`);
  const tplPut = await inj('PUT', '/api/ledger/close/task-templates', admin, { templates: [
    { step_key: 'insurance_review', title: 'ทบทวนกรมธรรม์ประกันภัยงวด', required: true, owner_role: 'FinancialController', due_day_offset: 3, depends_on_key: 'bank_rec' },
    { step_key: 'bank_rec', title: 'Bank reconciliation complete (ธนาคารหลัก + PromptPay)', required: true },
  ] });
  ok('B1: templates saved (1 custom + 1 standard override)', tplPut.status === 200 && tplPut.json?.count === 2 && (tplPut.json?.standard_steps ?? []).length >= 9, `st=${tplPut.status} n=${tplPut.json?.count}`);
  const b1Period = '2020-03';
  const b1Start = await inj('POST', '/api/ledger/close/start', admin, { period: b1Period });
  const b1RunId = Number(b1Start.json?.id);
  const b1Steps = b1Start.json?.steps ?? [];
  const b1Custom = b1Steps.find((st: any) => st.step_key === 'insurance_review');
  ok('B1: startClose seeds standard + custom task (owner, due = period end + 3d, dependency)',
    b1Steps.length >= 10 && !!b1Custom && b1Custom.required === true && b1Custom.owner_role === 'FinancialController' && String(b1Custom.due_date).startsWith('2020-04-03') && b1Custom.depends_on_key === 'bank_rec',
    JSON.stringify(b1Custom));
  ok('B1: an override template re-titles the standard step (bank_rec)', /PromptPay/.test(b1Steps.find((st: any) => st.step_key === 'bank_rec')?.title ?? ''), b1Steps.find((st: any) => st.step_key === 'bank_rec')?.title);
  const depBlocked = await inj('POST', '/api/ledger/close/step', admin, { close_run_id: b1RunId, step_key: 'insurance_review' });
  ok('B1: dependent task blocked before its predecessor (DEPENDENCY_NOT_DONE)', depBlocked.status === 400 && depBlocked.json?.error?.code === 'DEPENDENCY_NOT_DONE', `st=${depBlocked.status} code=${depBlocked.json?.error?.code}`);
  for (const st of b1Steps.filter((x: any) => x.required && x.step_key !== 'insurance_review')) {
    await inj('POST', '/api/ledger/close/step', admin, { close_run_id: b1RunId, step_key: st.step_key });
  }
  const b1LockEarly = await inj('POST', '/api/ledger/close/lock', mgr, { close_run_id: b1RunId });
  ok('B1: lock blocked while the custom REQUIRED task is pending (STEPS_INCOMPLETE lists it)', b1LockEarly.status === 400 && b1LockEarly.json?.error?.code === 'STEPS_INCOMPLETE' && /insurance_review/.test(b1LockEarly.json?.error?.message ?? ''), `st=${b1LockEarly.status} msg=${b1LockEarly.json?.error?.message}`);
  const depOk = await inj('POST', '/api/ledger/close/step', admin, { close_run_id: b1RunId, step_key: 'insurance_review' });
  ok('B1: predecessor Done → dependent task signs off; run ReadyToLock', depOk.status === 200 && depOk.json?.status === 'ReadyToLock', `st=${depOk.status} status=${depOk.json?.status}`);
  const b1Lock = await inj('POST', '/api/ledger/close/lock', mgr, { close_run_id: b1RunId });
  ok('B1: maker-checker lock unchanged (a different user locks)', b1Lock.status === 200 && b1Lock.json?.status === 'Locked', `st=${b1Lock.status} status=${b1Lock.json?.status}`);
  await inj('PUT', '/api/ledger/close/task-templates', admin, { templates: [] }); // restore template-free default

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

  // TC-C2-07: MY e-invoice — the MyInvois UBL 2.1 document is PREPARED + hashed, but with no live LHDN
  // transport wired the submission is honestly `pending` (not a fabricated `accepted`). Config body uses
  // { provider: '...' }; submit body wraps doc in { doc: { ... } }.
  const setMy = await inj('PUT', '/api/einvoice/config', admin, { provider: 'einvoice.my.myinvois' });
  const myInv = await inj('POST', '/api/einvoice/submit', admin, { doc: { doc_ref: 'MY-INV-C2-001', seller: 'Oshinei MY Sdn Bhd', buyer: 'Test Buyer MY', total: 106, currency: 'MYR' } });
  ok('C2: MY e-invoice (MyInvois UBL 2.1) prepared → status=pending (no live transport), ref EINV-, no fake QR',
    setMy.status === 200 && myInv.json?.status === 'pending' && String(myInv.json?.ref ?? '').startsWith('EINV-') && (myInv.json?.qr ?? null) === null && myInv.json?.sandbox === false,
    `set=${setMy.status} status=${myInv.json?.status} ref=${myInv.json?.ref} qr=${myInv.json?.qr} provider=${myInv.json?.provider}`);

  // TC-C2-08: SG e-invoice — Peppol BIS3 document prepared, honestly `pending` until a live Peppol AP is wired.
  const setSg = await inj('PUT', '/api/einvoice/config', admin, { provider: 'einvoice.sg.invoicenow' });
  const sgInv = await inj('POST', '/api/einvoice/submit', admin, { doc: { doc_ref: 'SG-INV-C2-001', seller: 'Oshinei SG Pte Ltd', buyer: 'Test Buyer SG', total: 109, currency: 'SGD' } });
  ok('C2: SG e-invoice (Peppol BIS3) prepared → status=pending (no live transport), ref EINV-, no fake QR',
    setSg.status === 200 && sgInv.json?.status === 'pending' && String(sgInv.json?.ref ?? '').startsWith('EINV-') && (sgInv.json?.qr ?? null) === null,
    `set=${setSg.status} status=${sgInv.json?.status} ref=${sgInv.json?.ref} qr=${sgInv.json?.qr} provider=${sgInv.json?.provider}`);

  // TC-C2-08b: the sandbox 'stub' provider still acknowledges locally — but is explicitly flagged sandbox
  // so it can never be mistaken for a real filing.
  const setStub = await inj('PUT', '/api/einvoice/config', admin, { provider: 'stub' });
  const stubInv = await inj('POST', '/api/einvoice/submit', admin, { doc: { doc_ref: 'STUB-INV-C2-001', seller: 'Oshinei', buyer: 'Test Buyer', total: 100 } });
  ok('C2: sandbox stub → status=accepted but sandbox=true (clearly not a real filing)',
    setStub.status === 200 && stubInv.json?.status === 'accepted' && stubInv.json?.sandbox === true,
    `set=${setStub.status} status=${stubInv.json?.status} sandbox=${stubInv.json?.sandbox}`);

  // ───────────────────── AR cash application (REV-21) — multi-invoice / on-account / CN-as-credit ─────────────────────
  // Dedicated customer so the AR movements are isolated from the earlier collections/statement fixtures.
  const [capT] = await db.insert(s.tenants).values({ code: 'CAPP', name: 'Cash App Customer' }).returning({ id: s.tenants.id });
  const capTid = Number(capT.id);
  const [capT2] = await db.insert(s.tenants).values({ code: 'CAPP2', name: 'Other Cash App Customer' }).returning({ id: s.tenants.id });
  const capTid2 = Number(capT2.id);
  await db.insert(s.arInvoices).values([
    { invoiceNo: 'INV-CA1', invoiceDate: daysAgo(45), dueDate: daysAgo(40), tenantId: capTid, amount: '600', paidAmount: '0', status: 'Unpaid', createdBy: 'seed' },
    { invoiceNo: 'INV-CA2', invoiceDate: daysAgo(15), dueDate: daysAgo(10), tenantId: capTid, amount: '500', paidAmount: '0', status: 'Unpaid', createdBy: 'seed' },
    { invoiceNo: 'INV-CA3', invoiceDate: daysAgo(8), dueDate: daysAgo(5), tenantId: capTid, amount: '150000', paidAmount: '0', status: 'Unpaid', createdBy: 'seed' },
    { invoiceNo: 'INV-CAX', invoiceDate: daysAgo(8), dueDate: daysAgo(5), tenantId: capTid2, amount: '300', paidAmount: '0', status: 'Unpaid', createdBy: 'seed' },
  ]);

  // Auto-suggest: an EXACT single-invoice match beats FIFO (500 hits INV-CA2 though INV-CA1 is older).
  const sgExact = (await inj('GET', `/api/finance/ar/cash-application/suggest?customer_no=CAPP&amount=500`, admin)).json;
  ok('REV-21: suggest — exact single-invoice match wins (500 → INV-CA2)', sgExact.exact_match === true && sgExact.lines?.length === 1 && sgExact.lines?.[0]?.invoice_no === 'INV-CA2' && near(sgExact.lines?.[0]?.apply, 500), JSON.stringify(sgExact.lines));
  const sgFifo = (await inj('GET', `/api/finance/ar/cash-application/suggest?customer_no=CAPP&amount=900`, admin)).json;
  ok('REV-21: suggest — no exact match ⇒ oldest-due-first (600 on CA1, 300 partial on CA2)', sgFifo.exact_match === false && sgFifo.lines?.[0]?.invoice_no === 'INV-CA1' && near(sgFifo.lines?.[0]?.apply, 600) && sgFifo.lines?.[1]?.invoice_no === 'INV-CA2' && near(sgFifo.lines?.[1]?.apply, 300), JSON.stringify(sgFifo.lines));

  // Multi-invoice happy path with an on-account remainder: 1000 = 600 (CA1) + 300 (CA2) + 100 on-account.
  const ca1000Before = await tbBalance('1000'), ca1100Before = await tbBalance('1100'), ca2220Before = await tbBalance('2220');
  const capPost = await inj('POST', '/api/finance/ar/cash-application', admin, { customer_no: 'CAPP', amount: 1000, ref_no: 'BANK-XFER-1', lines: [{ invoice_no: 'INV-CA1', amount: 600 }, { invoice_no: 'INV-CA2', amount: 300 }] });
  ok('REV-21: one receipt across two invoices; remainder parks on-account (applied 900 / on-account 100)',
    capPost.status === 201 && capPost.json?.status === 'Applied' && /^APL-/.test(capPost.json?.batch_no ?? '') && /^RCP-/.test(capPost.json?.receipt_no ?? '') && near(capPost.json?.applied_total, 900) && near(capPost.json?.on_account, 100), JSON.stringify(capPost.json).slice(0, 120));
  const capRcpNo = capPost.json?.receipt_no;
  const capInv1 = (await db.select().from(s.arInvoices).where(eq(s.arInvoices.invoiceNo, 'INV-CA1')))[0];
  const capInv2 = (await db.select().from(s.arInvoices).where(eq(s.arInvoices.invoiceNo, 'INV-CA2')))[0];
  ok('REV-21: sub-ledger moved per line (CA1 Paid 600, CA2 Partial 300)', capInv1?.status === 'Paid' && near(capInv1?.paidAmount, 600) && capInv2?.status === 'Partial' && near(capInv2?.paidAmount, 300), `ca1=${capInv1?.status}/${capInv1?.paidAmount} ca2=${capInv2?.status}/${capInv2?.paidAmount}`);
  ok('REV-21: GL — Dr 1000 +1000, Cr 1100 −900, Cr 2220 −100 (on-account liability); receipt carries unapplied 100',
    near(await tbBalance('1000'), ca1000Before + 1000) && near(await tbBalance('1100'), ca1100Before - 900) && near(await tbBalance('2220'), ca2220Before - 100)
    && near((await db.select().from(s.arReceipts).where(eq(s.arReceipts.receiptNo, capRcpNo)))[0]?.unappliedAmount, 100),
    `1000=${await tbBalance('1000')} 1100=${await tbBalance('1100')} 2220=${await tbBalance('2220')}`);
  const capAging = (await inj('GET', '/api/finance/ar/aging', admin)).json;
  ok('REV-21: aging reflects applications + surfaces the on-account credit (CA1 gone; on_account ≥ 100; net_total = total − on_account)',
    !(capAging.rows ?? []).some((r: any) => r.ref === 'INV-CA1') && Number(capAging.on_account) >= 100 && near(capAging.net_total, capAging.total - capAging.on_account), `oa=${capAging.on_account} total=${capAging.total} net=${capAging.net_total}`);

  // Fail-closed guards: over-apply an invoice / exceed the receipt / another customer's invoice.
  const capOver = await inj('POST', '/api/finance/ar/cash-application', admin, { customer_no: 'CAPP', amount: 300, lines: [{ invoice_no: 'INV-CA2', amount: 300 }] });
  ok('REV-21: application beyond the invoice open balance → 400 OVER_APPLIED', capOver.status === 400 && capOver.json?.error?.code === 'OVER_APPLIED', `${capOver.status} ${capOver.json?.error?.code}`);
  const capExceed = await inj('POST', '/api/finance/ar/cash-application', admin, { customer_no: 'CAPP', amount: 100, lines: [{ invoice_no: 'INV-CA2', amount: 200 }] });
  ok('REV-21: Σ applications beyond the receipt → 400 APPLY_EXCEEDS_RECEIPT', capExceed.status === 400 && capExceed.json?.error?.code === 'APPLY_EXCEEDS_RECEIPT', `${capExceed.status} ${capExceed.json?.error?.code}`);
  const capXcust = await inj('POST', '/api/finance/ar/cash-application', admin, { customer_no: 'CAPP', amount: 300, lines: [{ invoice_no: 'INV-CAX', amount: 300 }] });
  ok('REV-21: another customer\'s invoice → 400 CUSTOMER_MISMATCH', capXcust.status === 400 && capXcust.json?.error?.code === 'CUSTOMER_MISMATCH', `${capXcust.status} ${capXcust.json?.error?.code}`);

  // Apply-later: the parked 100 on-account clears into INV-CA2 (Dr 2220 / Cr 1100).
  const capOI = (await inj('GET', '/api/finance/ar/open-items?customer_no=CAPP', admin)).json;
  ok('REV-21: open-items worksheet feed lists the open invoices + the unapplied receipt', (capOI.invoices ?? []).some((r: any) => r.invoice_no === 'INV-CA2' && near(r.available, 200)) && (capOI.unapplied_receipts ?? []).some((r: any) => r.receipt_no === capRcpNo && near(r.available, 100)) && near(capOI.totals?.on_account, 100), JSON.stringify(capOI.totals));
  const capApplyLater = await inj('POST', '/api/finance/ar/apply-on-account', admin, { receipt_ref: capRcpNo, lines: [{ invoice_no: 'INV-CA2', amount: 100 }] });
  ok('REV-21: apply-on-account later moves the parked cash onto the invoice (2220 → 1100)',
    capApplyLater.status === 200 && near(capApplyLater.json?.applied_total, 100) && near(await tbBalance('2220'), ca2220Before) && near(await tbBalance('1100'), ca1100Before - 1000)
    && near((await db.select().from(s.arReceipts).where(eq(s.arReceipts.receiptNo, capRcpNo)))[0]?.unappliedAmount, 0),
    `2220=${await tbBalance('2220')} 1100=${await tbBalance('1100')}`);
  const capInsuff = await inj('POST', '/api/finance/ar/apply-on-account', admin, { receipt_ref: capRcpNo, lines: [{ invoice_no: 'INV-CA2', amount: 50 }] });
  ok('REV-21: applying more than the remaining on-account cash → 400 INSUFFICIENT_UNAPPLIED', capInsuff.status === 400 && capInsuff.json?.error?.code === 'INSUFFICIENT_UNAPPLIED', `${capInsuff.status} ${capInsuff.json?.error?.code}`);

  // Threshold maker-checker (mirrors REV-16): a ≥ THB 100k application parks — cash banks fully on-account,
  // NO invoice moves — until a DIFFERENT user approves; self-approval is a SoD violation.
  const capBig = await inj('POST', '/api/finance/ar/cash-application', admin, { customer_no: 'CAPP', amount: 150000, lines: [{ invoice_no: 'INV-CA3', amount: 150000 }] });
  const capInv3Parked = (await db.select().from(s.arInvoices).where(eq(s.arInvoices.invoiceNo, 'INV-CA3')))[0];
  ok('REV-21: a ≥100k application parks PendingApproval — invoice untouched, cash fully on-account (Cr 2220)',
    capBig.json?.pending === true && capBig.json?.status === 'PendingApproval' && near(capBig.json?.applied_total, 0) && near(capBig.json?.on_account, 150000)
    && near(capInv3Parked?.paidAmount, 0) && near(await tbBalance('2220'), ca2220Before - 150000), JSON.stringify(capBig.json).slice(0, 120));
  const capGov = (await inj('GET', '/api/finance/approvals/pending', admin)).json;
  ok('REV-21: the parked batch surfaces in the GOV-01 pending-approvals monitor', (capGov.items ?? []).some((i: any) => i.type === 'ar_cash_application' && i.control === 'REV-21' && i.ref === capBig.json?.batch_no && near(i.amount, 150000)), `types=${JSON.stringify(capGov.by_type ?? {})}`);
  const capSelf = await inj('POST', `/api/finance/ar/cash-application/${capBig.json?.batch_no}/approve`, admin);
  ok('REV-21: poster self-approval blocked → 403 SOD_VIOLATION', capSelf.status === 403 && capSelf.json?.error?.code === 'SOD_VIOLATION', `${capSelf.status} ${capSelf.json?.error?.code}`);
  const capAppr = await inj('POST', `/api/finance/ar/cash-application/${capBig.json?.batch_no}/approve`, mgr);
  const capInv3 = (await db.select().from(s.arInvoices).where(eq(s.arInvoices.invoiceNo, 'INV-CA3')))[0];
  ok('REV-21: a different user approves → invoice settles + GL relief posts (Dr 2220 / Cr 1100 150000)',
    capAppr.status === 200 && near(capAppr.json?.applied_total, 150000) && capInv3?.status === 'Paid' && near(await tbBalance('2220'), ca2220Before) && near(await tbBalance('1100'), ca1100Before - 151000), `st=${capAppr.status} inv3=${capInv3?.status} 2220=${await tbBalance('2220')}`);

  // Audited reversal: reason REQUIRED; the invoice reopens and the cash returns on-account.
  const capApl1 = `${capPost.json?.batch_no}-L1`; // the 600 applied to INV-CA1
  const capRevNoReason = await inj('POST', `/api/finance/ar/cash-application/${capApl1}/reverse`, admin, { reason: '   ' });
  ok('REV-21: reversal without a reason rejected → 400 REASON_REQUIRED', capRevNoReason.status === 400 && capRevNoReason.json?.error?.code === 'REASON_REQUIRED', `${capRevNoReason.status} ${capRevNoReason.json?.error?.code}`);
  const capRev = await inj('POST', `/api/finance/ar/cash-application/${capApl1}/reverse`, admin, { reason: 'ลูกค้าโต้แย้งยอด — ตัดผิดใบ' });
  const capInv1After = (await db.select().from(s.arInvoices).where(eq(s.arInvoices.invoiceNo, 'INV-CA1')))[0];
  ok('REV-21: reversal reopens the invoice + returns the cash on-account (Dr 1100 / Cr 2220), audited with reason',
    capRev.status === 200 && capRev.json?.reversed === true && capInv1After?.status === 'Unpaid' && near(capInv1After?.paidAmount, 0)
    && near(await tbBalance('2220'), ca2220Before - 600) && near((await db.select().from(s.arReceipts).where(eq(s.arReceipts.receiptNo, capRcpNo)))[0]?.unappliedAmount, 600),
    `inv1=${capInv1After?.status} 2220=${await tbBalance('2220')}`);
  const capAppReg = (await inj('GET', `/api/finance/ar/cash-application?receipt_no=${capRcpNo}`, admin)).json;
  ok('REV-21: the application register carries the audited reversal (reversed flag + reason + who)', (capAppReg.applications ?? []).some((a: any) => a.application_no === capApl1 && a.reversed === true && a.reversed_by === 'admin' && (a.reverse_reason ?? '').includes('โต้แย้ง')), `n=${capAppReg.count}`);
  const capRevAgain = await inj('POST', `/api/finance/ar/cash-application/${capApl1}/reverse`, admin, { reason: 'ซ้ำ' });
  ok('REV-21: a reversed application cannot be reversed again → 400 ALREADY_REVERSED', capRevAgain.status === 400 && capRevAgain.json?.error?.code === 'ALREADY_REVERSED', `${capRevAgain.status} ${capRevAgain.json?.error?.code}`);

  // Credit-note-as-credit-line: an Issued AR-linked ใบลดหนี้ reduces the customer's open balance via the
  // same worksheet (sub-ledger only — the note's own GL posted at its TAX-07 approval). Seed the note
  // directly (the TAX-07 issuance/approval flow is exercised by the taxdocs harness).
  await db.insert(s.taxInvoices).values({
    tenantId: hq, docNo: 'CN-CAPP-1', type: 'credit_note', issueDate: daysAgo(2), sourceType: 'AR', sourceRef: 'INV-CA2',
    sellerName: 'HQ Co', sellerTaxId: '0105500000001', sellerAddress: '1 Test Rd', subtotal: '46.73', vatAmount: '3.27', grandTotal: '50',
    status: 'Issued', originalDocNo: 'TIV-X-1', reason: 'ส่วนลดภายหลัง', createdBy: 'seed',
  });
  const capOI2 = (await inj('GET', '/api/finance/ar/open-items?customer_no=CAPP', admin)).json;
  ok('REV-21: open-items surfaces the applicable AR-linked credit note (remaining 50)', (capOI2.credit_notes ?? []).some((c: any) => c.doc_no === 'CN-CAPP-1' && near(c.remaining, 50)), JSON.stringify(capOI2.credit_notes));
  const cn1100Before = await tbBalance('1100');
  const capCn = await inj('POST', '/api/finance/ar/cash-application', admin, { customer_no: 'CAPP', credit_notes: [{ doc_no: 'CN-CAPP-1', invoice_no: 'INV-CA2', amount: 50 }] });
  const capInv2Cn = (await db.select().from(s.arInvoices).where(eq(s.arInvoices.invoiceNo, 'INV-CA2')))[0];
  ok('REV-21: credit note applies as a credit line — invoice open balance falls 50, NO new GL (the note posted its own at approval)',
    capCn.status === 201 && near(capCn.json?.credit_applied, 50) && near(capInv2Cn?.paidAmount, 450) && near(await tbBalance('1100'), cn1100Before), JSON.stringify(capCn.json).slice(0, 120));
  const capCnOver = await inj('POST', '/api/finance/ar/cash-application', admin, { customer_no: 'CAPP', credit_notes: [{ doc_no: 'CN-CAPP-1', invoice_no: 'INV-CA2', amount: 10 }] });
  ok('REV-21: exhausted credit note → 400 CN_OVER_APPLIED', capCnOver.status === 400 && capCnOver.json?.error?.code === 'CN_OVER_APPLIED', `${capCnOver.status} ${capCnOver.json?.error?.code}`);
  const capStmt = (await inj('GET', `/api/finance/ar/statement?tenant_id=${capTid}`, admin)).json;
  ok('REV-21: customer statement carries the applied credit note as a credit line (type credit_note, 50)', (capStmt.lines ?? []).some((l: any) => l.type === 'credit_note' && near(l.payment, 50) && l.ref === 'CN-CAPP-1'), `n=${capStmt.lines?.length}`);
  const capWl = (await inj('GET', '/api/finance/ar/collections', admin)).json;
  ok('REV-21: collections worklist surfaces the customer\'s on-account cash (apply before dunning)', (capWl.rows ?? []).some((r: any) => r.invoice_no === 'INV-CA1' && near(r.on_account, 600)) && Number(capWl.on_account_total) >= 600, `oa_total=${capWl.on_account_total}`);

  // ───────────────────── AR/AP netting & contra settlement (REV-23, docs/41 FIN-8) ─────────────────────
  // A counterparty that is BOTH a customer (AR) and a vendor (AP): a netting agreement authorises offsetting
  // its open AR against its open AP; a maker-checker contra settlement posts a single Dr 2000 / Cr 1100 JE
  // that clears both sub-ledgers up to the netted amount, leaving the residual open.
  const [netCust] = await db.insert(s.tenants).values({ code: 'NETCO', name: 'Netting Counterparty' }).returning({ id: s.tenants.id });
  const netCid = Number(netCust.id);
  const [netVend] = await db.insert(s.vendors).values({ name: 'NETCO Vendor', tenantId: hq, isCreditor: true }).returning({ id: s.vendors.id });
  await db.insert(s.arInvoices).values([
    { invoiceNo: 'INV-NET1', invoiceDate: daysAgo(40), dueDate: daysAgo(35), tenantId: netCid, amount: '800', paidAmount: '0', status: 'Unpaid', createdBy: 'seed' },
    { invoiceNo: 'INV-NET2', invoiceDate: daysAgo(20), dueDate: daysAgo(15), tenantId: netCid, amount: '500', paidAmount: '0', status: 'Unpaid', createdBy: 'seed' },
  ]);
  await db.insert(s.apTransactions).values([
    { txnNo: 'AP-NET1', invoiceNo: 'BILL-NET1', invoiceDate: daysAgo(38), dueDate: daysAgo(30), tenantId: hq, vendorName: 'NETCO Vendor', amount: '300', paidAmount: '0', status: 'Unpaid', createdBy: 'seed' },
    { txnNo: 'AP-NET2', invoiceNo: 'BILL-NET2', invoiceDate: daysAgo(18), dueDate: daysAgo(10), tenantId: hq, vendorName: 'NETCO Vendor', amount: '600', paidAmount: '0', status: 'Unpaid', createdBy: 'seed' },
  ]);
  // Agreement management (maker) + preview.
  const netAgr = await inj('POST', '/api/finance/netting/agreements', admin, { customer_no: 'NETCO', vendor: 'NETCO Vendor', notes: 'ข้อตกลงหักกลบ' });
  ok('FIN-8/REV-23: create a counterparty netting agreement', netAgr.status === 200 && typeof netAgr.json?.agreement_id === 'number' && netAgr.json?.enabled === true, JSON.stringify(netAgr.json));
  const netPrev = (await inj('GET', '/api/finance/netting/preview?customer_no=NETCO&vendor=NETCO%20Vendor', admin)).json;
  ok('FIN-8/REV-23: preview shows open AR 1300 vs open AP 900 → proposed net 900, residual AR 400 / AP 0',
    near(netPrev.ar?.open_total, 1300) && near(netPrev.ap?.open_total, 900) && near(netPrev.proposed_net, 900) && near(netPrev.residual_ar, 400) && near(netPrev.residual_ap, 0), JSON.stringify({ ar: netPrev.ar?.open_total, ap: netPrev.ap?.open_total, net: netPrev.proposed_net }));

  // Reason is mandatory (mirrors the REV-21 reversal / bad-debt write-off maker-checker).
  const netNoReason = await inj('POST', '/api/finance/netting/settlements', admin, { customer_no: 'NETCO', vendor: 'NETCO Vendor', reason: '   ' });
  ok('FIN-8/REV-23: propose without a reason → 400 REASON_REQUIRED', netNoReason.status === 400 && netNoReason.json?.error?.code === 'REASON_REQUIRED', `${netNoReason.status} ${netNoReason.json?.error?.code}`);

  // Propose the contra settlement (maker) — parks PendingApproval; NO GL / sub-ledger movement yet.
  const net2000Before = await tbBalance('2000'), net1100Before = await tbBalance('1100');
  const netProp = await inj('POST', '/api/finance/netting/settlements', admin, { customer_no: 'NETCO', vendor: 'NETCO Vendor', reason: 'หักกลบลูกหนี้กับเจ้าหนี้รายเดียวกัน' });
  const netInv1Parked = (await db.select().from(s.arInvoices).where(eq(s.arInvoices.invoiceNo, 'INV-NET1')))[0];
  ok('FIN-8/REV-23: propose parks PendingApproval (net 900) — no GL, no sub-ledger movement yet',
    netProp.status === 201 && netProp.json?.pending === true && near(netProp.json?.net_amount, 900) && /^NET-/.test(netProp.json?.settlement_no ?? '')
    && near(netInv1Parked?.paidAmount, 0) && near(await tbBalance('2000'), net2000Before) && near(await tbBalance('1100'), net1100Before), JSON.stringify(netProp.json).slice(0, 140));
  const netNo = netProp.json?.settlement_no;
  const netGov = (await inj('GET', '/api/finance/approvals/pending', admin)).json;
  ok('FIN-8/REV-23: the pending settlement surfaces in the GOV-01 monitor (type ar_ap_netting)', (netGov.items ?? []).some((i: any) => i.type === 'ar_ap_netting' && i.control === 'REV-23' && i.ref === netNo && near(i.amount, 900)), `types=${JSON.stringify(netGov.by_type ?? {})}`);
  const netSelf = await inj('POST', `/api/finance/netting/settlements/${netNo}/approve`, admin);
  ok('FIN-8/REV-23: proposer self-approval blocked → 403 SOD_VIOLATION (binds even Admin)', netSelf.status === 403 && netSelf.json?.error?.code === 'SOD_VIOLATION', `${netSelf.status} ${netSelf.json?.error?.code}`);

  // A DIFFERENT user approves → contra JE (Dr 2000 / Cr 1100 900) + both sub-ledgers clear; residual open.
  const netAppr = await inj('POST', `/api/finance/netting/settlements/${netNo}/approve`, mgr);
  const netInv1 = (await db.select().from(s.arInvoices).where(eq(s.arInvoices.invoiceNo, 'INV-NET1')))[0];
  const netInv2 = (await db.select().from(s.arInvoices).where(eq(s.arInvoices.invoiceNo, 'INV-NET2')))[0];
  const netAp1 = (await db.select().from(s.apTransactions).where(eq(s.apTransactions.txnNo, 'AP-NET1')))[0];
  const netAp2 = (await db.select().from(s.apTransactions).where(eq(s.apTransactions.txnNo, 'AP-NET2')))[0];
  ok('FIN-8/REV-23: a different user approves → contra JE posts Dr 2000 +900 / Cr 1100 −900',
    netAppr.status === 200 && near(netAppr.json?.net_amount, 900) && /^JE-/.test(netAppr.json?.je_entry_no ?? '')
    && near(await tbBalance('2000'), net2000Before + 900) && near(await tbBalance('1100'), net1100Before - 900), `st=${netAppr.status} je=${netAppr.json?.je_entry_no} 2000=${await tbBalance('2000')}`);
  ok('FIN-8/REV-23: netting clears BOTH sub-ledgers up to the net — AP fully paid, AR residual stays open (INV-NET2 open 400)',
    netAp1?.status === 'Paid' && netAp2?.status === 'Paid' && netInv1?.status === 'Paid' && netInv2?.status === 'Partial' && near(netInv2?.paidAmount, 100), `ap1=${netAp1?.status} ap2=${netAp2?.status} inv1=${netInv1?.status} inv2=${netInv2?.status}/${netInv2?.paidAmount}`);
  const netStmt = (await inj('GET', `/api/finance/netting/settlements/${netNo}`, admin)).json;
  ok('FIN-8/REV-23: the netting statement records exactly what was offset (AR 800+100, AP 300+600 = 900)',
    netStmt.status === 'Approved' && near(netStmt.net_amount, 900) && (netStmt.ar_lines ?? []).reduce((a: number, l: any) => a + l.applied, 0) === 900 && (netStmt.ap_lines ?? []).reduce((a: number, l: any) => a + l.applied, 0) === 900 && (netStmt.ar_lines ?? []).some((l: any) => l.invoice_no === 'INV-NET1' && near(l.applied, 800)), JSON.stringify({ ar: netStmt.ar_lines, ap: netStmt.ap_lines }).slice(0, 160));

  // Control negatives: no agreement / disabled agreement / over the per-counterparty threshold / nothing to net.
  const [netNaC] = await db.insert(s.tenants).values({ code: 'NETNA', name: 'No-Agreement Counterparty' }).returning({ id: s.tenants.id });
  await db.insert(s.vendors).values({ name: 'NETNA Vendor', tenantId: hq, isCreditor: true });
  await db.insert(s.arInvoices).values([{ invoiceNo: 'INV-NETNA', invoiceDate: daysAgo(10), dueDate: daysAgo(5), tenantId: Number(netNaC.id), amount: '500', paidAmount: '0', status: 'Unpaid', createdBy: 'seed' }]);
  await db.insert(s.apTransactions).values([{ txnNo: 'AP-NETNA', invoiceNo: 'BILL-NETNA', invoiceDate: daysAgo(10), dueDate: daysAgo(5), tenantId: hq, vendorName: 'NETNA Vendor', amount: '400', paidAmount: '0', status: 'Unpaid', createdBy: 'seed' }]);
  const netNoAgr = await inj('POST', '/api/finance/netting/settlements', admin, { customer_no: 'NETNA', vendor: 'NETNA Vendor', reason: 'x' });
  ok('FIN-8/REV-23: propose without a netting agreement → 400 NETTING_NOT_AGREED', netNoAgr.status === 400 && netNoAgr.json?.error?.code === 'NETTING_NOT_AGREED', `${netNoAgr.status} ${netNoAgr.json?.error?.code}`);
  await inj('POST', '/api/finance/netting/agreements', admin, { customer_no: 'NETNA', vendor: 'NETNA Vendor', enabled: false });
  const netDis = await inj('POST', '/api/finance/netting/settlements', admin, { customer_no: 'NETNA', vendor: 'NETNA Vendor', reason: 'x' });
  ok('FIN-8/REV-23: propose against a disabled agreement → 400 NETTING_DISABLED', netDis.status === 400 && netDis.json?.error?.code === 'NETTING_DISABLED', `${netDis.status} ${netDis.json?.error?.code}`);
  await inj('POST', '/api/finance/netting/agreements', admin, { customer_no: 'NETNA', vendor: 'NETNA Vendor', enabled: true, threshold: 100 });
  const netOverThr = await inj('POST', '/api/finance/netting/settlements', admin, { customer_no: 'NETNA', vendor: 'NETNA Vendor', reason: 'x' });
  ok('FIN-8/REV-23: net above the per-counterparty threshold → 400 NETTING_EXCEEDS_THRESHOLD', netOverThr.status === 400 && netOverThr.json?.error?.code === 'NETTING_EXCEEDS_THRESHOLD', `${netOverThr.status} ${netOverThr.json?.error?.code}`);
  const [netOneC] = await db.insert(s.tenants).values({ code: 'NETONE', name: 'AR-only Counterparty' }).returning({ id: s.tenants.id });
  await db.insert(s.vendors).values({ name: 'NETONE Vendor', tenantId: hq, isCreditor: true });
  await db.insert(s.arInvoices).values([{ invoiceNo: 'INV-NETONE', invoiceDate: daysAgo(10), dueDate: daysAgo(5), tenantId: Number(netOneC.id), amount: '200', paidAmount: '0', status: 'Unpaid', createdBy: 'seed' }]);
  await inj('POST', '/api/finance/netting/agreements', admin, { customer_no: 'NETONE', vendor: 'NETONE Vendor' });
  const netNothing = await inj('POST', '/api/finance/netting/settlements', admin, { customer_no: 'NETONE', vendor: 'NETONE Vendor', reason: 'x' });
  ok('FIN-8/REV-23: no open AP to offset → 400 NOTHING_TO_NET', netNothing.status === 400 && netNothing.json?.error?.code === 'NOTHING_TO_NET', `${netNothing.status} ${netNothing.json?.error?.code}`);

  // ───────────────────── FIN-4 — Statutory FS pack (report builder + SOCE + notes + DBD e-Filing) ─────────────────────
  // The configurable financial-report builder (row-grouping + comparative columns) and the three audit-pack
  // outputs it rides on. Read-only presentation over the audited GL — every rendered subtotal ties back to
  // the canonical income-statement / balance-sheet, and the SOCE roll-forward ties to the balance sheet.
  const fsFrom = '2000-01-01';
  const fsTo = today;
  const rowVal = (rows: any[], key: string) => rows.find((r: any) => r.key === key)?.current;

  // (1) Define a CUSTOM P&L row-grouping: Revenue, Expenses, and a COMPUTED Net-profit subtotal (Rev − Exp).
  const plDefRes = await inj('POST', '/api/reports/fs/definitions', admin, {
    code: 'PL-CUSTOM', name: 'Custom P&L', statement_type: 'pl',
    config: { groups: [
      { key: 'rev', label: 'Revenue', labelTh: 'รายได้', normalSide: 'credit', types: ['Revenue'] },
      { key: 'exp', label: 'Expenses', labelTh: 'ค่าใช้จ่าย', normalSide: 'debit', types: ['Expense'] },
      { key: 'np', label: 'Net profit', labelTh: 'กำไรสุทธิ', sumOf: [{ key: 'rev', factor: 1 }, { key: 'exp', factor: -1 }] },
    ] },
  });
  ok('FIN-4: create a custom P&L report definition (config-driven row-grouping builder)', plDefRes.status === 201 && plDefRes.json?.code === 'PL-CUSTOM', `st=${plDefRes.status}`);

  const isWin = (await inj('GET', `/api/ledger/income-statement?from=${fsFrom}&to=${fsTo}`, admin)).json;
  const plRender = (await inj('GET', `/api/reports/fs/render/PL-CUSTOM?as_of=${fsTo}&from=${fsFrom}`, admin)).json;
  ok('FIN-4: rendered Revenue group ties to income-statement revenue', near(rowVal(plRender.rows, 'rev'), isWin.revenue), `r=${rowVal(plRender.rows, 'rev')} is=${isWin.revenue}`);
  ok('FIN-4: rendered Expenses group ties to income-statement expense', near(rowVal(plRender.rows, 'exp'), isWin.expense), `e=${rowVal(plRender.rows, 'exp')} is=${isWin.expense}`);
  ok('FIN-4: computed Net-profit subtotal (Rev − Exp) = income-statement net income',
    near(rowVal(plRender.rows, 'np'), isWin.net_income) && plRender.rows.find((r: any) => r.key === 'np')?.is_subtotal === true,
    `np=${rowVal(plRender.rows, 'np')} ni=${isWin.net_income}`);

  // Comparative (prior-period / YoY) column — same builder, add the prior window.
  const plCmp = (await inj('GET', `/api/reports/fs/render/PL-CUSTOM?as_of=${fsTo}&from=${fsFrom}&prior_as_of=${fsTo}&prior_from=${fsFrom}`, admin)).json;
  ok('FIN-4: comparative column present + prior Net-profit populated', plCmp.comparative === true && typeof plCmp.rows.find((r: any) => r.key === 'np')?.prior === 'number', `cmp=${plCmp.comparative}`);

  // (2) Custom BS builder — Assets / Liabilities / Equity groups tie to the balance sheet.
  const bsWin = (await inj('GET', `/api/ledger/balance-sheet?as_of=${fsTo}`, admin)).json;
  await inj('POST', '/api/reports/fs/definitions', admin, {
    code: 'BS-CUSTOM', name: 'Custom BS', statement_type: 'bs',
    config: { groups: [
      { key: 'as', label: 'Assets', normalSide: 'debit', types: ['Asset'] },
      { key: 'li', label: 'Liabilities', normalSide: 'credit', types: ['Liability'] },
      { key: 'eq', label: 'Equity', normalSide: 'credit', types: ['Equity'] },
    ] },
  });
  const bsRender = (await inj('GET', `/api/reports/fs/render/BS-CUSTOM?as_of=${fsTo}`, admin)).json;
  ok('FIN-4: rendered Assets group ties to balance-sheet assets', near(rowVal(bsRender.rows, 'as'), bsWin.assets), `as=${rowVal(bsRender.rows, 'as')} bs=${bsWin.assets}`);
  ok('FIN-4: rendered Equity group ties to balance-sheet equity', near(rowVal(bsRender.rows, 'eq'), bsWin.equity), `eq=${rowVal(bsRender.rows, 'eq')} bs=${bsWin.equity}`);

  // 0438 — statement-section binding: the BS/IS group by section, and the section subtotals reconcile to the
  // type totals (current+non-current assets = assets; the summary net_income = revenue − expense).
  const bsSecTotal = (g: string) => (bsWin.sections ?? []).filter((s: any) => s.group === g).reduce((a: number, s: any) => a + s.total, 0);
  ok('FIN-4/0438: balance-sheet returns section groups (current + non-current asset sum ties to assets)',
    Array.isArray(bsWin.sections) && near(bsSecTotal('current_asset') + bsSecTotal('noncurrent_asset'), bsWin.assets),
    JSON.stringify({ sections: (bsWin.sections ?? []).map((s: any) => [s.group, s.total]) }));
  ok('FIN-4/0438: income-statement returns a structured section summary that reconciles to net income',
    !!isWin.summary && Array.isArray(isWin.groups) && near(isWin.summary.net_income, isWin.net_income)
      && near(isWin.summary.revenue - isWin.summary.cogs, isWin.summary.gross_profit),
    JSON.stringify(isWin.summary));

  // (2b) P2 — built-in Thai DBD/TFRS default layouts render out of the box (no tenant definition authored)
  // and tie to the canonical statements. DBD-PL is a multi-step P&L (gross → operating → PBT → net); DBD-BS
  // groups by งบดุล section and folds the unclosed result into equity so total assets = total liab+equity.
  const dbdPl = (await inj('GET', `/api/reports/fs/render/DBD-PL?as_of=${fsTo}&from=${fsFrom}`, admin)).json;
  ok('P2/DBD: default งบกำไรขาดทุน renders without a tenant definition (gross profit ties)',
    near(rowVal(dbdPl.rows, 'gross_profit'), isWin.summary.gross_profit), `gp=${rowVal(dbdPl.rows, 'gross_profit')} is=${isWin.summary.gross_profit}`);
  ok('P2/DBD: default P&L net profit = income-statement net income',
    near(rowVal(dbdPl.rows, 'net_profit'), isWin.net_income), `np=${rowVal(dbdPl.rows, 'net_profit')} ni=${isWin.net_income}`);
  const dbdBs = (await inj('GET', `/api/reports/fs/render/DBD-BS?as_of=${fsTo}`, admin)).json;
  ok('P2/DBD: default งบแสดงฐานะการเงิน total assets ties to the balance sheet',
    near(rowVal(dbdBs.rows, 'total_assets'), bsWin.assets), `ta=${rowVal(dbdBs.rows, 'total_assets')} bs=${bsWin.assets}`);
  ok('P2/DBD: default balance sheet balances (total assets = total liabilities + equity)',
    near(rowVal(dbdBs.rows, 'total_assets'), rowVal(dbdBs.rows, 'total_liab_equity')),
    `ta=${rowVal(dbdBs.rows, 'total_assets')} tle=${rowVal(dbdBs.rows, 'total_liab_equity')}`);
  const dbdList = (await inj('GET', '/api/reports/fs/definitions', admin)).json;
  ok('P2/DBD: the built-in DBD-BS / DBD-PL defaults are discoverable in the definition list',
    (dbdList.definitions ?? []).some((d: any) => d.code === 'DBD-BS' && d.is_default) && (dbdList.definitions ?? []).some((d: any) => d.code === 'DBD-PL' && d.is_default),
    JSON.stringify((dbdList.definitions ?? []).map((d: any) => d.code)));

  // (3) SOCE roll-forward — baseline, then a share issue + a dividend (both maker-checker approved), re-read.
  const socePart = (soce: any, code: string) => soce.components.find((c: any) => c.account_code === code) ?? { opening: 0, movements: 0, profit: 0, closing: 0 };
  const soce0 = (await inj('GET', `/api/reports/fs/changes-in-equity?from=${fsFrom}&to=${fsTo}`, admin)).json;
  const shRes = await inj('POST', '/api/ledger/journal', admin, { source: 'Manual', memo: 'FIN-4 share issue', lines: [{ account_code: '1010', debit: 100000 }, { account_code: '3000', credit: 100000 }] });
  await inj('POST', `/api/ledger/journal/${shRes.json?.entry_no}/approve`, mgr);
  const dvRes = await inj('POST', '/api/ledger/journal', admin, { source: 'Manual', memo: 'FIN-4 dividend', lines: [{ account_code: '3100', debit: 40000 }, { account_code: '1010', credit: 40000 }] });
  await inj('POST', `/api/ledger/journal/${dvRes.json?.entry_no}/approve`, mgr);
  const soce1 = (await inj('GET', `/api/reports/fs/changes-in-equity?from=${fsFrom}&to=${fsTo}`, admin)).json;
  ok('FIN-4: SOCE — share issue lifts the 3000 equity component movement by 100000', near(socePart(soce1, '3000').movements - socePart(soce0, '3000').movements, 100000), `Δ=${socePart(soce1, '3000').movements - socePart(soce0, '3000').movements}`);
  ok('FIN-4: SOCE — dividend cuts the retained-earnings (3100) component movement by 40000', near(socePart(soce1, '3100').movements - socePart(soce0, '3100').movements, -40000), `Δ=${socePart(soce1, '3100').movements - socePart(soce0, '3100').movements}`);
  ok('FIN-4: SOCE — every component rolls forward (opening + movements + profit = closing)', soce1.components.every((c: any) => near(c.opening + c.movements + c.profit, c.closing)), 'roll-forward');
  ok('FIN-4: SOCE — profit for the period flows entirely to retained earnings (3100) and reconciles the roll-forward',
    near(soce1.totals.profit, soce1.profit_for_period) && near(socePart(soce1, '3100').profit, soce1.profit_for_period) && Math.abs(soce1.profit_for_period) > 0,
    `p=${soce1.profit_for_period} totalsProfit=${soce1.totals.profit} re=${socePart(soce1, '3100').profit}`);
  ok('FIN-4: SOCE — total closing equity ties to the balance sheet (equity + net income)', soce1.ties_to_balance_sheet === true && near(soce1.totals.closing, soce1.balance_sheet_equity), `close=${soce1.totals.closing} bs=${soce1.balance_sheet_equity}`);

  // (4) Note schedules — per-note account mapping + comparative + policy text.
  await inj('POST', '/api/reports/fs/definitions', admin, {
    code: 'NOTES-STD', name: 'FS Notes', statement_type: 'notes',
    config: { notes: [
      { number: '1', title: 'Cash and cash equivalents', titleTh: 'เงินสดและรายการเทียบเท่า', normalSide: 'debit', prefixes: ['10'], policyText: 'Cash at bank and in hand.' },
      { number: '2', title: 'Equity', titleTh: 'ส่วนของผู้ถือหุ้น', normalSide: 'credit', types: ['Equity'] },
    ] },
  });
  const bsWin2 = (await inj('GET', `/api/ledger/balance-sheet?as_of=${fsTo}`, admin)).json; // live BS after the SOCE postings
  const notesRes = (await inj('GET', `/api/reports/fs/notes/NOTES-STD?as_of=${fsTo}&prior_as_of=${fsTo}&basis=bs`, admin)).json;
  const note2 = notesRes.notes?.find((nn: any) => nn.number === '2');
  ok('FIN-4: note schedule maps accounts + carries policy text + comparative total', notesRes.notes?.length === 2 && note2 && near(note2.total, bsWin2.equity) && typeof note2.prior_total === 'number' && notesRes.notes[0].policy_text != null, `eqNoteTotal=${note2?.total} bsEq=${bsWin2.equity}`);

  // (5) DBD e-Filing export (Thai งบการเงิน — XBRL / S-form): current + prior year, balanced, XBRL emitted.
  const fy = Number(today.slice(0, 4));
  const bsYE = (await inj('GET', `/api/ledger/balance-sheet?as_of=${fy}-12-31`, admin)).json;
  const dbd = (await inj('GET', `/api/reports/fs/dbd-export?fiscal_year=${fy}&taxpayer_name=HQ%20Co&taxpayer_id=0105500000001`, admin)).json;
  ok('FIN-4: DBD export — 6 S-form facts, balanced (A = L + E incl. net profit), XBRL instance emitted',
    dbd.format === 'DBD-XBRL' && Array.isArray(dbd.facts) && dbd.facts.length === 6 && dbd.balanced === true
    && typeof dbd.xml === 'string' && dbd.xml.includes('<xbrl') && dbd.xml.includes('dbd:TotalAssets') && dbd.xml.includes('dbd:NetProfit'),
    `bal=${dbd.balanced} facts=${dbd.facts?.length}`);
  const faAssets = dbd.facts?.find((f: any) => f.concept === 'TotalAssets');
  ok('FIN-4: DBD TotalAssets fact ties to the year-end balance sheet', near(faAssets?.current, bsYE.assets), `fa=${faAssets?.current} bs=${bsYE.assets}`);

  // (6) Negative / control cases.
  const rNotes = await inj('GET', `/api/reports/fs/render/NOTES-STD?as_of=${fsTo}`, admin);
  ok('FIN-4: render rejects a non-renderable (notes) definition → 400 FS_NOT_RENDERABLE', rNotes.status === 400 && rNotes.json?.error?.code === 'FS_NOT_RENDERABLE', `${rNotes.status} ${rNotes.json?.error?.code}`);
  const rNoAsOf = await inj('GET', '/api/reports/fs/render/PL-CUSTOM?from=2000-01-01', admin);
  ok('FIN-4: render without as_of → 400 FS_ASOF_REQUIRED', rNoAsOf.status === 400 && rNoAsOf.json?.error?.code === 'FS_ASOF_REQUIRED', `${rNoAsOf.status} ${rNoAsOf.json?.error?.code}`);
  const rMissing = await inj('GET', '/api/reports/fs/definitions/NOPE', admin);
  ok('FIN-4: unknown definition → 404 FS_DEF_NOT_FOUND', rMissing.status === 404 && rMissing.json?.error?.code === 'FS_DEF_NOT_FOUND', `${rMissing.status} ${rMissing.json?.error?.code}`);
  const rBadType = await inj('POST', '/api/reports/fs/definitions', admin, { code: 'X', name: 'X', statement_type: 'zzz', config: {} });
  ok('FIN-4: upsert with an invalid statement_type is rejected (validation)', rBadType.status === 400, `${rBadType.status}`);

  // ── docs/43 PR-2 — a GL-24-governed posting-rule override re-routes a wired finance posting ──
  // End-to-end on BADDEBT.WRITEOFF (REV-14 write-off): default path posts the registry literal (5720);
  // an approved tenant rule re-routes the expense leg to 5721; the write-off register still lists both
  // (it keys on the debit leg, not a hard-coded account).
  const jeLines = async (entryNo: string) => {
    const [je] = await db.select().from(s.journalEntries).where(eq(s.journalEntries.entryNo, entryNo)).limit(1);
    return db.select().from(s.journalLines).where(eq(s.journalLines.entryId, Number(je.id)));
  };
  // The write-off posts Cr 1100 directly (REV-14's own flow), so lift the GL-14 control flag the tie-out
  // section set above for the duration of this block (same re-apply precedent as the GL-14 section itself).
  await db.update(s.accounts).set({ isControl: false, controlSubledger: null }).where(eq(s.accounts.code, '1100'));
  const woDef = (await inj('POST', '/api/finance/ar/write-off', admin, { amount: 111.25, reason: 'PR-2 default path' })).json;
  const woDefLines = await jeLines(woDef.entry_no);
  ok('PR-2: write-off with NO posting rule debits the registry default 5720', woDefLines.some((l: any) => l.accountCode === '5720' && near(l.debit, 111.25)), `lines=${woDefLines.map((l: any) => l.accountCode).join(',')}`);
  await db.insert(s.accounts).values({ code: '5721', name: 'Bad Debt — Related Parties', type: 'Expense', normalBalance: 'D', isPostable: true }).onConflictDoNothing();
  const ruleUp = await inj('POST', '/api/ledger/posting-rules', admin, { eventType: 'BADDEBT.WRITEOFF', legOrder: 1, role: 'bad_debt_exp', side: 'DR', accountCode: '5721' });
  ok('PR-2: override upsert lands PendingApproval (GL-24)', ruleUp.status === 201 && ruleUp.json?.status === 'PendingApproval', `${ruleUp.status} ${ruleUp.json?.status}`);
  const woPend = (await inj('POST', '/api/finance/ar/write-off', admin, { amount: 50, reason: 'PR-2 unapproved rule must not apply' })).json;
  ok('PR-2: an UNAPPROVED rule never re-routes a posting', (await jeLines(woPend.entry_no)).some((l: any) => l.accountCode === '5720' && near(l.debit, 50)), 'still 5720');
  const ruleAp = await inj('POST', `/api/ledger/posting-rules/${Number(ruleUp.json?.id)}/approve`, mgr);
  ok('PR-2: a different user approves the rule', ruleAp.status === 200 && ruleAp.json?.status === 'Approved', `${ruleAp.status} ${ruleAp.json?.status}`);
  const woOvr = (await inj('POST', '/api/finance/ar/write-off', admin, { amount: 250, reason: 'PR-2 override path' })).json;
  const woOvrLines = await jeLines(woOvr.entry_no);
  ok('PR-2: the approved override re-routes the expense leg to 5721 (AR control 1100 stays pinned)',
    woOvrLines.some((l: any) => l.accountCode === '5721' && near(l.debit, 250)) && woOvrLines.some((l: any) => l.accountCode === '1100' && near(l.credit, 250)),
    `lines=${woOvrLines.map((l: any) => `${l.accountCode}`).join(',')}`);
  const woReg = (await inj('GET', '/api/finance/ar/write-offs', admin)).json;
  ok('PR-2: the write-off register lists BOTH the default- and override-account write-offs', woReg.write_offs?.some((w: any) => near(w.amount, 111.25)) && woReg.write_offs?.some((w: any) => near(w.amount, 250)), `count=${woReg.count}`);
  await db.update(s.accounts).set({ isControl: true, controlSubledger: 'AR' }).where(eq(s.accounts.code, '1100'));

  // ── docs/43 PR-3 — assets & leases: Q2 category-grain accounts + governed dispose override ──
  // (a) GL-21 fail-closed at category save: an unknown account is rejected, not saved.
  const badCat = await inj('POST', '/api/assets/categories', admin, { code: 'PR3-BAD', name: 'Bad accounts', default_useful_life_years: 5, asset_account: '1500', accum_dep_account: '1590', dep_expense_account: '9999' });
  ok('PR-3: asset-category save with an unknown dep account → 400 INVALID_POSTING_ACCOUNT', badCat.status === 400 && badCat.json?.error?.code === 'INVALID_POSTING_ACCOUNT', `${badCat.status} ${badCat.json?.error?.code}`);
  // (b) Q2 grain: a category maps its own dep-expense account; under posting_determination the
  // depreciation run debits it PER CATEGORY (one balanced JE, split line pairs), assets without a
  // category keep the posting-rule/registry default.
  await db.insert(s.accounts).values({ code: '5201', name: 'Depreciation — Vehicles (PR-3)', type: 'Expense', normalBalance: 'D', isPostable: true }).onConflictDoNothing();
  // acquire/dispose post Dr/Cr 1500 directly (the FA register's own flow) — lift the GL-14 control flag the
  // tie-out section set above for the duration of this block (same re-apply precedent as GL-14 itself).
  await db.update(s.accounts).set({ isControl: false, controlSubledger: null }).where(eq(s.accounts.code, '1500'));
  const vehCatRes = await inj('POST', '/api/assets/categories', admin, { code: 'PR3-VEH', name: 'Vehicles', default_useful_life_years: 5, asset_account: '1500', accum_dep_account: '1590', dep_expense_account: '5201' });
  const vehCat = vehCatRes.json;
  await inj('POST', '/api/assets', admin, { name: 'PR-3 delivery van', category_id: Number(vehCat.id), acquire_cost: 120000, acquire_source: 'cash', acquire_date: '2026-06-01' });
  await inj('PUT', '/api/feature-flags/posting_determination', admin, { enabled: true }); // opt HQ in
  const depRun = (await inj('POST', '/api/assets/depreciation/run', admin, { period: '2026-08' })).json;
  const hqRun = (depRun.runs ?? []).find((r: any) => r.tenant_id === hq);
  const dep3Lines = hqRun?.journal_no ? await jeLines(hqRun.journal_no) : [];
  ok('PR-3: category-grain depreciation — the van\'s charge debits the CATEGORY account 5201 (2,000/mo)',
    dep3Lines.some((l: any) => l.accountCode === '5201' && near(l.debit, 2000)), `lines=${dep3Lines.map((l: any) => `${l.accountCode}:${l.debit}`).join(',')}`);
  ok('PR-3: uncategorized assets in the SAME run keep the default 5200 (split pairs, one balanced JE)',
    dep3Lines.some((l: any) => l.accountCode === '5200' && Number(l.debit ?? 0) > 0) && near(dep3Lines.reduce((a: number, l: any) => a + Number(l.debit ?? 0) - Number(l.credit ?? 0), 0), 0),
    `lines=${dep3Lines.map((l: any) => `${l.accountCode}:${l.debit ?? ''}/${l.credit ?? ''}`).join(',')}`);
  // (c) ASSET.DISPOSE.gain_loss override (GL-24 flow): rule to 5721, distinct approver, then a disposal's
  // gain leg re-routes while the 1500/1590 register controls stay pinned.
  const dspRule = (await inj('POST', '/api/ledger/posting-rules', admin, { eventType: 'ASSET.DISPOSE', legOrder: 1, role: 'gain_loss', side: 'CR', accountCode: '5721' })).json;
  await inj('POST', `/api/ledger/posting-rules/${Number(dspRule.id)}/approve`, mgr);
  const van = (await inj('GET', '/api/assets', admin)).json.assets?.find((a: any) => a.name === 'PR-3 delivery van');
  const dsp = (await inj('PATCH', `/api/assets/${van.asset_no}/dispose`, admin, { proceeds: 120000 })).json;
  const dspLines = await jeLines(dsp.journal_no);
  ok('PR-3: disposal gain leg follows the approved ASSET.DISPOSE rule (5721); 1500/1590 stay pinned',
    dspLines.some((l: any) => l.accountCode === '5721' && near(l.credit, 2000)) && dspLines.some((l: any) => l.accountCode === '1500' && near(l.credit, 120000)) && dspLines.some((l: any) => l.accountCode === '1590' && near(l.debit, 2000)),
    `lines=${dspLines.map((l: any) => l.accountCode).join(',')}`);
  await inj('PUT', '/api/feature-flags/posting_determination', admin, { enabled: false }); // restore HQ opt-out
  await db.update(s.accounts).set({ isControl: true, controlSubledger: 'FA' }).where(eq(s.accounts.code, '1500'));
  // (d) PREPAID.AMORTIZE.expense override is stamped on a new schedule at create (dto account still wins).
  const ppdRule = (await inj('POST', '/api/ledger/posting-rules', admin, { eventType: 'PREPAID.AMORTIZE', legOrder: 1, role: 'expense', side: 'DR', accountCode: '5721' })).json;
  await inj('POST', `/api/ledger/posting-rules/${Number(ppdRule.id)}/approve`, mgr);
  await inj('POST', '/api/ledger/prepaid', admin, { name: 'PR-3 prepaid (override)', total_amount: 600, months: 6 });
  const ppdList = (await inj('GET', '/api/ledger/prepaid', admin)).json;
  ok('PR-3: a new prepaid schedule stamps the approved PREPAID.AMORTIZE override as its expense account',
    (ppdList.schedules ?? []).some((sch: any) => sch.name === 'PR-3 prepaid (override)' && sch.expense_account === '5721'), `n=${ppdList.count}`);

  // ── docs/43 PR-8 — accounts.cf_bucket drives the indirect SCF (column ?? CF_CLASSIFY map) ──
  // A NEW balance-sheet account created with its own bucket classifies itself: a loan drawdown on 2650
  // (cf_bucket=financing, is_current=false) lands in the FINANCING section — before 0346 it fell to the
  // type-based operating fallback and was surfaced "unclassified".
  // GL-27 (COA follow-up C): the canonical create STAGES with >1 active Admin; a DIFFERENT Admin approves.
  const coa2650req = await inj('POST', '/api/ledger/accounts', admin, { code: '2650', name: 'Long-term Bank Loan (PR-8)', type: 'Liability', cfBucket: 'financing', cfLabel: 'เงินกู้ยืมระยะยาว', isCurrent: false });
  ok('GL-27: canonical COA create stages PendingApproval', coa2650req.status === 201 && coa2650req.json?.status === 'PendingApproval', `${coa2650req.status} ${coa2650req.json?.status}`);
  const coa2650 = await inj('POST', `/api/ledger/accounts/change-requests/${coa2650req.json?.id}/approve`, mgr);
  ok('PR-8: approved COA create carries cfBucket/isCurrent self-classification', coa2650.status === 200 && coa2650.json?.cfBucket === 'financing', `${coa2650.status} ${coa2650.json?.cfBucket}`);
  const loanJe = await inj('POST', '/api/ledger/journal', admin, { date: '2027-03-05', source: 'Manual', memo: 'PR-8 loan drawdown', lines: [{ account_code: '1010', debit: 250000 }, { account_code: '2650', credit: 250000 }] });
  await inj('POST', `/api/ledger/journal/${loanJe.json?.entry_no}/approve`, mgr);
  const scf8 = (await inj('GET', '/api/ledger/cash-flow?from=2027-03-01&to=2027-03-31', admin)).json;
  const finLine = (scf8.financing?.lines ?? []).find((l: any) => l.account_code === '2650');
  ok('PR-8: the loan drawdown classifies under FINANCING via the account column (not unclassified/operating)',
    finLine != null && near(finLine.amount, 250000) && !(scf8.unclassified_accounts ?? []).includes('2650'),
    JSON.stringify({ fin: finLine, uncls: scf8.unclassified_accounts }));

  // ── COA follow-up B — where-used report (config masters referencing an account) ──
  // A category pointing its COGS at 2650 must show up; the report is read-only (deactivate stays
  // balance-gated) and a gl_coa holder can call it without the Admin canonical-write gate.
  const wuCat = await inj('POST', '/api/item-setup/categories', admin, { code: 'WUCAT', name: 'Where-used probe', cogs_account: '2650' });
  ok('COA-B: probe category created with cogs_account=2650', wuCat.status === 201 || wuCat.status === 200, `${wuCat.status}`);
  const wu = await inj('GET', '/api/ledger/accounts/2650/where-used', admin);
  const wuCatRef = (wu.json?.references ?? []).find((r: any) => r.source === 'item_categories');
  ok('COA-B: where-used reports the item-category reference (count ≥ 1, total ≥ 1)',
    wu.status === 200 && wu.json?.account_code === '2650' && wuCatRef?.count >= 1 && wu.json?.total >= 1,
    JSON.stringify(wu.json));
  const wuMissing = await inj('GET', '/api/ledger/accounts/6666/where-used', admin);
  ok('COA-B: where-used on a non-existent code → 404 ACCOUNT_NOT_FOUND',
    wuMissing.status === 404 && wuMissing.json?.error?.code === 'ACCOUNT_NOT_FOUND', `${wuMissing.status} ${wuMissing.json?.error?.code}`);

  // ── COA-D2 (GL-21): effective window + required dimensions are ENFORCED at posting once declared ──
  const effReq = await inj('POST', '/api/ledger/accounts', admin, { code: '5910', name: 'Retired sundry expense (D2)', type: 'Expense', effectiveTo: '2026-06-30' });
  await inj('POST', `/api/ledger/accounts/change-requests/${effReq.json?.id}/approve`, mgr);
  const effJe = await inj('POST', '/api/ledger/journal', admin, { date: '2027-03-06', source: 'Manual', memo: 'D2 effective window', lines: [{ account_code: '5910', debit: 10 }, { account_code: '1010', credit: 10 }] });
  ok('COA-D2: a line dated after effective_to → 400 ACCOUNT_NOT_EFFECTIVE (the manual\'s "use an effective-to date" now binds)',
    effJe.status === 400 && effJe.json?.error?.code === 'ACCOUNT_NOT_EFFECTIVE', `${effJe.status} ${effJe.json?.error?.code}`);
  const dimReq = await inj('POST', '/api/ledger/accounts', admin, { code: '5920', name: 'Project-tracked expense (D2)', type: 'Expense', requireDimension: { cost_center: true } });
  await inj('POST', `/api/ledger/accounts/change-requests/${dimReq.json?.id}/approve`, mgr);
  const dimMiss = await inj('POST', '/api/ledger/journal', admin, { date: '2027-03-06', source: 'Manual', memo: 'D2 dim missing', lines: [{ account_code: '5920', debit: 10 }, { account_code: '1010', credit: 10 }] });
  const dimOkJe = await inj('POST', '/api/ledger/journal', admin, { date: '2027-03-06', source: 'Manual', memo: 'D2 dim present', lines: [{ account_code: '5920', debit: 10, cost_center: 'CC-1' }, { account_code: '1010', credit: 10 }] });
  ok('COA-D2: a flagged dimension missing → 400 REQUIRED_DIMENSION_MISSING; the same line WITH it posts',
    dimMiss.status === 400 && dimMiss.json?.error?.code === 'REQUIRED_DIMENSION_MISSING' && (dimOkJe.status === 200 || dimOkJe.status === 201) && !!dimOkJe.json?.entry_no,
    `miss=${dimMiss.status}/${dimMiss.json?.error?.code} ok=${dimOkJe.status}`);
  const badParent = await inj('POST', '/api/ledger/accounts', admin, { code: '5930', name: 'orphan (D2)', type: 'Expense', parentCode: '9876' });
  ok('COA-D2: a create naming a non-existent parent → 400 PARENT_NOT_FOUND (fail-closed at request time)',
    badParent.status === 400 && badParent.json?.error?.code === 'PARENT_NOT_FOUND', `${badParent.status} ${badParent.json?.error?.code}`);

  // ── B5 (docs/50 Wave 5, GL-28): JE anomaly & control-exception analytics — seed one anomaly per rule,
  //    scan (idempotent), dismiss-with-reason (audit-logged), cockpit pillar + scheduled BI sweep ──
  const jePost = async (date: string, memo: string, lines: any[]) => {
    const r = await inj('POST', '/api/ledger/journal', admin, { date, source: 'Manual', memo, lines });
    await inj('POST', `/api/ledger/journal/${r.json?.entry_no}/approve`, mgr);
    return r.json?.entry_no as string;
  };
  // duplicate_je: same date + same total + same account set, twice (odd amount so round_amount stays quiet)
  const dupA = await jePost('2027-04-01', 'B5 dup A', [{ account_code: '5100', debit: 1234.56 }, { account_code: '1010', credit: 1234.56 }]);
  const dupB = await jePost('2027-04-01', 'B5 dup B', [{ account_code: '5100', debit: 1234.56 }, { account_code: '1010', credit: 1234.56 }]);
  // round_amount: Manual, ≥ ฿10,000, whole ฿1,000 (unique date+total so it doesn't pair as a duplicate)
  const roundNo = await jePost('2027-04-02', 'B5 round', [{ account_code: '5100', debit: 50000 }, { account_code: '1010', credit: 50000 }]);
  // backdated: accounting date 30 days before its real capture time (still inside the 90-day window)
  const backNo = await jePost(daysAgo(30), 'B5 backdated', [{ account_code: '5100', debit: 777.25 }, { account_code: '1010', credit: 777.25 }]);
  // after_hours: rewrite the audit event to 03:00 Asia/Bangkok (20:00 UTC). NB a maker-checker manual JE
  // writes its landing evidence as APPROVE (the POST action fires only on direct land-Posted sources).
  const nightNo = await jePost('2027-04-03', 'B5 night', [{ account_code: '5100', debit: 888.75 }, { account_code: '1010', credit: 888.75 }]);
  const [nightRow] = await db.select().from(s.journalEntries).where(eq(s.journalEntries.entryNo, nightNo));
  await pg.query(`UPDATE gl_audit_log SET at='2027-04-03T20:00:00Z' WHERE entry_id=${Number(nightRow.id)} AND action IN ('POST','APPROVE')`);
  // unusual_pair: a Manual JE pairing cash (10xx) with revenue (4xxx) directly — bypasses AR
  const pairNo = await jePost('2027-04-04', 'B5 cash↔revenue', [{ account_code: '1000', debit: 999.5 }, { account_code: '4000', credit: 999.5 }]);

  const jeScan1 = await inj('POST', '/api/ledger/je-exceptions/scan', admin);
  ok('B5: scan runs and finds every seeded rule (duplicate/round/backdated/after_hours/unusual_pair)',
    jeScan1.status < 300 && jeScan1.json.new > 0 && ['duplicate_je', 'round_amount', 'backdated', 'after_hours', 'unusual_pair'].every((r) => (jeScan1.json.by_rule?.[r] ?? 0) >= 1),
    JSON.stringify(jeScan1.json.by_rule));
  const jeList1 = await inj('GET', '/api/ledger/je-exceptions?status=open', admin);
  const jeBy = (rule: string, no: string) => (jeList1.json.exceptions ?? []).find((x: any) => x.rule === rule && x.entry_no === no);
  ok('B5: both duplicate entries flagged HIGH, each naming its peer',
    !!jeBy('duplicate_je', dupA) && !!jeBy('duplicate_je', dupB) && jeBy('duplicate_je', dupA).severity === 'high' && (jeBy('duplicate_je', dupA).detail?.peer_entry_nos ?? []).includes(dupB),
    JSON.stringify(jeBy('duplicate_je', dupA)?.detail));
  ok('B5: round-amount Manual JE flagged (medium, total 50000)', jeBy('round_amount', roundNo)?.severity === 'medium' && near(jeBy('round_amount', roundNo)?.detail?.total, 50000), JSON.stringify(jeBy('round_amount', roundNo)?.detail));
  ok('B5: backdated JE flagged (lag ≈ 30 days > 7)', (jeBy('backdated', backNo)?.detail?.lag_days ?? 0) >= 28, JSON.stringify(jeBy('backdated', backNo)?.detail));
  ok('B5: after-hours POST flagged (03:00 Asia/Bangkok)', jeBy('after_hours', nightNo)?.detail?.bkk_hour === 3, JSON.stringify(jeBy('after_hours', nightNo)?.detail));
  ok('B5: cash↔revenue Manual pair flagged HIGH', jeBy('unusual_pair', pairNo)?.severity === 'high', JSON.stringify(jeBy('unusual_pair', pairNo)?.detail));
  const jeScan2 = await inj('POST', '/api/ledger/je-exceptions/scan', admin);
  ok('B5: re-scan is idempotent (same findings, new=0)', jeScan2.status < 300 && jeScan2.json.new === 0 && jeScan2.json.findings === jeScan1.json.findings, JSON.stringify({ n: jeScan2.json.new, f: jeScan2.json.findings }));

  const cockpit = await inj('GET', '/api/finance/metrics/close/status', admin);
  ok('B5: Close Cockpit gains the je_exceptions pillar (open>0, HIGH open ⇒ red)',
    cockpit.status === 200 && (cockpit.json.je_exceptions?.open ?? 0) > 0 && (cockpit.json.je_exceptions?.high_open ?? 0) > 0 && cockpit.json.rag?.je_exceptions === 'red',
    JSON.stringify({ je: cockpit.json.je_exceptions, rag: cockpit.json.rag?.je_exceptions }));

  const roundExc = jeBy('round_amount', roundNo);
  const disNoReason = await inj('POST', `/api/ledger/je-exceptions/${roundExc.id}/dismiss`, admin, {});
  ok('B5: dismissal without a reason rejected (400)', disNoReason.status === 400, `${disNoReason.status} ${disNoReason.json?.error?.code ?? ''}`);
  const dis1 = await inj('POST', `/api/ledger/je-exceptions/${roundExc.id}/dismiss`, admin, { reason: 'ยอดกลมตามสัญญาเช่า — ตรวจสอบแล้ว' });
  ok('B5: dismiss-with-reason lands (status dismissed, who/when stamped)', dis1.status < 300 && dis1.json.status === 'dismissed' && dis1.json.dismissed_by === 'admin', JSON.stringify(dis1.json));
  const audRows = await db.select().from(s.glAuditLog).where(eq(s.glAuditLog.action, 'EXCEPTION_DISMISSED'));
  ok('B5: dismissal writes the gl_audit_log EXCEPTION_DISMISSED evidence (rule + reason)',
    audRows.some((a: any) => a.detail?.rule === 'round_amount' && a.detail?.exception_id === roundExc.id && /ตรวจสอบแล้ว/.test(a.detail?.reason ?? '')),
    JSON.stringify(audRows.slice(-1).map((a: any) => a.detail)));
  const dis2 = await inj('POST', `/api/ledger/je-exceptions/${roundExc.id}/dismiss`, admin, { reason: 'ซ้ำ' });
  ok('B5: re-dismiss rejected (ALREADY_DISMISSED)', dis2.status === 400 && dis2.json?.error?.code === 'ALREADY_DISMISSED', `${dis2.status} ${dis2.json?.error?.code}`);
  const jeScan3 = await inj('POST', '/api/ledger/je-exceptions/scan', admin);
  ok('B5: a dismissed exception stays dismissed on re-scan (new=0)', jeScan3.json.new === 0, JSON.stringify({ n: jeScan3.json.new }));

  const jeSub = await inj('POST', '/api/bi/subscriptions', admin, { name: 'JE exception sweep', report_type: 'je_exceptions', frequency: 'daily' });
  ok('B5: je_exceptions subscription accepted (registered report type)', jeSub.status < 300 && !!jeSub.json.id, JSON.stringify(jeSub.json).slice(0, 80));
  const jeJob = await inj('POST', `/api/bi/subscriptions/${jeSub.json.id}/run`, admin);
  ok('B5: scheduled sweep runs (summary carries the finding counts)', jeJob.status === 200 && /JE exceptions/.test(JSON.stringify(jeJob.json)), JSON.stringify(jeJob.json).slice(0, 140));

  // ── F1 (Close Manager v2, docs/50 follow-up): evidence-driven auto-complete + overdue tasks in GOV-01 ──
  //    Isolated period 2028-02 so every evidence source is controlled by THIS block.
  const f1Start = await inj('POST', '/api/ledger/close/start', admin, { period: '2028-02' });
  const f1RunId = f1Start.json.id;
  ok('F1: close run started for the isolated period', f1Start.status < 300 && !!f1RunId, `id=${f1RunId}`);
  const f1Auto0 = await inj('POST', '/api/ledger/close/auto-complete', admin, { close_run_id: f1RunId });
  ok('F1: with NO evidence nothing auto-completes (all four candidates evidence_not_met)',
    f1Auto0.status === 200 && (f1Auto0.json.completed ?? []).length === 0
      && ['recurring', 'fx_reval', 'deferred_tax', 'depreciation'].every((k) => (f1Auto0.json.skipped ?? []).some((x: any) => x.step_key === k && x.reason === 'evidence_not_met')),
    JSON.stringify(f1Auto0.json.skipped));
  // Manufacture the evidence: nothing left due for the sweeps; a Posted reval + deferred-tax run; a Posted DEP entry.
  await pg.query(`UPDATE recurring_journals SET next_run_date='2028-03-05' WHERE active='true' AND next_run_date <= '2028-02-29'`);
  await pg.query(`UPDATE prepaid_schedules SET next_run_date='2028-03-05' WHERE status='active' AND next_run_date <= '2028-02-29'`);
  await db.insert(s.fxRevalRuns).values({ tenantId: hq, period: '2028-02', asOfDate: '2028-02-29', status: 'Posted', runBy: 'admin', postedBy: 'mgr' });
  await db.insert(s.deferredTaxRuns).values({ tenantId: hq, period: '2028-02', asOfDate: '2028-02-29', status: 'Posted' } as any);
  await db.insert(s.journalEntries).values({ entryNo: 'JE-F1-DEP-1', entryDate: '2028-02-05', period: '2028-02', source: 'DEP', status: 'Posted', memo: 'F1 dep evidence', tenantId: hq, createdBy: 'system' });
  const f1Auto1 = await inj('POST', '/api/ledger/close/auto-complete', admin, { close_run_id: f1RunId });
  ok('F1: with evidence all four system-verifiable steps flip Done',
    f1Auto1.status === 200 && ['recurring', 'fx_reval', 'deferred_tax', 'depreciation'].every((k) => (f1Auto1.json.completed ?? []).some((x: any) => x.step_key === k)),
    JSON.stringify((f1Auto1.json.completed ?? []).map((x: any) => x.step_key)));
  const f1Steps = f1Auto1.json.run?.steps ?? [];
  const f1Fx = f1Steps.find((x: any) => x.step_key === 'fx_reval');
  ok('F1: auto-completed steps carry the (auto) attribution + pinned evidence', f1Fx?.completed_by === 'admin (auto)' && f1Fx?.detail?.auto === true && f1Fx?.detail?.evidence?.posted_reval_run != null, JSON.stringify({ by: f1Fx?.completed_by, d: f1Fx?.detail }));
  ok('F1: human sign-offs are NEVER auto-completed (trial_balance_review stays Pending; run not ReadyToLock)',
    f1Steps.find((x: any) => x.step_key === 'trial_balance_review')?.status === 'Pending' && f1Auto1.json.run?.status !== 'ReadyToLock',
    JSON.stringify({ tb: f1Steps.find((x: any) => x.step_key === 'trial_balance_review')?.status, run: f1Auto1.json.run?.status }));
  const f1Auto2 = await inj('POST', '/api/ledger/close/auto-complete', admin, { close_run_id: f1RunId });
  ok('F1: re-run is idempotent (0 completed, already_done)', (f1Auto2.json.completed ?? []).length === 0 && (f1Auto2.json.skipped ?? []).filter((x: any) => x.reason === 'already_done').length >= 4, JSON.stringify(f1Auto2.json.skipped?.slice(0, 5)));
  // ── G3 (Close Manager v2b): bank_rec / subledger_tieout tick from CERTIFIED REC-01 recons ──
  //    Absence never ticks: with zero recon workspaces for 2028-02 both steps read evidence_not_met.
  ok('G3: with no recon workspaces bank_rec/subledger_tieout stay evidence_not_met (absence is not evidence)',
    ['bank_rec', 'subledger_tieout'].every((k) => (f1Auto2.json.skipped ?? []).some((x: any) => x.step_key === k && x.reason === 'evidence_not_met')),
    JSON.stringify((f1Auto2.json.skipped ?? []).filter((x: any) => x.reason === 'evidence_not_met')));
  // A cash recon exists but is only Reconciled (not certified) → still blocked; tie-out has 1100 Certified
  // but 2000 still Open → the one uncertified workspace blocks the whole set.
  await db.insert(s.reconPeriods).values({ tenantId: hq, accountCode: '1000', period: '2028-02', status: 'Reconciled', preparedBy: 'admin' } as any);
  await db.insert(s.reconPeriods).values({ tenantId: hq, accountCode: '1100', period: '2028-02', status: 'Certified', preparedBy: 'admin', certifiedBy: 'mgr' } as any);
  await db.insert(s.reconPeriods).values({ tenantId: hq, accountCode: '2000', period: '2028-02', status: 'Open', preparedBy: 'admin' } as any);
  const g3Auto1 = await inj('POST', '/api/ledger/close/auto-complete', admin, { close_run_id: f1RunId });
  ok('G3: an un-certified workspace in the set blocks the step (both still evidence_not_met)',
    (g3Auto1.json.completed ?? []).length === 0
      && ['bank_rec', 'subledger_tieout'].every((k) => (g3Auto1.json.skipped ?? []).some((x: any) => x.step_key === k && x.reason === 'evidence_not_met')),
    JSON.stringify((g3Auto1.json.skipped ?? []).filter((x: any) => x.step_key === 'bank_rec' || x.step_key === 'subledger_tieout')));
  // Certify the blockers (the REC-01 certification is the human act; the tick only reflects it).
  await pg.query(`UPDATE recon_periods SET status='Certified', certified_by='mgr' WHERE period='2028-02' AND account_code IN ('1000','2000')`);
  const g3Auto2 = await inj('POST', '/api/ledger/close/auto-complete', admin, { close_run_id: f1RunId });
  ok('G3: once every opened workspace on the set is Certified both steps flip Done',
    ['bank_rec', 'subledger_tieout'].every((k) => (g3Auto2.json.completed ?? []).some((x: any) => x.step_key === k)),
    JSON.stringify((g3Auto2.json.completed ?? []).map((x: any) => x.step_key)));
  const g3Bank = (g3Auto2.json.run?.steps ?? []).find((x: any) => x.step_key === 'bank_rec');
  ok('G3: the tick pins the human certifications it rests on ((auto) attribution + certifier per account)',
    g3Bank?.completed_by === 'admin (auto)' && g3Bank?.detail?.evidence?.certifications?.some((c: any) => c.account === '1000' && c.certified_by === 'mgr'),
    JSON.stringify({ by: g3Bank?.completed_by, ev: g3Bank?.detail?.evidence }));
  // Overdue close task → GOV-01 pending-approvals worklist (GL-15 detective).
  await pg.query(`UPDATE close_run_steps SET due_date='2026-01-15' WHERE close_run_id=${Number(f1RunId)} AND step_key='trial_balance_review'`);
  const f1Gov = (await inj('GET', '/api/finance/approvals/pending', admin)).json;
  const f1Over = (f1Gov.items ?? []).find((i: any) => i.type === 'close_task_overdue' && i.ref === 'CLOSE-2028-02:trial_balance_review');
  ok('F1: an overdue, not-Done close task surfaces in the GOV-01 center with its overdue age', !!f1Over && f1Over.age_days > 0 && f1Over.control === 'GL-15', JSON.stringify(f1Over));
  await inj('POST', '/api/ledger/close/step', admin, { close_run_id: f1RunId, step_key: 'trial_balance_review' });
  const f1Gov2 = (await inj('GET', '/api/finance/approvals/pending', admin)).json;
  ok('F1: signing the task off clears it from the overdue worklist', !(f1Gov2.items ?? []).some((i: any) => i.type === 'close_task_overdue' && i.ref === 'CLOSE-2028-02:trial_balance_review'), '');

  console.log('\n── ERP basics — Cash Flows + Collections/Dunning + ESS-AP + EAM + credit/depth/forecast + recurring + statements/petty-cash/prepaid/lease/revaluation + inventory sub-ledger + FIFO/FEFO + industry CoA + GL-12 posting-rules engine + GL-13 multi-dim postings + GL-14 sub-ledger tie-out + GL-15/GL-16 hard period close + C1 multi-currency (JPY 0dp) + C2 pluggable tax (SG/MY/EU) + e-invoicing (MyInvois/Peppol) + REV-21 AR cash application + FIN-4 statutory FS pack (report builder/SOCE/notes/DBD) + docs/43 PR-2 posting-override re-route (GL-24) + PR-3 category-grain asset accounts & dispose/prepaid overrides + B5 JE anomaly analytics (GL-28) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} basics checks failed` : `\n✅ All ${checks.length} basics checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
