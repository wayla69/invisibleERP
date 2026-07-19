import { and, eq, gte, lte, ne, notInArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { accounts, journalEntries, journalLines, arInvoices, apTransactions } from '../../database/schema';
import { ymd, n } from '../../database/queries';
import { LEADING, CASH_ACCOUNTS, CF_CLASSIFY, type CfBucket } from './ledger-constants';

// Cash-flow sub-service (docs/38 §3 ledger decomposition, PR-1 — the most self-contained GL cut, GL-07):
// the indirect statement (net income + add-backs + working capital off aggregateByType), the DIRECT
// statement (dominant-contra attribution) and the AR/AP forecast — moved VERBATIM together with their
// private cash-balance helper and the module-level classifiers. A PLAIN class constructed in the
// LedgerService ctor BODY (harnesses construct the facade positionally with (db, docNo)). The two shared
// read helpers stay on the facade and arrive as callback ports: aggregateByType (also feeds
// trialBalance/incomeStatement/balanceSheet/closeYear) and ledgerCond (the multi-ledger scope predicate).
export class LedgerCashflowService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly aggregateByType: (db: any, from: string | null, to: string, costCenter?: string | null, ledgerCode?: string | null, tenantId?: number | null, excludeSources?: string[]) => Promise<any[]>,
    private readonly ledgerCond: (code?: string | null) => any,
  ) {}

  // ───────────────────── Statement of Cash Flows (indirect method) ─────────────────────
  // Reconstructs operating cash from net income + non-cash add-backs + working-capital movements, then
  // investing & financing — all off the posted GL over [from,to]. Year-end CLOSE entries are excluded
  // (they reclassify P&L into retained earnings and carry no cash). Reconciles to the change in the cash
  // accounts (1000/1010/1020) by double-entry construction: Σ(every account's debit−credit)=0, so
  // Σ(non-cash credit−debit) ≡ Σ(cash debit−credit) = net change in cash.
  async cashFlowStatement(from: string, to: string, ledgerCode?: string | null) {
    const db = this.db;
    const rows = await this.aggregateByType(db, from, to, undefined, ledgerCode, undefined, ['CLOSE']);
    const move = (r: any) => round4(n(r.credit) - n(r.debit)); // cash effect of a balance-sheet account's movement

    // Net income over the window = Σ P&L (credit−debit). Equals the income statement on an unclosed window.
    const netIncome = round4(rows.filter((r: any) => r.account_type === 'Revenue' || r.account_type === 'Expense').reduce((a: number, r: any) => a + move(r), 0));

    // docs/43 PR-8: an account's OWN cf_bucket/cf_label columns (0346) win over the hardcoded
    // CF_CLASSIFY map — a newly-created balance-sheet account self-classifies without a code change.
    const acctMeta = new Map<string, { cfBucket: string | null; cfLabel: string | null }>(
      (await db.select({ code: accounts.code, cfBucket: accounts.cfBucket, cfLabel: accounts.cfLabel }).from(accounts))
        .map((a: any) => [a.code, { cfBucket: a.cfBucket ?? null, cfLabel: a.cfLabel ?? null }]),
    );
    const addbacks: any[] = [], operating: any[] = [], investing: any[] = [], financing: any[] = [], unclassified: any[] = [];
    for (const r of rows) {
      const t = r.account_type;
      if (t === 'Revenue' || t === 'Expense') continue;        // already captured in net income
      if (CASH_ACCOUNTS.includes(r.account_code)) continue;    // the cash being explained
      const amount = move(r);
      if (Math.abs(amount) < 1e-9) continue;
      const line = { account_code: r.account_code, account_name: r.account_name, amount };
      const meta = acctMeta.get(r.account_code);
      const cls = meta?.cfBucket
        ? { bucket: meta.cfBucket as CfBucket, label: meta.cfLabel ?? r.account_name ?? r.account_code }
        : CF_CLASSIFY[r.account_code];
      const bucket = cls?.bucket ?? (t === 'Asset' ? 'operating' : t === 'Liability' ? 'operating' : t === 'Equity' ? 'financing' : 'operating');
      const label = cls?.label ?? r.account_name ?? r.account_code;
      const entry = { ...line, label };
      if (bucket === 'addback') addbacks.push(entry);
      else if (bucket === 'investing') investing.push(entry);
      else if (bucket === 'financing') financing.push(entry);
      else operating.push(entry);
      if (!cls) unclassified.push(r.account_code); // surfaced for transparency (still bucketed by type)
    }

    const sum = (xs: any[]) => round4(xs.reduce((a, x) => a + x.amount, 0));
    const netOperating = round4(netIncome + sum(addbacks) + sum(operating));
    const netInvesting = sum(investing);
    const netFinancing = sum(financing);
    const netChange = round4(netOperating + netInvesting + netFinancing);

    // Actual cash balances bracketing the window (full books incl. opening/close — CLOSE never hits cash).
    const cashBeginning = await this.cashBalanceAsOf(prevDay(from), ledgerCode);
    const cashEnding = await this.cashBalanceAsOf(to, ledgerCode);

    return {
      from, to, ledger: ledgerCode ?? LEADING, method: 'indirect',
      operating: { net_income: netIncome, adjustments: addbacks, working_capital: operating, net: netOperating },
      investing: { lines: investing, net: netInvesting },
      financing: { lines: financing, net: netFinancing },
      net_change_in_cash: netChange,
      cash_beginning: cashBeginning,
      cash_ending: cashEnding,
      // Independent tie-out: the activity sections must equal the movement in the cash accounts.
      reconciled: Math.abs(round4(cashEnding - cashBeginning) - netChange) < 0.01,
      unclassified_accounts: [...new Set(unclassified)],
    };
  }

  // Net debit balance of the cash accounts (1000/1010/1020) as of a date, in one ledger.
  private async cashBalanceAsOf(asOf: string, ledgerCode?: string | null): Promise<number> {
    const db = this.db;
    const rows = await this.aggregateByType(db, null, asOf, undefined, ledgerCode);
    return round4(rows.filter((r: any) => CASH_ACCOUNTS.includes(r.account_code)).reduce((a: number, r: any) => a + (n(r.debit) - n(r.credit)), 0));
  }

  // ───────────────────── Statement of Cash Flows (DIRECT method) ─────────────────────
  // Classifies actual cash movements by the nature of their contra account: receipts from customers,
  // payments to suppliers/employees, tax remittances, investing, financing. Each cash journal line is
  // attributed once (to its entry's dominant non-cash leg), so the statement reconciles to Δcash. CLOSE
  // entries are excluded (no cash effect).
  async cashFlowDirect(from: string, to: string, ledgerCode?: string | null) {
    const db = this.db;
    const lines = await db
      .select({
        entry_id: journalLines.entryId, account_code: journalLines.accountCode, account_type: accounts.type,
        debit: journalLines.debit, credit: journalLines.credit,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .leftJoin(accounts, eq(journalLines.accountCode, accounts.code))
      .where(and(eq(journalEntries.status, 'Posted'), gte(journalEntries.entryDate, from), lte(journalEntries.entryDate, to), this.ledgerCond(ledgerCode), notInArray(journalEntries.source, ['CLOSE'])));

    // Group lines by entry; attribute each entry's net cash movement to its dominant contra account.
    const byEntry = new Map<number, any[]>();
    for (const l of lines) { const k = Number(l.entry_id); (byEntry.get(k) ?? byEntry.set(k, []).get(k)!).push(l); }
    const buckets: Record<string, number> = { receipts_from_customers: 0, payments_to_suppliers: 0, tax_and_payroll: 0, other_operating: 0, investing: 0, financing: 0 };
    for (const legs of byEntry.values()) {
      const cashLegs = legs.filter((l) => CASH_ACCOUNTS.includes(l.account_code));
      if (!cashLegs.length) continue;
      const cashNet = round4(cashLegs.reduce((a, l) => a + (n(l.debit) - n(l.credit)), 0));
      if (Math.abs(cashNet) < 1e-9) continue;
      const nonCash = legs.filter((l) => !CASH_ACCOUNTS.includes(l.account_code));
      const dominant = nonCash.sort((a, b) => Math.abs(n(b.debit) - n(b.credit)) - Math.abs(n(a.debit) - n(a.credit)))[0];
      buckets[cashContraCategory(dominant?.account_code, dominant?.account_type)]! += cashNet;
    }
    for (const k of Object.keys(buckets)) buckets[k] = round4(buckets[k]!);
    const operatingNet = round4(buckets.receipts_from_customers! + buckets.payments_to_suppliers! + buckets.tax_and_payroll! + buckets.other_operating!);
    const netChange = round4(operatingNet + buckets.investing! + buckets.financing!);
    const cashBeginning = await this.cashBalanceAsOf(prevDay(from), ledgerCode);
    const cashEnding = await this.cashBalanceAsOf(to, ledgerCode);
    return {
      from, to, ledger: ledgerCode ?? LEADING, method: 'direct',
      operating: {
        receipts_from_customers: buckets.receipts_from_customers,
        payments_to_suppliers: buckets.payments_to_suppliers,
        tax_and_payroll: buckets.tax_and_payroll,
        other_operating: buckets.other_operating,
        net: operatingNet,
      },
      investing: { net: buckets.investing },
      financing: { net: buckets.financing },
      net_change_in_cash: netChange,
      cash_beginning: cashBeginning, cash_ending: cashEnding,
      reconciled: Math.abs(round4(cashEnding - cashBeginning) - netChange) < 0.01,
    };
  }

  // ───────────────────── Cash-flow FORECAST ─────────────────────
  // Projects the cash balance forward from today over N weeks, using open AR (expected inflows by due date)
  // and open AP (expected outflows by due date). Anything already past due lands in week 0 (due now).
  async cashFlowForecast(weeks = 8, ledgerCode?: string | null) {
    const db = this.db;
    const today = ymd();
    const opening = await this.cashBalanceAsOf(today, ledgerCode);
    const ar = await db.select({ due: arInvoices.dueDate, out: sql<string>`${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)` })
      .from(arInvoices).where(ne(arInvoices.status, 'Paid'));
    const ap = await db.select({ due: apTransactions.dueDate, out: sql<string>`${apTransactions.amount} - coalesce(${apTransactions.paidAmount},0)` })
      .from(apTransactions).where(ne(apTransactions.status, 'Paid'));

    const weekIndex = (due: string | null): number => {
      if (!due) return 0;
      const d = Math.floor((Date.parse(due) - Date.parse(today)) / 86400000);
      if (d <= 0) return 0;            // overdue / due now
      const w = Math.floor(d / 7) + 1; // d in 1..7 → week 1
      return Math.min(w, weeks);       // clamp beyond horizon into the last bucket
    };
    const inflow = new Array(weeks + 1).fill(0);
    const outflow = new Array(weeks + 1).fill(0);
    for (const r of ar) { const o = n(r.out); if (o > 0.0001) inflow[weekIndex(r.due)] += o; }
    for (const r of ap) { const o = n(r.out); if (o > 0.0001) outflow[weekIndex(r.due)] += o; }

    let running = opening;
    const periods: { week: number; label: string; inflow: number; outflow: number; net: number; projected_balance: number }[] = [];
    for (let w = 0; w <= weeks; w++) {
      const inn = round4(inflow[w]), out = round4(outflow[w]);
      running = round4(running + inn - out);
      periods.push({ week: w, label: w === 0 ? 'due now / overdue' : `week +${w}`, inflow: inn, outflow: out, net: round4(inn - out), projected_balance: running });
    }
    return {
      as_of: today, ledger: ledgerCode ?? LEADING, weeks, opening_cash: opening,
      total_expected_inflow: round4(inflow.reduce((a, x) => a + x, 0)),
      total_expected_outflow: round4(outflow.reduce((a, x) => a + x, 0)),
      projected_closing_cash: running,
      periods,
    };
  }
}

function round4(x: number): number { return Math.round(x * 10000) / 10000; }

// Direct-method cash-flow category from a cash entry's dominant contra account.
function cashContraCategory(code: string | undefined, type: string | undefined): string {
  const c = code ?? '';
  if (c === '1100' || c === '1150' || type === 'Revenue') return 'receipts_from_customers'; // AR / sales
  if (c === '2100' || c === '2350' || c === '2360' || c === '2370') return 'tax_and_payroll'; // VAT / SSO / WHT / PF payable
  if (c === '1500') return 'investing';                                                       // fixed assets
  if (c.startsWith('3') || type === 'Equity') return 'financing';                             // capital / dividends
  if (c === '2000' || c === '2150' || c.startsWith('12') || type === 'Expense') return 'payments_to_suppliers'; // AP / inventory / expense / wages
  return 'other_operating';
}
// Calendar day before an ISO date (YYYY-MM-DD) — the day the opening cash balance is struck.
function prevDay(ymdStr: string): string {
  const d = new Date(`${ymdStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
