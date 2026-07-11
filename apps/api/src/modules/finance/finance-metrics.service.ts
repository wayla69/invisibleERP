import { Injectable, Optional, Inject, BadRequestException } from '@nestjs/common';
import { sql, and, ne, eq, gte, lte, inArray } from 'drizzle-orm';
import type { JwtUser } from '../../common/decorators';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { arInvoices, apTransactions, bankAccounts, journalLines, journalEntries, accounts, branches, costCenters, projects } from '../../database/schema';
import { ymd } from '../../database/queries';
import { TtlCache } from '../../common/ttl-cache';
import { LedgerService } from '../ledger/ledger.service';
import { FinanceService } from './finance.service';
import { BudgetService } from '../budget/budget.service';
import { CloseService } from '../ledger/close.service';
import {
  METRICS, METRIC_BY_ID, METRIC_GROUPS, ragOf,
  CASH_ACCOUNTS, RECEIVABLE_ACCOUNTS, INVENTORY_ACCOUNTS, OTHER_CURRENT_ASSET_ACCOUNTS,
  NONCURRENT_ASSET_ACCOUNTS, CURRENT_LIABILITY_ACCOUNTS, NONCURRENT_LIABILITY_ACCOUNTS,
  INTEREST_BEARING_DEBT_ACCOUNTS, AR_CONTROL_ACCOUNTS, AP_CONTROL_ACCOUNTS,
  COGS_ACCOUNTS, DEPRECIATION_ACCOUNTS, INTEREST_EXPENSE_ACCOUNTS, INCOME_TAX_ACCOUNTS,
  type FinSnapshot, type MetricDef, type MetricGroup,
} from './finance-metrics-constants';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const inSet = (code: string, set: string[]) => set.includes(code);
const num = (v: unknown) => Number(v ?? 0);

// Relative % change (guarded); null when the base is zero/absent.
function pctChange(cur: number | null, base: number | null): number | null {
  if (cur == null || base == null || base === 0) return null;
  return round2(((cur - base) / Math.abs(base)) * 100);
}

// Cross-snapshot growth metrics (need >1 snapshot, so they live here not in the single-snapshot registry).
const GROWTH_METRICS = [
  { id: 'revenue_growth_mom_pct', label: 'การเติบโตของรายได้ (เดือน)', labelEn: 'Revenue growth MoM %', green: 5, amber: 0 },
  { id: 'revenue_growth_yoy_pct', label: 'การเติบโตของรายได้ (ปี)', labelEn: 'Revenue growth YoY %', green: 10, amber: 0 },
];

// ── Date helpers (date-only boundaries — UTC-safe, no tz-sensitive "today" beyond the ymd() as-of) ──
function parseYmd(s: string): Date { return new Date(`${s}T00:00:00Z`); }
function fmt(d: Date): string { return d.toISOString().slice(0, 10); }
function monthStartOf(s: string): string { return `${s.slice(0, 7)}-01`; }
function shiftMonths(s: string, delta: number): string {
  const d = parseYmd(monthStartOf(s)); d.setUTCMonth(d.getUTCMonth() + delta); return fmt(d);
}
function shiftYears(s: string, delta: number): string {
  const d = parseYmd(s); d.setUTCFullYear(d.getUTCFullYear() + delta); return fmt(d);
}
function endOfPrevMonth(s: string): string { const d = parseYmd(monthStartOf(s)); d.setUTCDate(0); return fmt(d); }
function ttmStart(to: string): string { const d = parseYmd(to); d.setUTCFullYear(d.getUTCFullYear() - 1); d.setUTCDate(d.getUTCDate() + 1); return fmt(d); } // trailing-12-month start
function daysInclusive(from: string, to: string): number {
  return Math.max(1, Math.round((parseYmd(to).getTime() - parseYmd(from).getTime()) / 86400000) + 1);
}

