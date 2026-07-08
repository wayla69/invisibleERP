/**
 * Golden-master characterization harness (docs/38 §2 step 1 — "characterize BEFORE decomposing").
 * รัน service จริงของ V2 (จาก dist) บน PGlite ด้วย seed ที่กำหนดผลได้ แล้วเทียบผลลัพธ์ทั้งก้อน
 * (หลัง normalize ค่า volatile: วันที่/เลขเอกสาร/timestamp) กับ snapshot ที่ pin ไว้ใน
 * tools/parity/golden/goldenmaster.json — ครอบคลุม 4 god service เป้าหมายของแผน decomposition:
 * ledger (posting/recurring/prepaid/cashflow), procurement (PR→PO→GR), projects (WBS/EVM/CPM), bi (KPI/cube/trend).
 *
 * ▸ Run:      NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/parity golden
 * ▸ Re-pin:   UPDATE_GOLDEN=1 NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/parity golden
 *
 * A diff means CURRENT BEHAVIOUR MOVED. Per docs/38 §2.3 the rule during a decomposition PR is:
 * stop and revert — never "adjust" the snapshot to match the refactor. Re-pinning is only legitimate
 * for a CONSCIOUS product change, in the same PR, where the diff is explained in the PR body.
 */
import 'reflect-metadata';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import * as s from '../../../apps/api/dist/database/schema/index';
import { DocNumberService } from '../../../apps/api/dist/common/doc-number.service';
import { StatusLogService } from '../../../apps/api/dist/common/status-log.service';
import { LedgerService } from '../../../apps/api/dist/modules/ledger/ledger.service';
import { ProcurementService } from '../../../apps/api/dist/modules/procurement/procurement.service';
import { ProjectsService } from '../../../apps/api/dist/modules/projects/projects.service';
import { BiService } from '../../../apps/api/dist/modules/bi/bi.service';
import { MessagingService } from '../../../apps/api/dist/modules/messaging/messaging.service';
import { ymd as bizYmd } from '../../../apps/api/dist/database/queries';
import { eq } from 'drizzle-orm';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const GOLDEN_PATH = resolve(process.cwd(), 'golden/goldenmaster.json');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

// Seed dates RELATIVE to the business day (Asia/Bangkok — same basis ymd() uses) so window-dependent
// outputs (EVM planned-value, month cubes) are stable on any run date; absolute dates are then masked.
const daysFromToday = (n: number) => bizYmd(new Date(Date.now() + n * 86400_000));

// ── canonicalization: strip run-date volatility, keep every behavioural number ────────────────────
// Masks (in precedence order): ISO timestamps → <TS>; doc-number stamps (JE-20260708-001,
// INV-RCV-20260708-AB12C) → <STAMP>; date-only strings → <DATE>; YYYY-MM periods → <PERIOD>.
function canonStr(v: string): string {
  return v
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})?/g, '<TS>')
    .replace(/\d{8}-[A-Z0-9]{3,6}\b/g, '<STAMP>')
    .replace(/\d{4}-\d{2}-\d{2}/g, '<DATE>')
    .replace(/\b\d{4}-(0[1-9]|1[0-2])\b/g, '<PERIOD>');
}
function canon(v: any): any {
  if (v == null) return v;
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
  if (typeof v === 'string') return canonStr(v);
  if (v instanceof Date) return '<TS>';
  if (Array.isArray(v)) return v.map(canon);
  if (typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
    return out;
  }
  return v;
}
// Flatten to path → JSON-scalar map for a readable per-path diff.
function flatten(v: any, prefix = '', out: Map<string, string> = new Map()): Map<string, string> {
  if (v !== null && typeof v === 'object') {
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v);
    if (!entries.length) out.set(prefix || '$', Array.isArray(v) ? '[]' : '{}');
    for (const [k, x] of entries) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.set(prefix || '$', JSON.stringify(v));
  }
  return out;
}

// Characterize an expected failure: capture the thrown error CODE as part of the snapshot.
async function errCode(fn: () => Promise<any>): Promise<string> {
  try { await fn(); return '<DID_NOT_THROW>'; }
  catch (e: any) { return String(e?.response?.code ?? e?.code ?? e?.message ?? 'UNKNOWN'); }
}

const maker = { username: 'gm_maker', role: 'Admin', customerName: 'HQ', permissions: [] as string[] };
const checker = { username: 'gm_checker', role: 'FinancialController', customerName: 'HQ', permissions: [] as string[] };

