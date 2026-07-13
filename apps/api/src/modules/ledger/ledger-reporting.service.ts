import { NotFoundException } from '@nestjs/common';
import { sql, eq, and, notInArray, inArray, isNotNull } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { accounts, journalEntries, journalLines, glPeriodBalances, branches, projects, departments } from '../../database/schema';
import { currentTenantStore } from '../../common/tenant-context';
import { n } from '../../database/queries';
import { toMinor4, minorToNumber4 } from '../../common/money';
import { LEADING } from './ledger-constants';

// FIN-7a — dimension filter for TB / account-ledger / income statement. All fields optional; when NONE
// is set the reports keep their original (snapshot / unfiltered) paths byte-identically.
export interface DimensionFilter { projectId?: number; deptId?: number; branchId?: number }

export function round4(x: number): number { return Math.round(x * 10000) / 10000; }

function typeTotal(rows: any[], type: string, side: 'debit' | 'credit'): number {
  return rows.filter((r) => r.account_type === type).reduce((a, r) => a + n(r[side]), 0);
}
// Exact variant over the raw SQL numeric strings, in bigint minor units (docs/27 R1-4 / AUD-ARC-04).
function typeTotalM(rows: any[], type: string, side: 'debit' | 'credit'): bigint {
  return rows.filter((r) => r.account_type === type).reduce((a: bigint, r) => a + toMinor4(r[side]), 0n);
}

// The facade's ledger-existence guard arrives as a callback port (docs/38 pattern) — gaapComparison
// validates both books, and postAdjustment (which stays on the facade) shares the same guard.
export interface LedgerReportingPorts {
  assertLedger(code: string): Promise<any>;
}

