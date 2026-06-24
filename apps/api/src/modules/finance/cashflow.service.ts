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

// Cash-account GL codes whose posted balance is "cash on hand" (the forecast's opening position).
const CASH_ACCOUNTS = new Set(['1000', '1010', '1020']);
const POS_RUN_RATE_DAYS = 28;

// Merchant cash-flow forecast + working-capital health score. Projects the cash position week-by-week from
// real sub-ledgers a pure POS can't see — opening cash (GL), AR collections + AP payments (by due date), and
// the POS sales run-rate — to surface an upcoming shortfall *before* it bites, and scores financial health
// from the same data (the basis a financing partner would underwrite against). Read-only; no GL impact.
@Injectable()
export class CashflowService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, @Optional() private readonly ledger?: LedgerService) {}

  async forecast(_user: JwtUser, opts?: { weeks?: number }) {
    const db = this.db as any;
    const weeks = clamp(Math.floor(opts?.weeks ?? 8), 1, 26);
    const today = ymd();
    const horizonDays = weeks * 7;

    // opening cash = posted balance of the cash/bank GL accounts (debit − credit)
    let opening = 0;
    if (this.ledger) {
      const tb = await this.ledger.trialBalance();
      opening = r2((tb.rows ?? []).filter((r: any) => CASH_ACCOUNTS.has(String(r.account_code))).reduce((a: number, r: any) => a + n(r.balance), 0));
    }

    // outstanding AR (expected inflows) and AP (scheduled outflows), each with a due date
    const arRows = await db.select({ due: arInvoices.dueDate, out: sql<string>`${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)` })
      .from(arInvoices).where(sql`${arInvoices.status}::text <> 'Paid'`);
    const apRows = await db.select({ due: apTransactions.dueDate, out: sql<string>`${apTransactions.amount} - coalesce(${apTransactions.paidAmount},0)` })
      .from(apTransactions).where(sql`${apTransactions.status}::text <> 'Paid'`);
    const ar = arRows.map((r: any) => ({ due: r.due ? String(r.due) : today, out: n(r.out) })).filter((r: any) => r.out > 0.001);
    const ap = apRows.map((r: any) => ({ due: r.due ? String(r.due) : today, out: n(r.out) })).filter((r: any) => r.out > 0.001);

    // POS sales run-rate (immediate cash) — average daily total over the last 28 completed days
    const [pos] = await db.select({ tot: sql<string>`coalesce(sum(${custPosSales.total}),0)` }).from(custPosSales)
      .where(and(gte(custPosSales.saleDate, shiftYmd(today, -POS_RUN_RATE_DAYS)), lte(custPosSales.saleDate, today), ne(custPosSales.status, 'Voided')));
    const posDaily = r2(n(pos?.tot) / POS_RUN_RATE_DAYS);

    // week-by-week projection (overdue AR/AP fall into week 1 — collect/pay now)
    const weekly: any[] = [];
    let running = opening;
    let totAr = 0, totAp = 0, totPos = 0;
    for (let w = 0; w < weeks; w++) {
      const ws = shiftYmd(today, w * 7), we = shiftYmd(today, w * 7 + 6);
      const inWeek = (due: string) => (w === 0 ? due <= we : due >= ws && due <= we);
      const arIn = r2(ar.filter((r: any) => inWeek(r.due)).reduce((a: number, r: any) => a + r.out, 0));
      const apOut = r2(ap.filter((r: any) => inWeek(r.due)).reduce((a: number, r: any) => a + r.out, 0));
      const posIn = r2(posDaily * 7);
      const net = r2(arIn + posIn - apOut);
      running = r2(running + net);
      totAr += arIn; totAp += apOut; totPos += posIn;
      weekly.push({ week: w + 1, week_start: ws, ar_inflow: arIn, pos_inflow: posIn, ap_outflow: apOut, net, projected_balance: running });
    }
    const minBal = r2(Math.min(opening, ...weekly.map((x) => x.projected_balance)));
    const shortfall = weekly.find((x) => x.projected_balance < 0) ?? null;

    return {
      as_of: today, opening_cash: opening, pos_daily_run_rate: posDaily, horizon_weeks: weeks,
      summary: {
        min_projected_balance: minBal,
        first_shortfall_week: shortfall ? shortfall.week : null,
        first_shortfall_date: shortfall ? shortfall.week_start : null,
        projected_ar_inflow: r2(totAr), projected_pos_inflow: r2(totPos), scheduled_ap_outflow: r2(totAp),
        closing_balance: weekly.length ? weekly[weekly.length - 1].projected_balance : opening,
      },
      weekly,
      health: this.healthScore({ opening, ar, ap, totAp, horizonDays, minBal, today, posDaily }),
    };
  }

  // Transparent working-capital health score (0–100, A–E) from the same data — the financial-health read a
  // lender would underwrite against. Each driver is exposed so the score is explainable, not a black box.
  private healthScore(p: { opening: number; ar: any[]; ap: any[]; totAp: number; horizonDays: number; minBal: number; today: string; posDaily: number }) {
    const totArOut = r2(p.ar.reduce((a, r) => a + r.out, 0));
    const totApOut = r2(p.ap.reduce((a, r) => a + r.out, 0));
    const overdueAr = r2(p.ar.filter((r) => r.due < p.today).reduce((a, r) => a + r.out, 0));
    const overduePct = totArOut > 0 ? r1((overdueAr / totArOut) * 100) : 0;
    // daily outflow ≈ scheduled AP over the horizon + a COGS proxy (~35% of POS sales)
    const avgDailyOut = r2(p.totAp / p.horizonDays + p.posDaily * 0.35);
    const daysCash = avgDailyOut > 0 ? r1(p.opening / avgDailyOut) : null;
    const currentRatio = totApOut > 0 ? r2((p.opening + totArOut) / totApOut) : null;

    const liqScore = daysCash == null ? 100 : clamp((daysCash / 60) * 100, 0, 100);          // 60+ days cash = full marks
    const shortScore = p.minBal >= 0 ? 100 : clamp(100 - (-p.minBal / Math.max(1, p.opening)) * 100, 0, 100);
    const arScore = clamp(100 - overduePct, 0, 100);
    const score = Math.round(liqScore * 0.4 + shortScore * 0.35 + arScore * 0.25);
    const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'E';
    return {
      score, grade,
      days_cash_on_hand: daysCash, current_ratio: currentRatio, overdue_ar_pct: overduePct,
      ar_outstanding: totArOut, ap_outstanding: totApOut,
      drivers: { liquidity: Math.round(liqScore), shortfall_risk: Math.round(shortScore), receivables: Math.round(arScore) },
    };
  }
}
