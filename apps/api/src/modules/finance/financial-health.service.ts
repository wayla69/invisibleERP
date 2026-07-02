import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql, and, gte, lte, ne } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { arInvoices, apTransactions, custPosSales } from '../../database/schema';
import { n, ymd } from '../../database/queries';
import { LedgerService } from '../ledger/ledger.service';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const r1 = (x: number) => Math.round((Number(x) || 0) * 10) / 10;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const shiftYmd = (d: string, days: number): string => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10); };

const CASH_ACCOUNTS = new Set(['1000', '1010', '1020']); // cash/bank GL codes → "cash on hand"
const POS_RUN_RATE_DAYS = 28;

// Working-capital **health score** for a merchant — a single, explainable read (0–100, A–E) of how
// comfortable the business's liquidity is, from real sub-ledgers: cash on hand (GL), AR vs AP, overdue
// receivables, and the POS run-rate. This complements the week-by-week cash-flow *projection* in the
// ledger module (`/api/ledger/cash-flow-forecast`); here we score the position, not re-forecast it.
// Read-only; no GL impact. (The basis a financing partner would underwrite against.)
@Injectable()
export class FinancialHealthService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, @Optional() private readonly ledger?: LedgerService) {}

  async score(_user: JwtUser) {
    const db = this.db;
    const today = ymd();

    // cash on hand = posted balance of the cash/bank GL accounts (debit − credit)
    let cash = 0;
    if (this.ledger) {
      const tb = await this.ledger.trialBalance();
      cash = r2((tb.rows ?? []).filter((r: any) => CASH_ACCOUNTS.has(String(r.account_code))).reduce((a: number, r: any) => a + n(r.balance), 0));
    }

    // outstanding AR (with overdue split) and AP
    const arRows = await db.select({ due: arInvoices.dueDate, out: sql<string>`${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)` })
      .from(arInvoices).where(sql`${arInvoices.status}::text <> 'Paid'`);
    const apRows = await db.select({ out: sql<string>`${apTransactions.amount} - coalesce(${apTransactions.paidAmount},0)` })
      .from(apTransactions).where(sql`${apTransactions.status}::text <> 'Paid'`);
    const arOut = r2(arRows.reduce((a: number, r: any) => a + Math.max(0, n(r.out)), 0));
    const overdueAr = r2(arRows.filter((r: any) => r.due && String(r.due) < today).reduce((a: number, r: any) => a + Math.max(0, n(r.out)), 0));
    const apOut = r2(apRows.reduce((a: number, r: any) => a + Math.max(0, n(r.out)), 0));

    // POS run-rate (immediate cash) — 28-day average daily total
    const [pos] = await db.select({ tot: sql<string>`coalesce(sum(${custPosSales.total}),0)` }).from(custPosSales)
      .where(and(gte(custPosSales.saleDate, shiftYmd(today, -POS_RUN_RATE_DAYS)), lte(custPosSales.saleDate, today), ne(custPosSales.status, 'Voided')));
    const posDaily = r2(n(pos?.tot) / POS_RUN_RATE_DAYS);

    // drivers
    const overduePct = arOut > 0 ? r1((overdueAr / arOut) * 100) : 0;
    const avgDailyOut = r2(apOut / 30 + posDaily * 0.35); // AP spread over a month + a COGS proxy
    const daysCash = avgDailyOut > 0 ? r1(cash / avgDailyOut) : null;
    const currentRatio = apOut > 0 ? r2((cash + arOut) / apOut) : null;

    const liqScore = daysCash == null ? 100 : clamp((daysCash / 60) * 100, 0, 100); // 60+ days cash = full marks
    const arScore = clamp(100 - overduePct, 0, 100);
    const score = Math.round(liqScore * 0.6 + arScore * 0.4);
    const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'E';

    return {
      as_of: today, score, grade,
      cash_on_hand: cash, ar_outstanding: arOut, ap_outstanding: apOut,
      overdue_ar: overdueAr, overdue_ar_pct: overduePct,
      pos_daily_run_rate: posDaily, avg_daily_outflow: avgDailyOut,
      days_cash_on_hand: daysCash, current_ratio: currentRatio,
      drivers: { liquidity: Math.round(liqScore), receivables: Math.round(arScore) },
    };
  }
}