// Finance KPI engine (docs/35 Phase 1). Read-only aggregator over the ledger + sub-ledgers: one canonical
// computation of the CFO scorecard (~32 KPIs) with prior-period / prior-year / budget comparatives + RAG.
// No posting logic; every number reconciles to the statement it is drilled from. RLS scopes the tenant
// (all calls run in request context), so the cache key must always carry the tenant id.
@Injectable()
export class FinanceMetricsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    // @Optional so a partial cutover harness can still construct the service; the full app always wires these.
    @Optional() private readonly ledger?: LedgerService,
    @Optional() private readonly finance?: FinanceService,
    @Optional() private readonly budget?: BudgetService,
    @Optional() private readonly close?: CloseService,
  ) {}

  private readonly cache = new TtlCache();
  private get ttl(): number { return Number(process.env.BI_CACHE_TTL_MS ?? 30000); }

  // ── One raw snapshot for a [from,to] window (balance metrics as of `to`, flows over the window) ──
  private async snapshot(from: string, to: string, includeAging: boolean): Promise<FinSnapshot> {
    if (!this.ledger) throw new BadRequestException({ code: 'LEDGER_UNAVAILABLE', message: 'Ledger service not wired' });
    const days = daysInclusive(from, to);

    // Balance sheet (as of `to`)
    const bs: any = await this.ledger.balanceSheet(to);
    let cash = 0, receivables = 0, inventory = 0, otherCurrentAssets = 0, nonCurrentAssets = 0;
    let currentLiabilities = 0, nonCurrentLiabilities = 0, interestBearingDebt = 0, arControl = 0, apControl = 0;
    // docs/43 PR-8: an account's OWN is_current column (0346) wins over the hardcoded lists / CoA-numbering
    // fallbacks — a new balance-sheet account self-declares current vs non-current.
    const isCurrentCol = new Map<string, boolean>(
      (await this.db.select({ code: accounts.code, isCurrent: accounts.isCurrent }).from(accounts))
        .filter((a: any) => a.isCurrent != null).map((a: any) => [a.code, a.isCurrent as boolean]),
    );
    for (const l of bs.lines ?? []) {
      const code = String(l.account_code); const bal = num(l.balance);
      if (l.account_type === 'Asset') {
        if (inSet(code, CASH_ACCOUNTS)) cash += bal;
        else if (inSet(code, RECEIVABLE_ACCOUNTS)) receivables += bal;
        else if (inSet(code, INVENTORY_ACCOUNTS)) inventory += bal;
        else if (isCurrentCol.has(code)) { if (isCurrentCol.get(code)) otherCurrentAssets += bal; else nonCurrentAssets += bal; }
        else if (inSet(code, NONCURRENT_ASSET_ACCOUNTS)) nonCurrentAssets += bal;
        else if (inSet(code, OTHER_CURRENT_ASSET_ACCOUNTS)) otherCurrentAssets += bal;
        else if (code < '1500') otherCurrentAssets += bal; else nonCurrentAssets += bal; // fallback by CoA numbering
      } else if (l.account_type === 'Liability') {
        if (isCurrentCol.has(code)) { if (isCurrentCol.get(code)) currentLiabilities += bal; else nonCurrentLiabilities += bal; }
        else if (inSet(code, NONCURRENT_LIABILITY_ACCOUNTS)) nonCurrentLiabilities += bal;
        else if (inSet(code, CURRENT_LIABILITY_ACCOUNTS)) currentLiabilities += bal;
        else if (code < '2600') currentLiabilities += bal; else nonCurrentLiabilities += bal;
      }
      if (inSet(code, INTEREST_BEARING_DEBT_ACCOUNTS)) interestBearingDebt += bal;
      if (inSet(code, AR_CONTROL_ACCOUNTS)) arControl += bal;
      if (inSet(code, AP_CONTROL_ACCOUNTS)) apControl += bal;
    }
    const allowance = -((bs.lines ?? []).filter((l: any) => String(l.account_code) === '1190').reduce((a: number, l: any) => a + num(l.balance), 0));
    const currentAssets = round2(cash + receivables + inventory + otherCurrentAssets);
    const totalAssets = num(bs.assets);
    const totalLiabilities = num(bs.liabilities);
    const equity = round2(num(bs.equity) + num(bs.net_income)); // include current-period earnings for ratios

    // Income statement (over [from,to])
    const is: any = await this.ledger.incomeStatement(from, to);
    const flow = (codes: string[]) => (is.lines ?? []).filter((l: any) => inSet(String(l.account_code), codes)).reduce((a: number, l: any) => a + (num(l.debit) - num(l.credit)), 0);
    const revenue = num(is.revenue);
    const expenseTotal = num(is.expense);
    const cogs = round2(flow(COGS_ACCOUNTS));
    const depreciation = round2(flow(DEPRECIATION_ACCOUNTS));
    const interest = round2(flow(INTEREST_EXPENSE_ACCOUNTS));
    const incomeTax = round2(flow(INCOME_TAX_ACCOUNTS));
    const netIncome = num(is.net_income);
    const opex = round2(expenseTotal - cogs - depreciation - interest - incomeTax);
    const grossProfit = round2(revenue - cogs);
    const operatingIncome = round2(netIncome + interest + incomeTax); // EBIT
    const ebitda = round2(operatingIncome + depreciation);

    // Trailing-twelve-month P&L (ending at `to`, CLOSE excluded so a year-end crossing isn't zeroed) — the
    // basis for annualized/efficiency KPIs (turnover, DSO/DPO/DIO, ROA/ROE, days-cash, runway).
    const ttm: any = await this.ledger.incomeStatement(ttmStart(to), to, undefined, undefined, ['CLOSE']);
    const ttmFlow = (codes: string[]) => (ttm.lines ?? []).filter((l: any) => inSet(String(l.account_code), codes)).reduce((a: number, l: any) => a + (num(l.debit) - num(l.credit)), 0);
    const ttmRevenue = num(ttm.revenue);
    const ttmCogs = round2(ttmFlow(COGS_ACCOUNTS));
    const ttmOpex = round2(num(ttm.expense) - ttmCogs - ttmFlow(DEPRECIATION_ACCOUNTS) - ttmFlow(INTEREST_EXPENSE_ACCOUNTS) - ttmFlow(INCOME_TAX_ACCOUNTS));
    const ttmNetIncome = num(ttm.net_income);

    // Cash flow (over [from,to]) — OCF + net investing ⇒ FCF proxy
    let ocf = 0, capex = 0;
    try { const cf: any = await this.ledger.cashFlowStatement(from, to); ocf = num(cf.operating?.net); capex = num(cf.investing?.net); }
    catch { /* cash-flow needs a balanced window; leave 0 if it cannot reconcile */ }
    const fcf = round2(ocf + capex);

    // Aging (as of now) — only meaningful for the current window; historical windows leave these at 0
    let arTotal = 0, arOverdue = 0, ar90plus = 0, apTotal = 0, apOverdue = 0;
    if (includeAging && this.finance) {
      const ar: any = await this.finance.arAging().catch(() => null);
      const ap: any = await this.finance.apAging().catch(() => null);
      if (ar) { arTotal = num(ar.total); arOverdue = round2(arTotal - num(ar.buckets?.current)); ar90plus = num(ar.buckets?.d90_plus); }
      if (ap) { apTotal = num(ap.total); apOverdue = round2(apTotal - num(ap.buckets?.current)); }
    }

    return {
      from, to, days,
      cash: round2(cash), receivables: round2(receivables), inventory: round2(inventory), otherCurrentAssets: round2(otherCurrentAssets),
      currentAssets, nonCurrentAssets: round2(nonCurrentAssets), totalAssets,
      currentLiabilities: round2(currentLiabilities), nonCurrentLiabilities: round2(nonCurrentLiabilities), totalLiabilities,
      equity, interestBearingDebt: round2(interestBearingDebt), arControl: round2(arControl), apControl: round2(apControl),
      revenue, cogs, grossProfit, opex, depreciation, interest, incomeTax, operatingIncome, ebitda, netIncome,
      ttmRevenue, ttmCogs, ttmOpex, ttmNetIncome,
      ocf: round2(ocf), capex: round2(capex), fcf,
      arTotal, arOverdue, ar90plus, allowance: round2(allowance), apTotal, apOverdue,
    };
  }

  // Resolve the window + comparatives from the query. Default window = current month-to-date.
  private windows(q: { as_of?: string; period?: string; from?: string; to?: string }) {
    const asOf = q.to || q.as_of || ymd();
    let from: string, to: string;
    if (q.period) { from = `${q.period}-01`; to = endOfPrevMonth(shiftMonths(`${q.period}-01`, 1)); }
    else if (q.from && q.to) { from = q.from; to = q.to; }
    else { from = monthStartOf(asOf); to = asOf; }
    // prior period = the full previous calendar month; prior year = the same window one year back
    const pp = { from: shiftMonths(from, -1), to: endOfPrevMonth(from) };
    const py = { from: shiftYears(from, -1), to: shiftYears(to, -1) };
    return { cur: { from, to }, pp, py };
  }

  // ── The scorecard pack: every KPI with value + pp/py/budget comparatives + RAG + drill ──
  async pack(q: { as_of?: string; period?: string; from?: string; to?: string; group?: string }, user: JwtUser) {
    const key = `fin-kpi:${user.tenantId}:pack:${JSON.stringify(q)}`;
    return this.cache.wrap(key, this.ttl, () => this.packUncached(q, user));
  }

  private async packUncached(q: { as_of?: string; period?: string; from?: string; to?: string; group?: string }, user: JwtUser) {
    const w = this.windows(q);
    const [cur, pp, py] = await Promise.all([
      this.snapshot(w.cur.from, w.cur.to, true),
      this.snapshot(w.pp.from, w.pp.to, false),
      this.snapshot(w.py.from, w.py.to, false),
    ]);

    // Budget rollup (approved budgets) for the window's fiscal year + month, when a single month is in view.
    const fiscalYear = Number(w.cur.to.slice(0, 4));
    const period = w.cur.from.slice(0, 7) === w.cur.to.slice(0, 7) ? w.cur.from.slice(0, 7) : undefined;
    let budgetRollup: any = null;
    if (this.budget) budgetRollup = await this.budget.budgetVsActual({ fiscal_year: fiscalYear, period }).then((r: any) => r.rollup).catch(() => null);
    const budgetNetMargin = budgetRollup && num(budgetRollup.revenue?.budget) ? round2((num(budgetRollup.net?.budget) / num(budgetRollup.revenue.budget)) * 100) : null;

    const drillHref = (m: MetricDef): string => {
      if (m.group === 'receivables_payables') return '/finance';
      return '/financial-statements';
    };
    const toRow = (m: MetricDef) => {
      const value = m.compute(cur);
      const prior = m.compute(pp);
      const priorYear = m.compute(py);
      const budget = m.id === 'net_margin_pct' ? budgetNetMargin : null;
      return {
        id: m.id, group: m.group, label: m.label, label_en: m.labelEn, unit: m.unit,
        value, prior_period: prior, prior_year: priorYear, budget, forecast: null,
        delta_pp: value != null && prior != null ? round2(value - prior) : null,
        delta_yoy: value != null && priorYear != null ? round2(value - priorYear) : null,
        delta_pp_pct: pctChange(value, prior),
        delta_yoy_pct: pctChange(value, priorYear),
        vs_budget_pct: pctChange(value, budget),
        rag: ragOf(m.rag, value),
        drill: { accounts: m.drill ?? [], href: drillHref(m) },
      };
    };

    // Registry metrics + the cross-snapshot growth metrics, spliced into the growth_cash group.
    const rows = METRICS.map(toRow);
    for (const g of GROWTH_METRICS) {
      const value = g.id === 'revenue_growth_mom_pct' ? pctChange(cur.revenue, pp.revenue) : pctChange(cur.revenue, py.revenue);
      rows.push({
        id: g.id, group: 'growth_cash', label: g.label, label_en: g.labelEn, unit: 'pct',
        value, prior_period: null, prior_year: null, budget: null, forecast: null,
        delta_pp: null, delta_yoy: null, delta_pp_pct: null, delta_yoy_pct: null, vs_budget_pct: null,
        rag: ragOf({ good: 'up', green: g.green, amber: g.amber }, value),
        drill: { accounts: [], href: '/financial-statements' },
      });
    }

    // Stable group ordering so the cross-snapshot growth KPIs sit inside the growth_cash block, not after it.
    const groupOrder = new Map<string, number>(METRIC_GROUPS.map((g, i) => [g.id, i] as [string, number]));
    rows.sort((a, b) => (groupOrder.get(a.group) ?? 99) - (groupOrder.get(b.group) ?? 99));
    const filtered = q.group ? rows.filter((r) => r.group === q.group) : rows;
    return {
      as_of: w.cur.to, window: w.cur, compare: { prior_period: w.pp, prior_year: w.py },
      fiscal_year: fiscalYear, period: period ?? null,
      groups: METRIC_GROUPS,
      budget: budgetRollup ? { revenue: budgetRollup.revenue, expense: budgetRollup.expense, net: budgetRollup.net } : null,
      // AI-style MD&A narrative (docs/35 Phase 6) — computed from the FULL KPI set (not the group filter).
      narrative: this.narrate(rows),
      kpis: filtered,
    };
  }

  // ── MD&A narrative (docs/35 Phase 6) ───────────────────────────────────────────────────────────
  // A deterministic, explainable "what changed" commentary over the scorecard: a one-line headline plus
  // bullets for the RAG-red KPIs and the biggest movers. Rule-based (no API key needed) so it is testable
  // and always available; an LLM can enrich it later off the same structured input.
  private narrate(kpis: any[]): { headline_th: string; headline_en: string; bullets: { severity: 'red' | 'amber' | 'info'; th: string; en: string }[] } {
    const by = (id: string) => kpis.find((k) => k.id === id);
    const unitEn = (u: string) => (u === 'pct' ? '%' : u === 'days' ? 'd' : u === 'x' ? '×' : '');
    const fmt = (k: any) => (k?.value == null ? '—' : `${k.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${unitEn(k.unit)}`);
    const reds = kpis.filter((k) => k.rag === 'red');
    const ambers = kpis.filter((k) => k.rag === 'amber');
    const netM = by('net_margin_pct'), revG = by('revenue_growth_mom_pct');

    const hp_en: string[] = [], hp_th: string[] = [];
    if (netM?.value != null) { hp_en.push(`Net margin ${fmt(netM)}`); hp_th.push(`อัตรากำไรสุทธิ ${fmt(netM)}`); }
    if (revG?.value != null) { const s = revG.value >= 0 ? '+' : ''; hp_en.push(`revenue ${s}${revG.value}% MoM`); hp_th.push(`รายได้ ${s}${revG.value}% MoM`); }
    const tail_en = reds.length ? `; ${reds.length} KPI(s) need action` : ambers.length ? `; ${ambers.length} to watch` : '; all KPIs healthy';
    const tail_th = reds.length ? ` · ${reds.length} รายการต้องดูแล` : ambers.length ? ` · ${ambers.length} รายการเฝ้าระวัง` : ' · ตัวชี้วัดปกติทั้งหมด';
    const headline_en = (hp_en.join(', ') || 'Financial KPIs') + tail_en;
    const headline_th = (hp_th.join(' · ') || 'ตัวชี้วัดการเงิน') + tail_th;

    const bullets: { severity: 'red' | 'amber' | 'info'; th: string; en: string }[] = [];
    for (const k of reds.slice(0, 5)) bullets.push({ severity: 'red', en: `${k.label_en} at ${fmt(k)} is past its threshold`, th: `${k.label} ที่ ${fmt(k)} เกินเกณฑ์ที่กำหนด` });
    // biggest movers vs prior period not already flagged red
    const movers = kpis.filter((k) => k.rag !== 'red' && k.delta_pp_pct != null && Math.abs(k.delta_pp_pct) >= 10)
      .sort((a, b) => Math.abs(b.delta_pp_pct) - Math.abs(a.delta_pp_pct)).slice(0, 3);
    for (const k of movers) { const dir = k.delta_pp_pct >= 0 ? '↑' : '↓'; bullets.push({ severity: 'info', en: `${k.label_en} ${dir}${Math.abs(k.delta_pp_pct)}% vs prior period (now ${fmt(k)})`, th: `${k.label} ${dir}${Math.abs(k.delta_pp_pct)}% เทียบงวดก่อน (ปัจจุบัน ${fmt(k)})` }); }
    if (!bullets.length) bullets.push({ severity: 'info', en: 'All KPIs are within their target ranges.', th: 'ตัวชี้วัดทั้งหมดอยู่ในเกณฑ์เป้าหมาย' });
    return { headline_th, headline_en, bullets };
  }

  // ── Single-KPI trend: the metric's value for each of the last N months (sparkline + table) ──
  async trend(id: string, q: { periods?: number; as_of?: string }, user: JwtUser) {
    const m = METRIC_BY_ID[id];
    if (!m) throw new BadRequestException({ code: 'UNKNOWN_METRIC', message: `Unknown metric '${id}'`, messageTh: 'ไม่รู้จักตัวชี้วัดนี้' });
    const periods = Math.min(24, Math.max(2, Number(q.periods ?? 12)));
    const asOf = q.as_of || ymd();
    const key = `fin-kpi:${user.tenantId}:trend:${id}:${periods}:${asOf}`;
    return this.cache.wrap(key, this.ttl, async () => {
      const series: { period: string; value: number | null; rag: string | null }[] = [];
      for (let i = periods - 1; i >= 0; i--) {
        const from = shiftMonths(asOf, -i);
        const isCurrent = i === 0;
        const to = isCurrent ? asOf : endOfPrevMonth(shiftMonths(from, 1));
        const snap = await this.snapshot(from, to, isCurrent);
        const value = m.compute(snap);
        series.push({ period: from.slice(0, 7), value, rag: ragOf(m.rag, value) });
      }
      return { id: m.id, label: m.label, label_en: m.labelEn, unit: m.unit, grain: 'month', series };
    });
  }

  // ── Drill-through: the account-group rows behind one KPI, as of a date (or over the current month) ──
  async drill(id: string, q: { as_of?: string }, user: JwtUser) {
    const m = METRIC_BY_ID[id];
    if (!m) throw new BadRequestException({ code: 'UNKNOWN_METRIC', message: `Unknown metric '${id}'`, messageTh: 'ไม่รู้จักตัวชี้วัดนี้' });
    if (!this.ledger) throw new BadRequestException({ code: 'LEDGER_UNAVAILABLE', message: 'Ledger service not wired' });
    const codes = m.drill ?? [];
    const asOf = q.as_of || ymd();
    const isPnl = codes.some((c) => c.startsWith('4') || c.startsWith('5'));
    let rows: { account_code: string; account_name: string | null; amount: number }[] = [];
    if (isPnl) {
      const is: any = await this.ledger.incomeStatement(monthStartOf(asOf), asOf);
      rows = (is.lines ?? []).filter((l: any) => codes.includes(String(l.account_code)))
        .map((l: any) => ({ account_code: l.account_code, account_name: l.account_name ?? null, amount: round2(num(l.debit) - num(l.credit)) }));
    } else {
      const bs: any = await this.ledger.balanceSheet(asOf);
      rows = (bs.lines ?? []).filter((l: any) => codes.includes(String(l.account_code)))
        .map((l: any) => ({ account_code: l.account_code, account_name: l.account_name ?? null, amount: round2(num(l.balance)) }));
    }
    return { id: m.id, label: m.label, label_en: m.labelEn, as_of: asOf, basis: isPnl ? 'income_statement' : 'balance_sheet', accounts: codes, rows };
  }

  // Finance leg for the exec scorecard (docs/35 §Phase 1): a compact subset of the canonical pack so the
  // BI exec_scorecard reads the SAME numbers as the CFO dashboard (single source of truth).
  async execFinance(user: JwtUser) {
    const pack = await this.pack({}, user);
    const by = (id: string) => pack.kpis.find((k) => k.id === id)?.value ?? null;
    return {
      as_of: pack.as_of,
      net_margin_pct: by('net_margin_pct'), gross_margin_pct: by('gross_margin_pct'),
      current_ratio: by('current_ratio'), dso: by('dso'),
      operating_cash_flow: by('operating_cash_flow'), cash_runway_months: by('cash_runway_months'),
      red_flags: pack.kpis.filter((k) => k.rag === 'red').map((k) => ({ id: k.id, label_en: k.label_en, value: k.value })),
    };
  }

  // ── Controller Close Cockpit (docs/35 Phase 3, GL-22) ──────────────────────────────────────────
  // A single read-only "is the period ready to lock?" surface for the controller: composes the existing
  // detective controls — subledger↔GL tie-out (REC-04), pre-lock readiness (GL-19 + snapshot recon GL-20),
  // the pending maker-checker queue (GOV-01), and the close checklist/state — into one RAG board with a
  // days-to-close metric. Posts nothing; every leg is guarded so a partial harness still returns a board.
  async closeStatus(q: { period?: string }, user: JwtUser) {
    const period = q.period && /^\d{4}-\d{2}$/.test(q.period) ? q.period : ymd().slice(0, 7);
    const key = `fin-kpi:${user.tenantId}:close:${period}`;
    return this.cache.wrap(key, this.ttl, () => this.closeStatusUncached(period));
  }

  private async closeStatusUncached(period: string) {
    const [validate, recon, approvals, closeRun] = await Promise.all([
      this.close ? this.close.validate(period).catch(() => null) : Promise.resolve(null),
      this.finance ? this.finance.reconcileControls().catch(() => null) : Promise.resolve(null),
      this.finance ? this.finance.pendingApprovals({ overdue_days: 3 }).catch(() => null) : Promise.resolve(null),
      this.close ? this.close.status(period).catch(() => null) : Promise.resolve(null), // null ⇒ no close run started yet
    ]);

    // days-to-close: locked ⇒ lock date − period-end; else elapsed since period-end (0 while still in-period)
    const periodEnd = endOfPrevMonth(shiftMonths(`${period}-01`, 1));
    const today = ymd();
    const dayDiff = (a: string, b: string) => Math.round((parseYmd(a).getTime() - parseYmd(b).getTime()) / 86400000);
    const lockedAt = closeRun?.locked_at ? String(closeRun.locked_at).slice(0, 10) : null;
    const daysToClose = lockedAt ? Math.max(0, dayDiff(lockedAt, periodEnd)) : (today > periodEnd ? dayDiff(today, periodEnd) : 0);

    // checklist rollup from the close run's required steps
    const steps = closeRun?.steps ?? [];
    const reqSteps = steps.filter((s: any) => s.required);
    const doneReq = reqSteps.filter((s: any) => s.status === 'done' || s.status === 'completed').length;

    // RAG per pillar
    const overdue = num(approvals?.overdue);
    const rag = {
      tie_out: recon == null ? null : recon.all_reconciled ? 'green' : 'red',
      readiness: validate == null ? null : validate.ready ? 'green' : (validate.blockers?.length ? 'red' : 'amber'),
      approvals: approvals == null ? null : overdue === 0 ? 'green' : overdue >= 5 ? 'red' : 'amber',
    } as Record<string, 'green' | 'amber' | 'red' | null>;
    const worst = (['tie_out', 'readiness', 'approvals'] as const).map((k) => rag[k]);
    const overall: 'green' | 'amber' | 'red' = worst.includes('red') ? 'red' : worst.includes('amber') ? 'amber' : 'green';

    return {
      period, as_of: today, period_end: periodEnd, days_to_close: daysToClose,
      close_run: closeRun ? { status: closeRun.status, locked_at: closeRun.locked_at, locked_by: closeRun.locked_by ?? null, checklist: { done: doneReq, required: reqSteps.length, steps } } : null,
      tie_out: recon ? { all_reconciled: recon.all_reconciled, exceptions: recon.exceptions, lines: recon.lines } : null,
      readiness: validate ? { ready: validate.ready, blockers: validate.blockers, warnings: validate.warnings, checks: validate.checks } : null,
      approvals: approvals ? { count: approvals.count, overdue: approvals.overdue, oldest_age_days: approvals.oldest_age_days, by_type: approvals.by_type, total_amount: approvals.total_amount, items: (approvals.items ?? []).slice(0, 15) } : null,
      rag: { ...rag, overall },
    };
  }

  // ── Treasury / Cash Command (docs/35 Phase 4, TR-01) ───────────────────────────────────────────
  // Read-only liquidity view: the GL cash/bank position (per account + house banks), a 13-week direct cash
  // forecast (open AR inflows − AP outflows by due date), the liquidity KPI subset, and FX exposure by
  // currency. Every balance ties to the trial balance. Posts nothing.
  async cashPosition(q: { weeks?: number }, user: JwtUser) {
    const weeks = Math.max(1, Math.min(26, Math.floor(Number(q.weeks ?? 13)) || 13));
    const key = `fin-kpi:${user.tenantId}:cash:${weeks}`;
    return this.cache.wrap(key, this.ttl, () => this.cashPositionUncached(weeks, user));
  }

  private async cashPositionUncached(weeks: number, user: JwtUser) {
    if (!this.ledger) throw new BadRequestException({ code: 'LEDGER_UNAVAILABLE', message: 'Ledger service not wired' });
    const [forecast, tb, pack, banksRaw, fx] = await Promise.all([
      this.ledger.cashFlowForecast(weeks),
      this.ledger.trialBalance(),
      this.pack({}, user),
      this.db.select().from(bankAccounts),
      this.fxExposure(),
    ]);
    const balByCode = new Map<string, number>((tb.rows ?? []).map((r: any) => [String(r.account_code), num(r.balance)]));
    const nameByCode = new Map<string, string>((tb.rows ?? []).map((r: any) => [String(r.account_code), r.account_name]));

    const cashAccounts = CASH_ACCOUNTS.filter((c) => balByCode.has(c)).map((c) => ({ account_code: c, account_name: nameByCode.get(c) ?? c, balance: round2(balByCode.get(c) ?? 0) }));
    const totalCash = round2(cashAccounts.reduce((a, x) => a + x.balance, 0));

    // House banks — each annotated with the current GL balance of its linked cash account.
    const banks = (banksRaw ?? []).filter((b: any) => String(b.active ?? 'true') !== 'false').map((b: any) => ({
      id: Number(b.id), bank_name: b.bankName, account_no: b.accountNo, gl_account_code: b.glAccountCode,
      currency: b.currency ?? 'THB', gl_balance: round2(balByCode.get(String(b.glAccountCode)) ?? 0),
    }));

    const liquidity = pack.kpis.filter((k) => k.group === 'liquidity');

    return {
      as_of: forecast.as_of, weeks, total_cash: totalCash, cash_accounts: cashAccounts, bank_accounts: banks,
      forecast: {
        opening_cash: forecast.opening_cash, projected_closing_cash: forecast.projected_closing_cash,
        total_expected_inflow: forecast.total_expected_inflow, total_expected_outflow: forecast.total_expected_outflow,
        periods: forecast.periods,
        // lowest projected balance across the horizon + the week it hits — the liquidity trough to watch.
        min_balance: Math.min(...forecast.periods.map((p: any) => p.projected_balance)),
        min_week: forecast.periods.reduce((m: any, p: any) => (p.projected_balance < m.projected_balance ? p : m), forecast.periods[0])?.week ?? 0,
      },
      liquidity, fx_exposure: fx,
    };
  }

  // FX exposure — open AR (receivable) and AP (payable) outstanding by non-THB currency (face amounts).
  private async fxExposure() {
    const arRows = await this.db.select({ currency: arInvoices.currency, out: sql<string>`coalesce(sum(${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)),0)` })
      .from(arInvoices).where(and(ne(arInvoices.status, 'Paid'), ne(arInvoices.currency, 'THB'))).groupBy(arInvoices.currency);
    const apRows = await this.db.select({ currency: apTransactions.currency, out: sql<string>`coalesce(sum(${apTransactions.amount} - coalesce(${apTransactions.paidAmount},0)),0)` })
      .from(apTransactions).where(and(ne(apTransactions.status, 'Paid'), ne(apTransactions.currency, 'THB'))).groupBy(apTransactions.currency);
    const by = new Map<string, { currency: string; receivable: number; payable: number }>();
    for (const r of arRows) { const c = r.currency ?? '—'; const e = by.get(c) ?? { currency: c, receivable: 0, payable: 0 }; e.receivable = round2(num(r.out)); by.set(c, e); }
    for (const r of apRows) { const c = r.currency ?? '—'; const e = by.get(c) ?? { currency: c, receivable: 0, payable: 0 }; e.payable = round2(num(r.out)); by.set(c, e); }
    return [...by.values()].map((e) => ({ ...e, net: round2(e.receivable - e.payable) })).filter((e) => e.receivable !== 0 || e.payable !== 0);
  }

  // ── Segment profitability (docs/35 Phase 5, PCM-lite) ──────────────────────────────────────────
  // Read-only P&L by an accounting dimension that already lives on the postings — branch / cost_center /
  // project — computed straight from the posted GL (revenue/COGS/opex/net + margins per segment, contribution
  // %, and a reconcile to the consolidated P&L). No customer/product here — those are sub-ledger, not GL
  // dimensions (a documented follow-up). Posts nothing.
  async profitability(q: { by?: string; period?: string; from?: string; to?: string }, user: JwtUser) {
    const DIMS = ['branch', 'cost_center', 'project'];
    if (q.by && !DIMS.includes(q.by)) throw new BadRequestException({ code: 'BAD_DIMENSION', message: `by must be one of ${DIMS.join('/')}`, messageTh: 'มิติไม่ถูกต้อง' });
    const by = q.by && DIMS.includes(q.by) ? q.by : 'branch';
    const asOf = q.to || ymd();
    let from: string, to: string;
    if (q.period && /^\d{4}-\d{2}$/.test(q.period)) { from = `${q.period}-01`; to = endOfPrevMonth(shiftMonths(from, 1)); }
    else if (q.from && q.to) { from = q.from; to = q.to; }
    else { from = monthStartOf(asOf); to = asOf; }
    const key = `fin-kpi:${user.tenantId}:prof:${by}:${from}:${to}`;
    return this.cache.wrap(key, this.ttl, () => this.profitabilityUncached(by, from, to));
  }

  private async profitabilityUncached(by: string, from: string, to: string) {
    const dimCol = by === 'branch' ? journalLines.branchId : by === 'cost_center' ? journalLines.costCenterCode : journalLines.projectId;
    const rows = await this.db.select({
      dim: dimCol, account_code: journalLines.accountCode, type: accounts.type,
      net: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}),0)`,
    }).from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .leftJoin(accounts, eq(journalLines.accountCode, accounts.code))
      .where(and(eq(journalEntries.status, 'Posted'), gte(journalEntries.entryDate, from), lte(journalEntries.entryDate, to), inArray(accounts.type, ['Revenue', 'Expense'])))
      .groupBy(dimCol, journalLines.accountCode, accounts.type);

    const seg = new Map<string, { revenue: number; cogs: number; expense: number }>();
    for (const r of rows) {
      const k = r.dim == null || r.dim === '' ? '__unassigned__' : String(r.dim);
      const e = seg.get(k) ?? { revenue: 0, cogs: 0, expense: 0 };
      const net = num(r.net); // debit − credit
      if (r.type === 'Revenue') e.revenue += -net; // revenue is credit-normal
      else { e.expense += net; if (inSet(String(r.account_code), COGS_ACCOUNTS)) e.cogs += net; }
      seg.set(k, e);
    }

    const labels = await this.segmentLabels(by, [...seg.keys()]);
    let segments = [...seg.entries()].map(([k, e]) => {
      const revenue = round2(e.revenue), cogs = round2(e.cogs), expense = round2(e.expense);
      const grossProfit = round2(revenue - cogs), net = round2(revenue - expense), opex = round2(expense - cogs);
      return {
        key: k, label: labels.get(k) ?? (k === '__unassigned__' ? 'Unassigned' : k),
        revenue, cogs, gross_profit: grossProfit, opex, net,
        gross_margin_pct: revenue > 0 ? round2((grossProfit / revenue) * 100) : null,
        net_margin_pct: revenue > 0 ? round2((net / revenue) * 100) : null,
      };
    });
    const totalRevenue = round2(segments.reduce((a, s) => a + s.revenue, 0));
    const totalNet = round2(segments.reduce((a, s) => a + s.net, 0));
    const totalGross = round2(segments.reduce((a, s) => a + s.gross_profit, 0));
    segments = segments.map((s) => ({ ...s, contribution_pct: totalNet !== 0 ? round2((s.net / totalNet) * 100) : null }));
    segments.sort((a, b) => b.net - a.net);

    const is: any = this.ledger ? await this.ledger.incomeStatement(from, to).catch(() => null) : null;
    return {
      by, from, to, segment_count: segments.length, segments,
      totals: { revenue: totalRevenue, gross_profit: totalGross, net: totalNet },
      pl: is ? { revenue: num(is.revenue), net_income: num(is.net_income) } : null,
      reconciled: is ? Math.abs(totalRevenue - num(is.revenue)) < 0.01 && Math.abs(totalNet - num(is.net_income)) < 0.01 : null,
    };
  }

  // Resolve human labels for the dimension keys (best-effort; falls back to the raw key).
  private async segmentLabels(by: string, _keys: string[]): Promise<Map<string, string>> {
    const m = new Map<string, string>();
    try {
      if (by === 'branch') {
        for (const r of await this.db.select({ id: branches.id, code: branches.code, name: branches.name }).from(branches)) m.set(String(r.id), `${r.code} · ${r.name}`);
      } else if (by === 'cost_center') {
        for (const r of await this.db.select({ code: costCenters.code, name: costCenters.name }).from(costCenters)) m.set(String(r.code), `${r.code} · ${r.name}`);
      } else if (by === 'project') {
        for (const r of await this.db.select({ id: projects.id, code: projects.projectCode, name: projects.name }).from(projects)) m.set(String(r.id), `${r.code} · ${r.name}`);
      }
    } catch { /* labels are best-effort; the key stands in */ }
    return m;
  }
}