// docs/46 Phase 4e cut 1 — GL reporting reads (trial balance, GL-detail drill-down, income statement,
// balance sheet, per-account FS net, GAAP comparison, in-use dimensions) + the CANONICAL aggregateByType
// engine, moved VERBATIM out of ledger.service.ts. A PLAIN class constructed in the LedgerService ctor
// BODY (harnesses construct the facade positionally with (db, docNo)); the facade keeps thin delegators,
// so the public API — and the golden-master-pinned response shapes — are byte-identical. aggregateByType
// and ledgerCond are public here because they also feed the cashflow sub-service (ctor ports) and
// closeYear (LedgerPeriodsService port).
export class LedgerReportingService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly ports: LedgerReportingPorts,
  ) {}

  // SQL predicate selecting the rows that belong to ledger `code` = shared (NULL) OR that ledger's own
  // adjustments. Defaults to the LEADING book so existing (all-NULL) data + callers are unchanged.
  ledgerCond(code?: string | null) {
    const c = code ?? LEADING;
    return sql`(${journalEntries.ledgerCode} IS NULL OR ${journalEntries.ledgerCode} = ${c})`;
  }

  // FIN-7a: true when any project/dept/branch dimension filter is set (undefined/empty ⇒ legacy paths).
  private hasDims(dims?: DimensionFilter): boolean {
    return !!dims && (dims.projectId !== undefined || dims.deptId !== undefined || dims.branchId !== undefined);
  }

  // FIN-7a: typed-builder conditions for the journal_lines dimension columns (never raw sql — the ids come
  // straight from query params; eq() binds them, so there is no injection sink for CodeQL to flag).
  private dimConds(dims?: DimensionFilter): any[] {
    const conds: any[] = [];
    if (dims?.projectId !== undefined) conds.push(eq(journalLines.projectId, dims.projectId));
    if (dims?.deptId !== undefined) conds.push(eq(journalLines.departmentId, dims.deptId));
    if (dims?.branchId !== undefined) conds.push(eq(journalLines.branchId, dims.branchId));
    return conds;
  }

  // ───────────────────── Trial Balance ─────────────────────
  // group journal_lines by account_code (joined to accounts) — Σdebit, Σcredit, balance
  async trialBalance(period?: string, costCenter?: string | null, ledgerCode?: string | null, dims?: DimensionFilter) {
    const db = this.db;
    // FIN-7a: dimension-filtered TB (project/dept/branch) aggregates from the journal LINES — the
    // gl_period_balances snapshot is keyed by cost-center only and cannot answer a project/dept/branch
    // slice. Same semantics as the snapshot path: Posted-only, ledger NULL-or-code, per-period (entries
    // stamp `period` = entry_date 'YYYY-MM', identical to the snapshot key), per-cost-center; RLS scopes
    // the tenant. With no dimension filter the snapshot path below runs unchanged (byte-identical output).
    if (this.hasDims(dims)) {
      const lconds: any[] = [eq(journalEntries.status, 'Posted'), this.ledgerCond(ledgerCode), ...this.dimConds(dims)];
      if (period) lconds.push(eq(journalEntries.period, period));
      if (costCenter === '__UNASSIGNED__') lconds.push(sql`${journalLines.costCenterCode} IS NULL`);
      else if (costCenter) lconds.push(eq(journalLines.costCenterCode, costCenter));
      const lrows = await db
        .select({
          account_code: journalLines.accountCode,
          account_name: accounts.name,
          account_type: accounts.type,
          debit: sql<string>`coalesce(sum(${journalLines.debit}),0)`,
          credit: sql<string>`coalesce(sum(${journalLines.credit}),0)`,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
        .leftJoin(accounts, eq(journalLines.accountCode, accounts.code))
        .where(and(...lconds))
        .groupBy(journalLines.accountCode, accounts.name, accounts.type)
        .orderBy(journalLines.accountCode);
      const lout = lrows.map((r: any) => {
        const debit = round4(n(r.debit));
        const credit = round4(n(r.credit));
        return { account_code: r.account_code, account_name: r.account_name, account_type: r.account_type, debit, credit, balance: round4(debit - credit) };
      });
      const dM = lrows.reduce((a: bigint, r: any) => a + toMinor4(r.debit), 0n);
      const cM = lrows.reduce((a: bigint, r: any) => a + toMinor4(r.credit), 0n);
      return {
        period: period ?? null, cost_center: costCenter ?? null, ledger: ledgerCode ?? LEADING,
        project_id: dims?.projectId ?? null, dept_id: dims?.deptId ?? null, branch_id: dims?.branchId ?? null,
        rows: lout, totals: { debit: minorToNumber4(dM), credit: minorToNumber4(cM), balanced: dM === cM },
      };
    }
    // R1-2 (AUD-ARC-02): read the maintained gl_period_balances snapshot instead of aggregating the full
    // journal_lines table per request. Same filters/semantics: Posted-only (the snapshot holds nothing
    // else), ledger NULL-or-code ('' = NULL in the normalized key), per-period, per-cost-center; RLS
    // scopes tenants exactly as the raw scan did. GL-20 reconciles snapshot↔raw at every close.
    const conds: any[] = [inArray(glPeriodBalances.ledgerCode, ['', ledgerCode ?? LEADING])];
    if (period) conds.push(eq(glPeriodBalances.period, period));
    if (costCenter === '__UNASSIGNED__') conds.push(eq(glPeriodBalances.costCenterCode, ''));
    else if (costCenter) conds.push(eq(glPeriodBalances.costCenterCode, costCenter));
    const rows = await db
      .select({
        account_code: glPeriodBalances.accountCode,
        account_name: accounts.name,
        account_type: accounts.type,
        debit: sql<string>`coalesce(sum(${glPeriodBalances.debit}),0)`,
        credit: sql<string>`coalesce(sum(${glPeriodBalances.credit}),0)`,
      })
      .from(glPeriodBalances)
      .leftJoin(accounts, eq(glPeriodBalances.accountCode, accounts.code))
      .where(and(...conds))
      .groupBy(glPeriodBalances.accountCode, accounts.name, accounts.type)
      .orderBy(glPeriodBalances.accountCode);

    const out = rows.map((r: any) => {
      const debit = round4(n(r.debit));
      const credit = round4(n(r.credit));
      return { account_code: r.account_code, account_name: r.account_name, account_type: r.account_type, debit, credit, balance: round4(debit - credit) };
    });
    // Totals from the raw SQL numeric strings in bigint minor units — exact, order-independent (R1-4).
    const totalDebitM = rows.reduce((a: bigint, r: any) => a + toMinor4(r.debit), 0n);
    const totalCreditM = rows.reduce((a: bigint, r: any) => a + toMinor4(r.credit), 0n);
    return { period: period ?? null, cost_center: costCenter ?? null, ledger: ledgerCode ?? LEADING, rows: out, totals: { debit: minorToNumber4(totalDebitM), credit: minorToNumber4(totalCreditM), balanced: totalDebitM === totalCreditM } };
  }

  // ───────────────────── Account ledger (GL detail / บัญชีแยกประเภทรายบัญชี) ─────────────────────
  // Every POSTED journal line for ONE account over [from,to], in date order, with a running balance struck
  // from the opening balance (Σ debit−credit strictly before `from`). Debit-positive running balance — the
  // classic GL-detail drill-down behind the trial balance. Reads the raw ledger (RLS scopes the tenant).
  async accountLedger(accountCode: string, from?: string | null, to?: string | null, ledgerCode?: string | null, dims?: DimensionFilter) {
    const db = this.db;
    const [account] = await db.select({ code: accounts.code, name: accounts.name, type: accounts.type })
      .from(accounts).where(eq(accounts.code, accountCode)).limit(1);
    if (!account) throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND', message: `Account ${accountCode} not found`, messageTh: `ไม่พบบัญชี ${accountCode}` });

    // FIN-7a: the optional project/dept/branch filter narrows BOTH the opening balance and the lines to
    // the dimension slice (the running/closing balance is then the slice's own, tying to the filtered TB).
    const dconds = this.dimConds(dims);

    // Opening balance = Σ(debit − credit) of POSTED lines on this account strictly before `from`.
    let opening = 0;
    if (from) {
      const [o] = await db
        .select({ net: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}),0)` })
        .from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
        .where(and(eq(journalEntries.status, 'Posted'), eq(journalLines.accountCode, accountCode), this.ledgerCond(ledgerCode), sql`${journalEntries.entryDate} < ${from}`, ...dconds));
      opening = round4(n(o?.net));
    }

    const conds: any[] = [eq(journalEntries.status, 'Posted'), eq(journalLines.accountCode, accountCode), this.ledgerCond(ledgerCode), ...dconds];
    if (from) conds.push(sql`${journalEntries.entryDate} >= ${from}`);
    if (to) conds.push(sql`${journalEntries.entryDate} <= ${to}`);
    const rows = await db
      .select({
        line_id: journalLines.id,
        date: journalEntries.entryDate,
        entry_no: journalEntries.entryNo,
        source: journalEntries.source,
        source_ref: journalEntries.sourceRef,
        memo: sql<string>`coalesce(${journalLines.memo}, ${journalEntries.memo})`,
        cost_center: journalLines.costCenterCode,
        debit: journalLines.debit,
        credit: journalLines.credit,
      })
      .from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(...conds))
      .orderBy(journalEntries.entryDate, journalLines.id);

    let bal = opening, totalDebit = 0, totalCredit = 0;
    const lines = rows.map((r: any) => {
      const debit = round4(n(r.debit)), credit = round4(n(r.credit));
      bal = round4(bal + debit - credit);
      totalDebit = round4(totalDebit + debit);
      totalCredit = round4(totalCredit + credit);
      return { date: r.date, entry_no: r.entry_no, source: r.source, source_ref: r.source_ref, memo: r.memo, cost_center: r.cost_center, debit, credit, balance: bal };
    });
    return {
      account_code: account.code, account_name: account.name, account_type: account.type,
      from: from ?? null, to: to ?? null, ledger: ledgerCode ?? LEADING,
      // FIN-7a: echo the dimension filter ONLY when one was given — the unfiltered response shape stays
      // byte-identical to before (golden-master pinned).
      ...(this.hasDims(dims) ? { project_id: dims?.projectId ?? null, dept_id: dims?.deptId ?? null, branch_id: dims?.branchId ?? null } : {}),
      opening_balance: opening, total_debit: totalDebit, total_credit: totalCredit, closing_balance: bal,
      count: lines.length, lines,
    };
  }

  // ───────────────────── In-use reporting dimensions (FIN-7a) ─────────────────────
  // Distinct dimension values actually carried by journal LINES (RLS scopes the tenant), joined to their
  // masters for display labels — feeds the TB / GL-detail / P&L filter dropdowns. Read-only; a dimension
  // appears only once it has at least one posted/draft line, so the dropdowns never offer an empty slice.
  async listDimensions() {
    const db = this.db;
    const ccRows = await db
      .selectDistinct({ code: journalLines.costCenterCode })
      .from(journalLines)
      .where(isNotNull(journalLines.costCenterCode))
      .orderBy(journalLines.costCenterCode);
    const brRows = await db
      .selectDistinct({ id: journalLines.branchId, code: branches.code, name: branches.name })
      .from(journalLines)
      .leftJoin(branches, eq(journalLines.branchId, branches.id))
      .where(isNotNull(journalLines.branchId))
      .orderBy(journalLines.branchId);
    const pjRows = await db
      .selectDistinct({ id: journalLines.projectId, code: projects.projectCode, name: projects.name })
      .from(journalLines)
      .leftJoin(projects, eq(journalLines.projectId, projects.id))
      .where(isNotNull(journalLines.projectId))
      .orderBy(journalLines.projectId);
    const dpRows = await db
      .selectDistinct({ id: journalLines.departmentId, code: departments.code, name: departments.name })
      .from(journalLines)
      .leftJoin(departments, eq(journalLines.departmentId, departments.id))
      .where(isNotNull(journalLines.departmentId))
      .orderBy(journalLines.departmentId);
    const shape = (r: any) => ({ id: Number(r.id), code: r.code ?? null, name: r.name ?? null });
    return {
      cost_centers: ccRows.map((r: any) => r.code),
      branches: brRows.map(shape),
      projects: pjRows.map(shape),
      departments: dpRows.map(shape),
    };
  }

  // ───────────────────── Income Statement ─────────────────────
  // Revenue − Expense = net income, over [from,to] (entry_date inclusive)
  // excludeSources lets a trailing-twelve-month P&L (finance-metrics TTM basis) pass ['CLOSE'] so a window
  // that crosses a fiscal year-end is not understated by the close-out entries that zero P&L into 3100.
  async incomeStatement(from: string, to: string, costCenter?: string | null, ledgerCode?: string | null, excludeSources?: string[], dims?: DimensionFilter) {
    const db = this.db;
    const rows = await this.aggregateByType(db, from, to, costCenter, ledgerCode, undefined, excludeSources, dims);
    const revenue = round4(typeTotal(rows, 'Revenue', 'credit') - typeTotal(rows, 'Revenue', 'debit'));
    const expense = round4(typeTotal(rows, 'Expense', 'debit') - typeTotal(rows, 'Expense', 'credit'));
    const netIncome = round4(revenue - expense);
    return {
      from, to, cost_center: costCenter ?? null, ledger: ledgerCode ?? LEADING,
      // FIN-7a: dimension-filter echo only when a filter was given (default response unchanged).
      ...(this.hasDims(dims) ? { project_id: dims?.projectId ?? null, dept_id: dims?.deptId ?? null, branch_id: dims?.branchId ?? null } : {}),
      revenue, expense, net_income: netIncome,
      lines: rows.filter((r: any) => r.account_type === 'Revenue' || r.account_type === 'Expense'),
    };
  }

  async incomeStatementByBranch(opts: { from: string; to: string }) {
    const db = this.db;
    const { from, to } = opts;
    const tenantId = currentTenantStore()?.tenantId ?? null;

    const conds: any[] = [
      eq(journalEntries.status, 'Posted'),
      sql`${journalEntries.entryDate} >= ${from}`,
      sql`${journalEntries.entryDate} <= ${to}`,
      inArray(accounts.type, ['Revenue', 'Expense']),
    ];
    if (tenantId !== null) conds.push(eq(journalEntries.tenantId, tenantId));

    const rows = await db
      .select({
        branch_id: journalLines.branchId,
        account_code: journalLines.accountCode,
        type: accounts.type,
        name: accounts.name,
        net: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .leftJoin(accounts, eq(journalLines.accountCode, accounts.code))
      .where(and(...conds))
      .groupBy(journalLines.branchId, journalLines.accountCode, accounts.type, accounts.name)
      .orderBy(journalLines.accountCode);

    const byBranch: Record<string, { revenue: number; expense: number; net: number; lines: any[] }> = {};
    for (const r of rows) {
      const key = r.branch_id?.toString() ?? 'unassigned';
      if (!byBranch[key]) byBranch[key] = { revenue: 0, expense: 0, net: 0, lines: [] };
      const net = Number(r.net ?? 0);
      if (r.type === 'Revenue') byBranch[key].revenue += -net;
      else byBranch[key].expense += net;
      byBranch[key].lines.push({ account: r.account_code, name: r.name, type: r.type, net });
    }

    for (const b of Object.values(byBranch)) {
      b.net = b.revenue - b.expense;
    }

    return { period: { from, to }, branches: byBranch };
  }

  // ───────────────────── Balance Sheet ─────────────────────
  // Assets = Liabilities + Equity + retained net income (as of date, inclusive)
  async balanceSheet(asOf: string, ledgerCode?: string | null) {
    const db = this.db;
    const rows = await this.aggregateByType(db, null, asOf, undefined, ledgerCode);
    // Exact minor-unit arithmetic (docs/27 R1-4): the balanced flag compares bigints, not rounded floats.
    const assetsM = typeTotalM(rows, 'Asset', 'debit') - typeTotalM(rows, 'Asset', 'credit');
    const liabilitiesM = typeTotalM(rows, 'Liability', 'credit') - typeTotalM(rows, 'Liability', 'debit');
    // equity INCLUDES 3100 Retained Earnings (closed-year results carried here by closeYear)
    const equityM = typeTotalM(rows, 'Equity', 'credit') - typeTotalM(rows, 'Equity', 'debit');
    // current UNCLOSED-period P&L still sits in Revenue/Expense (closed years were zeroed into 3100)
    const netIncomeM =
      (typeTotalM(rows, 'Revenue', 'credit') - typeTotalM(rows, 'Revenue', 'debit')) -
      (typeTotalM(rows, 'Expense', 'debit') - typeTotalM(rows, 'Expense', 'credit'));
    // retained_earnings is a DISPLAY sub-total of equity (the 3100 balance) — not added again
    const retainedEarningsM = rows.filter((r: any) => r.account_code === '3100').reduce((a: bigint, r: any) => a + (toMinor4(r.credit) - toMinor4(r.debit)), 0n);
    const liabilitiesEquityM = liabilitiesM + equityM + netIncomeM;
    // Per-account section lines (additive — existing callers read only the totals). Signed by normal balance:
    // Assets are debit-positive; Liabilities/Equity are credit-positive. Current-period P&L stays out of the
    // lines (it is surfaced as the `net_income` sub-total, conventionally shown under equity by the client).
    const lines = rows
      .filter((r: any) => r.account_type === 'Asset' || r.account_type === 'Liability' || r.account_type === 'Equity')
      .map((r: any) => ({
        account_code: r.account_code,
        account_name: r.account_name,
        account_type: r.account_type,
        balance: round4(r.account_type === 'Asset' ? r.debit - r.credit : r.credit - r.debit),
      }))
      .filter((r: any) => Math.abs(r.balance) > 1e-9);
    return {
      as_of: asOf, ledger: ledgerCode ?? LEADING,
      assets: minorToNumber4(assetsM), liabilities: minorToNumber4(liabilitiesM), equity: minorToNumber4(equityM),
      retained_earnings: minorToNumber4(retainedEarningsM), net_income: minorToNumber4(netIncomeM),
      liabilities_plus_equity: minorToNumber4(liabilitiesEquityM),
      balanced: assetsM === liabilitiesEquityM,
      lines,
    };
  }

  // ───────────────────── Per-account signed net (FIN-4 statutory FS builder) ─────────────────────
  // Σ(debit − credit) per account, joined to type/name. `from == null` ⇒ cumulative to `to` (balance-sheet
  // basis); a `from` scopes it to [from,to] (P&L basis). Reuses the CANONICAL aggregateByType engine (Posted
  // only, ledger NULL-or-code, RLS-scoped) so the statutory FS pack never re-derives balances — it is a pure
  // presentation layer over the same numbers the primary statements read. `excludeSources` drops whole
  // entries by source (e.g. ['CLOSE'] for an in-year P&L window that must not include the year-end sweep).
  async perAccountNet(to: string, from?: string | null, ledgerCode?: string | null, excludeSources?: string[]): Promise<{ account_code: string; account_name: string | null; account_type: string | null; debit: number; credit: number; net: number }[]> {
    const rows = await this.aggregateByType(this.db, from ?? null, to, undefined, ledgerCode, undefined, excludeSources);
    return rows.map((r: any) => ({
      account_code: r.account_code,
      account_name: r.account_name,
      account_type: r.account_type,
      debit: round4(n(r.debit)),
      credit: round4(n(r.credit)),
      net: round4(n(r.debit) - n(r.credit)),
    }));
  }

  // ───────────────────── Book-tax difference (ผลต่างทางบัญชี-ภาษี) ─────────────────────
  // Compares two ledgers' P&L over a window — the temporary/permanent differences that feed deferred tax
  // (TAS 12) and the ภ.ง.ด.50 reconciliation. Since shared entries are identical in both books, the
  // difference comes entirely from each ledger's own adjustments.
  async gaapComparison(from: string, to: string, base = LEADING, compare = 'TAX') {
    await this.ports.assertLedger(base);
    await this.ports.assertLedger(compare);
    const b = await this.incomeStatement(from, to, undefined, base);
    const c = await this.incomeStatement(from, to, undefined, compare);
    const pnl = (l: any) => l.account_type === 'Revenue' ? round4(n(l.credit) - n(l.debit)) : round4(n(l.debit) - n(l.credit)); // revenue +, expense as cost +
    const map = new Map<string, any>();
    for (const l of b.lines) map.set(l.account_code, { account_code: l.account_code, account_name: l.account_name, account_type: l.account_type, base: pnl(l), compare: 0 });
    for (const l of c.lines) {
      const e = map.get(l.account_code) ?? { account_code: l.account_code, account_name: l.account_name, account_type: l.account_type, base: 0, compare: 0 };
      e.compare = pnl(l); map.set(l.account_code, e);
    }
    const lines = [...map.values()]
      .map((e) => ({ ...e, difference: round4(e.compare - e.base) }))
      .filter((e) => Math.abs(e.difference) > 1e-9)
      .sort((a, b2) => a.account_code.localeCompare(b2.account_code));
    return {
      from, to, base_ledger: base, compare_ledger: compare,
      base_net_income: b.net_income, compare_net_income: c.net_income,
      difference: round4(c.net_income - b.net_income),
      lines,
    };
  }

  // group Posted journal_lines by account type within optional date window.
  // excludeSources drops whole entries by source (e.g. CLOSE) — used by the cash-flow statement so a
  // year-end closing reclassification doesn't masquerade as P&L/working-capital movement. PUBLIC on this
  // sub-service (it was private on the facade): the cashflow sub-service and LedgerPeriodsService.closeYear
  // consume it via callback ports wired in the LedgerService constructor.
  async aggregateByType(db: any, from: string | null, to: string, costCenter?: string | null, ledgerCode?: string | null, tenantId?: number | null, excludeSources?: string[], dims?: DimensionFilter) {
    const conds = [eq(journalEntries.status, 'Posted'), sql`${journalEntries.entryDate} <= ${to}`, this.ledgerCond(ledgerCode)];
    if (from) conds.push(sql`${journalEntries.entryDate} >= ${from}`);
    // Explicit tenant scope for writes like closeYear (which may run under HQ/bypass where RLS won't narrow).
    if (tenantId !== undefined && tenantId !== null) conds.push(eq(journalEntries.tenantId, tenantId));
    if (excludeSources && excludeSources.length) conds.push(notInArray(journalEntries.source, excludeSources));
    if (costCenter === '__UNASSIGNED__') conds.push(sql`${journalLines.costCenterCode} IS NULL`);
    else if (costCenter) conds.push(eq(journalLines.costCenterCode, costCenter));
    conds.push(...this.dimConds(dims)); // FIN-7a: project/dept/branch line-dimension filter (no-op when unset)
    const rows = await db
      .select({
        account_type: accounts.type,
        account_code: journalLines.accountCode,
        account_name: accounts.name,
        debit: sql<string>`coalesce(sum(${journalLines.debit}),0)`,
        credit: sql<string>`coalesce(sum(${journalLines.credit}),0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .leftJoin(accounts, eq(journalLines.accountCode, accounts.code))
      .where(and(...conds))
      .groupBy(accounts.type, journalLines.accountCode, accounts.name)
      .orderBy(journalLines.accountCode);
    return rows.map((r: any) => ({
      account_type: r.account_type, account_code: r.account_code, account_name: r.account_name,
      debit: round4(n(r.debit)), credit: round4(n(r.credit)),
    }));
  }
}