async function main() {
  const { PGlite } = require('@electric-sql/pglite');
  const { drizzle } = require('drizzle-orm/pglite');
  const pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });

  // ── deterministic seed world ──
  await db.insert(s.tenants).values({ code: 'GM1', name: 'Golden Tenant', creditHold: false, creditLimit: '0' });
  const [t] = await db.select({ id: s.tenants.id }).from(s.tenants).where(eq(s.tenants.code, 'GM1'));
  const t1 = Number(t.id);
  const makerT = { ...maker, tenantId: t1 } as any;
  const checkerT = { ...checker, tenantId: t1 } as any;
  await db.insert(s.vendors).values({ vendorCode: 'GMV1', name: 'Golden Vendor', isSupplier: true });
  await db.insert(s.items).values({ itemId: 'GMX', itemDescription: 'Golden Item X', uom: 'EA', unitPrice: '5' });

  const docNo = new DocNumberService(db);
  const statusLog = new StatusLogService(db);
  const ledger = new LedgerService(db, docNo);
  await ledger.seedChartOfAccounts();
  const proc = new ProcurementService(db, docNo, statusLog);
  const projects = new ProjectsService(db, ledger);
  const bi = new BiService(
    db, new MessagingService(db),
    undefined, undefined, undefined, undefined, undefined, // lineNotify, collections, financeMetrics, eam, assets
    ledger, undefined, undefined, undefined,               // ledger, leases, scheduledChanges, revrec
    projects,                                              // projects (project_evm delegation)
  );

  const snapshot: Record<string, any> = {};
  const today = bizYmd(new Date());

  // ════════ 1. LEDGER — posting (GL-05) · recurring (GL-08) · prepaid (GL-09) · cashflow (GL-07) ════════
  // Immediate system posting (Dr Cash 1070 / Cr Revenue 1000 / Cr VAT 70).
  const je1 = await ledger.postEntry({
    date: today, source: 'GM', sourceRef: 'GM-1', tenantId: t1, memo: 'Golden sale', createdBy: maker.username,
    lines: [{ account_code: '1000', debit: 1070 }, { account_code: '4000', credit: 1000 }, { account_code: '2100', credit: 70 }],
  });
  // Idempotency: the exact same (tenant, source, source_ref) posting dedupes.
  const je1dup = await ledger.postEntry({
    date: today, source: 'GM', sourceRef: 'GM-1', tenantId: t1, memo: 'Golden sale', createdBy: maker.username,
    lines: [{ account_code: '1000', debit: 1070 }, { account_code: '4000', credit: 1000 }, { account_code: '2100', credit: 70 }],
  });
  // Maker-checker Draft → SOD self-approve rejection → checker approves (GL-05).
  const je2 = await ledger.postEntry({
    date: today, source: 'Manual', sourceRef: 'GM-2', tenantId: t1, memo: 'Golden accrual', createdBy: maker.username,
    pendingApproval: true, lines: [{ account_code: '5100', debit: 200 }, { account_code: '1000', credit: 200 }],
  });
  const selfApprove = await errCode(() => ledger.approveEntry(je2.entry_no!, makerT));
  const approved = await ledger.approveEntry(je2.entry_no!, checkerT);
  // Guard characterizations: unbalanced + double-sided line.
  const unbalanced = await errCode(() => ledger.postEntry({
    date: today, source: 'GM', sourceRef: 'GM-BAD', tenantId: t1, createdBy: maker.username,
    lines: [{ account_code: '1000', debit: 10 }, { account_code: '4000', credit: 9 }],
  }));
  const doubleSided = await errCode(() => ledger.postEntry({
    date: today, source: 'GM', sourceRef: 'GM-BAD2', tenantId: t1, createdBy: maker.username,
    lines: [{ account_code: '1000', debit: 10, credit: 10 }],
  }));
  // Recurring template (GL-08): due today → posts ONE Draft; the schedule rolls forward so a re-run posts none.
  const rec = await ledger.createRecurring({ name: 'Golden rent', frequency: 'monthly', tenantId: t1, startDate: today, lines: [{ account_code: '5100', debit: 50 }, { account_code: '1000', credit: 50 }] } as any, makerT);
  const recRun1 = await ledger.runDueRecurring(makerT);
  const recRun2 = await ledger.runDueRecurring(makerT);
  // Prepaid (GL-09): 1200 over 12 months, capitalized up front → first slice 100 posts; re-run posts none.
  const ppd = await ledger.createPrepaid({ name: 'Golden insurance', totalAmount: 1200, months: 12, startDate: today, capitalize: true, tenantId: t1 } as any, makerT);
  const ppdRun1 = await ledger.runDuePrepaid(makerT);
  const ppdRun2 = await ledger.runDuePrepaid(makerT);
  // Statements over the seeded world (30-day window contains everything posted "today").
  const tb = await ledger.trialBalance();
  const scfIndirect = await ledger.cashFlowStatement(daysFromToday(-30), today);
  const scfDirect = await ledger.cashFlowDirect(daysFromToday(-30), today);
  const incomeStmt = await ledger.incomeStatement(daysFromToday(-30), today);
  const bs = await ledger.balanceSheet(today);
  snapshot.ledger = {
    post_immediate: je1, post_duplicate_dedupes: je1dup,
    post_draft: je2, self_approve_blocked: selfApprove, checker_approves: approved,
    unbalanced_blocked: unbalanced, double_sided_line_blocked: doubleSided,
    recurring_create: rec, recurring_run_due: recRun1, recurring_rerun_same_day: recRun2,
    prepaid_create: ppd, prepaid_run_due: ppdRun1, prepaid_rerun_same_day: ppdRun2,
    // Trial balance restricted to the accounts this harness touches (a full-COA snapshot would churn
    // on every unrelated COA addition; the golden must only move when BEHAVIOUR moves).
    trial_balance_touched: tb.rows.filter((r: any) => ['1000', '1280', '2100', '4000', '5100'].includes(r.account_code)),
    cash_flow_indirect: scfIndirect, cash_flow_direct: scfDirect,
    income_statement: incomeStmt, balance_sheet: bs,
  };

  // ════════ 2. PROCUREMENT — PR → approve → PO → approve → GR (full + partial) ════════
  const pr1 = await proc.createPr({ items: [{ item_id: 'GMX', request_qty: 10 }] }, makerT);
  const prApproved = await proc.approvePr(pr1.pr_no, true, makerT);
  const prForbidden = await errCode(() => proc.approvePr(pr1.pr_no, true, { username: 'gm_sales', role: 'Sales', customerName: 'HQ', permissions: [], tenantId: t1 } as any));
  const po1 = await proc.createPo({ vendor_name: 'Golden Vendor', items: [{ item_id: 'GMX', order_qty: 10, unit_price: 5 }] }, makerT);
  await proc.approvePo(po1.po_no, true, undefined, makerT);
  const grFull = await proc.createGr({ po_no: po1.po_no, items: [{ item_id: 'GMX', received_qty: 10, lot_no: 'GML1', expiry_date: '2027-01-01' }] }, makerT);
  const po2 = await proc.createPo({ vendor_name: 'Golden Vendor', items: [{ item_id: 'GMX', order_qty: 10, unit_price: 5 }] }, makerT);
  await proc.approvePo(po2.po_no, true, undefined, makerT);
  const grPartial = await proc.createGr({ po_no: po2.po_no, items: [{ item_id: 'GMX', received_qty: 4 }] }, makerT);
  snapshot.procurement = {
    pr_create: pr1, pr_approve: prApproved, pr_approve_forbidden_role: prForbidden,
    po_create: po1, gr_full_closes_po: grFull, gr_partial_keeps_received: grPartial,
  };

  // ════════ 3. PROJECTS — WBS · EVM · CPM schedule · milestones · portfolio rollup ════════
  // Task A: scheduled fully in the past (PV counts it), 50% done. Task B: ends in the future (no PV yet),
  // 25% done, depends on A. Billable cost 1000 (→ WIP) + non-billable 500 (→ expensed; still actual cost).
  // Closed-form EVM at "today": BAC 10000 · EV 6000·.5+4000·.25=4000 · PV 6000 · AC 1500
  //                              → CPI 2.6667 · SPI 0.6667 · EAC 3750.
  const prj = await projects.create({ project_code: 'PRJ-GM1', name: 'Golden Build', billing_type: 'TM', budget_amount: 10000, contract_amount: 20000, start_date: daysFromToday(-10), end_date: daysFromToday(10) }, makerT);
  const taskA = await projects.addTask('PRJ-GM1', { name: 'Design', planned_start: daysFromToday(-10), planned_end: daysFromToday(-2), planned_hours: 40, planned_cost: 6000, pct_complete: 50 }, makerT);
  const taskB = await projects.addTask('PRJ-GM1', { name: 'Build', planned_start: daysFromToday(-2), planned_end: daysFromToday(10), planned_hours: 80, planned_cost: 4000, pct_complete: 25, depends_on: [Number(taskA.id)] }, makerT);
  await projects.logCost('PRJ-GM1', { entry_type: 'time', description: 'Golden hours', qty: 10, rate: 100, billable: true, entry_date: today }, makerT);
  await projects.logCost('PRJ-GM1', { entry_type: 'expense', description: 'Golden travel', amount: 500, billable: false, entry_date: today }, makerT);
  const milestone = await projects.addMilestone('PRJ-GM1', { name: 'Design sign-off', due_date: daysFromToday(-2), billing_percent: 30 }, makerT);
  const evm = await projects.evm('PRJ-GM1', today);
  const schedule = await projects.schedule('PRJ-GM1');
  const portfolio = await projects.portfolioEvm(makerT);
  const projGet = await projects.get('PRJ-GM1');
  snapshot.projects = {
    create: prj, task_a: taskA, task_b: taskB, milestone_add: milestone,
    evm_closed_form: evm, cpm_schedule: schedule, portfolio_rollup: portfolio, get_after_costs: projGet,
  };

  // ════════ 4. BI — kpi_board · sales_cube · finance_trend (the decomposition pilot's read core) ════════
  await db.insert(s.custPosSales).values({ saleNo: 'GMSALE-1', saleDate: today, tenantId: t1, status: 'Completed', subtotal: '200', discount: '0', taxAmount: '14', total: '214', paymentMethod: 'Cash', createdBy: maker.username });
  const kpi = await bi.kpiBoard(makerT);
  const cube = await bi.salesCube({ period: 'month', months: 1 }, makerT);
  const trend = await bi.financeTrend({ months: 1 }, makerT);
  snapshot.bi = { kpi_board: kpi, sales_cube: cube, finance_trend: trend };

  // ── compare (or re-pin) ──
  const actual = canon(snapshot);
  if (UPDATE) {
    if (!existsSync(resolve(process.cwd(), 'golden'))) mkdirSync(resolve(process.cwd(), 'golden'), { recursive: true });
    writeFileSync(GOLDEN_PATH, JSON.stringify(actual, null, 2) + '\n');
    const n = flatten(actual).size;
    console.log(`📌 golden-master re-pinned: ${n} paths across ${Object.keys(actual).length} services → ${GOLDEN_PATH}`);
    console.log('   Commit the golden file in the SAME PR and explain the diff in the PR body.');
    return;
  }
  if (!existsSync(GOLDEN_PATH)) {
    console.error(`❌ golden file missing: ${GOLDEN_PATH}`);
    console.error('   First run: UPDATE_GOLDEN=1 pnpm --filter @ierp/parity golden');
    process.exit(1);
  }
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  const a = flatten(actual), g = flatten(golden);
  const diffs: string[] = [];
  for (const [k, v] of g) if (!a.has(k)) diffs.push(`− ${k} (pinned ${v}, now absent)`);
  for (const [k, v] of a) {
    if (!g.has(k)) diffs.push(`+ ${k} = ${v} (not in pinned snapshot)`);
    else if (g.get(k) !== v) diffs.push(`≠ ${k}: pinned ${g.get(k)} → now ${v}`);
  }
  if (diffs.length) {
    console.error(`❌ golden-master drift: ${diffs.length} path(s) moved (of ${g.size} pinned). Current behaviour ≠ pinned snapshot.`);
    for (const d of diffs.slice(0, 40)) console.error(`   ${d}`);
    if (diffs.length > 40) console.error(`   … and ${diffs.length - 40} more`);
    console.error('   During a decomposition PR this means STOP AND REVERT (docs/38 §2.3).');
    console.error('   For a conscious product change: UPDATE_GOLDEN=1 pnpm --filter @ierp/parity golden, commit the golden diff in the same PR.');
    process.exit(1);
  }
  console.log(`✅ golden-master: ${g.size} paths across ${Object.keys(golden).length} services match the pinned snapshot (ledger · procurement · projects · bi)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
