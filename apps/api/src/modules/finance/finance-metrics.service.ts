import { Injectable, Optional, BadRequestException } from '@nestjs/common';
import type { JwtUser } from '../../common/decorators';
import { ymd } from '../../database/queries';
import { TtlCache } from '../../common/ttl-cache';
import { LedgerService } from '../ledger/ledger.service';
import { FinanceService } from './finance.service';
import { BudgetService } from '../budget/budget.service';
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
    // @Optional so a partial cutover harness can still construct the service; the full app always wires these.
    @Optional() private readonly ledger?: LedgerService,
    @Optional() private readonly finance?: FinanceService,
    @Optional() private readonly budget?: BudgetService,
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
    for (const l of bs.lines ?? []) {
      const code = String(l.account_code); const bal = num(l.balance);
      if (l.account_type === 'Asset') {
        if (inSet(code, CASH_ACCOUNTS)) cash += bal;
        else if (inSet(code, RECEIVABLE_ACCOUNTS)) receivables += bal;
        else if (inSet(code, INVENTORY_ACCOUNTS)) inventory += bal;
        else if (inSet(code, NONCURRENT_ASSET_ACCOUNTS)) nonCurrentAssets += bal;
        else if (inSet(code, OTHER_CURRENT_ASSET_ACCOUNTS)) otherCurrentAssets += bal;
        else if (code < '1500') otherCurrentAssets += bal; else nonCurrentAssets += bal; // fallback by CoA numbering
      } else if (l.account_type === 'Liability') {
        if (inSet(code, NONCURRENT_LIABILITY_ACCOUNTS)) nonCurrentLiabilities += bal;
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

    const filtered = q.group ? rows.filter((r) => r.group === q.group) : rows;
    return {
      as_of: w.cur.to, window: w.cur, compare: { prior_period: w.pp, prior_year: w.py },
      fiscal_year: fiscalYear, period: period ?? null,
      groups: METRIC_GROUPS,
      budget: budgetRollup ? { revenue: budgetRollup.revenue, expense: budgetRollup.expense, net: budgetRollup.net } : null,
      kpis: filtered,
    };
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
}
