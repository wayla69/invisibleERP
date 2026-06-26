import { Inject, Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { budgets, journalLines, journalEntries, accounts } from '../../database/schema';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;
const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
// split an annual amount into 12 monthly amounts; December absorbs the remainder so the 12 sum back exactly.
function splitAnnual(annual: number): number[] {
  const per = Math.floor((annual / 12) * 10000) / 10000;
  const months = Array(12).fill(per);
  months[11] = round4(annual - per * 11);
  return months;
}
// signed actual by natural balance: Revenue/Liability/Equity = credit-debit; Expense/Asset = debit-credit
const signedActual = (type: string, debit: number, credit: number) => (type === 'Revenue' || type === 'Liability' || type === 'Equity') ? round4(credit - debit) : round4(debit - credit);

export interface UpsertBudgetDto { fiscal_year: number; account_code: string; cost_center_code?: string | null; mode: 'annual' | 'monthly'; period?: string; amount: number; notes?: string; tenantId?: number | null; createdBy: string }

@Injectable()
export class BudgetService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // BUD-01 maker-checker: an upserted budget lands as PendingApproval and is EXCLUDED from budget-vs-actual until
  // a DIFFERENT user approves it (a wrong budget can no longer silently drive the variance/performance report).
  async upsertBudget(dto: UpsertBudgetDto) {
    const db = this.db as any;
    const cc = dto.cost_center_code ?? null;
    const tenantId = dto.tenantId ?? null;
    const rows = dto.mode === 'annual'
      ? splitAnnual(dto.amount).map((amt, i) => ({ period: `${dto.fiscal_year}-${String(i + 1).padStart(2, '0')}`, amount: amt }))
      : [{ period: dto.period!, amount: dto.amount }];
    const ccCond = cc != null ? eq(budgets.costCenterCode, cc) : isNull(budgets.costCenterCode);
    const tCond = tenantId != null ? eq(budgets.tenantId, tenantId) : isNull(budgets.tenantId);
    await db.transaction(async (tx: any) => {
      for (const r of rows) {
        await tx.delete(budgets).where(and(tCond, eq(budgets.fiscalYear, dto.fiscal_year), eq(budgets.accountCode, dto.account_code), ccCond, eq(budgets.period, r.period)));
        await tx.insert(budgets).values({ tenantId, fiscalYear: dto.fiscal_year, accountCode: dto.account_code, costCenterCode: cc, period: r.period, amount: fx(r.amount, 4), notes: dto.notes ?? null, status: 'PendingApproval', requestedBy: dto.createdBy, createdBy: dto.createdBy });
      }
    });
    return { fiscal_year: dto.fiscal_year, account_code: dto.account_code, cost_center_code: cc, lines: rows.length, total: round4(rows.reduce((a, x) => a + x.amount, 0)), status: 'PendingApproval' };
  }

  // Approve (or reject) a pending budget for (fiscal_year, account_code, [cost_center], [period]). Approver ≠
  // requester, binds even Admin. Approval makes it count in budget-vs-actual; reject marks it Rejected (excluded).
  private async decideBudget(decision: 'Approved' | 'Rejected', q: { fiscal_year: number; account_code: string; cost_center_code?: string | null; period?: string; tenantId?: number | null }, user: JwtUser) {
    const db = this.db as any;
    const tenantId = q.tenantId ?? null;
    const conds: any[] = [eq(budgets.fiscalYear, q.fiscal_year), eq(budgets.accountCode, q.account_code), eq(budgets.status, 'PendingApproval')];
    conds.push(tenantId != null ? eq(budgets.tenantId, tenantId) : isNull(budgets.tenantId));
    conds.push(q.cost_center_code != null ? eq(budgets.costCenterCode, q.cost_center_code) : isNull(budgets.costCenterCode));
    if (q.period) conds.push(eq(budgets.period, q.period));
    const pending = await db.select().from(budgets).where(and(...conds));
    if (!pending.length) throw new BadRequestException({ code: 'NO_PENDING_BUDGET', message: 'No budget pending approval for this selection', messageTh: 'ไม่พบงบประมาณที่รออนุมัติ' });
    if (decision === 'Approved' && pending.some((r: any) => r.requestedBy && r.requestedBy === user.username)) {
      throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve a budget you prepared', messageTh: 'ผู้บันทึกอนุมัติงบประมาณของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    await db.update(budgets).set({ status: decision, approvedBy: user.username, approvedAt: new Date() }).where(and(...conds));
    return { fiscal_year: q.fiscal_year, account_code: q.account_code, cost_center_code: q.cost_center_code ?? null, period: q.period ?? null, lines: pending.length, status: decision, approved_by: user.username, requested_by: pending[0]?.requestedBy ?? null };
  }
  async approveBudget(q: { fiscal_year: number; account_code: string; cost_center_code?: string | null; period?: string; tenantId?: number | null }, user: JwtUser) { return this.decideBudget('Approved', q, user); }
  async rejectBudget(q: { fiscal_year: number; account_code: string; cost_center_code?: string | null; period?: string; tenantId?: number | null }, user: JwtUser) { return this.decideBudget('Rejected', q, user); }

  async listBudgets(q: { fiscal_year?: number; account_code?: string; cost_center_code?: string; status?: string }) {
    const db = this.db as any;
    const conds: any[] = [];
    if (q.fiscal_year) conds.push(eq(budgets.fiscalYear, q.fiscal_year));
    if (q.account_code) conds.push(eq(budgets.accountCode, q.account_code));
    if (q.cost_center_code) conds.push(eq(budgets.costCenterCode, q.cost_center_code));
    if (q.status) conds.push(eq(budgets.status, q.status));
    const rows = await db.select().from(budgets).where(conds.length ? and(...conds) : undefined).orderBy(budgets.accountCode, budgets.period);
    return { budgets: rows.map((r: any) => ({ fiscal_year: r.fiscalYear, account_code: r.accountCode, cost_center_code: r.costCenterCode, period: r.period, amount: n(r.amount), status: r.status, requested_by: r.requestedBy, approved_by: r.approvedBy })), count: rows.length, total: round4(rows.reduce((a: number, r: any) => a + n(r.amount), 0)) };
  }

  async deleteBudget(q: { fiscal_year: number; account_code: string; cost_center_code?: string | null; period?: string }) {
    const db = this.db as any;
    const conds: any[] = [eq(budgets.fiscalYear, q.fiscal_year), eq(budgets.accountCode, q.account_code)];
    if (q.cost_center_code != null) conds.push(eq(budgets.costCenterCode, q.cost_center_code));
    if (q.period) conds.push(eq(budgets.period, q.period));
    const res = await db.delete(budgets).where(and(...conds)).returning({ id: budgets.id });
    return { deleted: res.length };
  }

  // budget vs actual: actuals read from the GL (Posted journal lines), budgets summed; variance + favorability
  async budgetVsActual(q: { fiscal_year: number; period?: string; cost_center?: string }) {
    const db = this.db as any;
    const periodCond = q.period
      ? sql`${journalEntries.period} = ${q.period}`
      : and(sql`${journalEntries.entryDate} >= ${`${q.fiscal_year}-01-01`}`, sql`${journalEntries.entryDate} <= ${`${q.fiscal_year}-12-31`}`);
    const actConds = [eq(journalEntries.status, 'Posted'), periodCond];
    if (q.cost_center) actConds.push(eq(journalLines.costCenterCode, q.cost_center));
    const actualRows = await db.select({ account_code: journalLines.accountCode, account_name: accounts.name, account_type: accounts.type, debit: sql<string>`coalesce(sum(${journalLines.debit}),0)`, credit: sql<string>`coalesce(sum(${journalLines.credit}),0)` })
      .from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id)).leftJoin(accounts, eq(journalLines.accountCode, accounts.code))
      .where(and(...actConds)).groupBy(journalLines.accountCode, accounts.name, accounts.type);

    // BUD-01: only APPROVED budgets count toward the variance report (PendingApproval/Rejected excluded).
    const budConds = [eq(budgets.fiscalYear, q.fiscal_year), eq(budgets.status, 'Approved')];
    if (q.period) budConds.push(eq(budgets.period, q.period));
    if (q.cost_center) budConds.push(eq(budgets.costCenterCode, q.cost_center));
    const budgetRows = await db.select({ account_code: budgets.accountCode, amount: sql<string>`coalesce(sum(${budgets.amount}),0)` }).from(budgets).where(and(...budConds)).groupBy(budgets.accountCode);

    const budgetMap = new Map<string, number>(budgetRows.map((b: any) => [b.account_code, round4(n(b.amount))]));
    const actMap = new Map<string, any>(actualRows.map((a: any) => [a.account_code, a]));
    const codes = new Set<string>([...budgetMap.keys(), ...actMap.keys()]);
    const rows: any[] = [];
    for (const code of [...codes].sort()) {
      const a = actMap.get(code);
      const type = a?.account_type ?? null;
      const actual = a ? signedActual(type, n(a.debit), n(a.credit)) : 0;
      const budget = budgetMap.get(code) ?? 0;
      const variance = round4(actual - budget);
      const variancePct = budget !== 0 ? round2((variance / Math.abs(budget)) * 100) : null;
      const isRevenueLike = type === 'Revenue' || type === 'Equity' || type === 'Liability';
      const favorable = isRevenueLike ? actual >= budget : actual <= budget;
      rows.push({ account_code: code, account_name: a?.account_name ?? null, account_type: type, budget, actual, variance, variance_pct: variancePct, favorable, status: variance === 0 ? 'On Budget' : favorable ? 'Favorable' : 'Unfavorable' });
    }
    const sumBy = (pred: (r: any) => boolean, k: string) => round4(rows.filter(pred).reduce((s, r) => s + r[k], 0));
    const rev = { budget: sumBy((r) => r.account_type === 'Revenue', 'budget'), actual: sumBy((r) => r.account_type === 'Revenue', 'actual') };
    const exp = { budget: sumBy((r) => r.account_type === 'Expense', 'budget'), actual: sumBy((r) => r.account_type === 'Expense', 'actual') };
    const net = { budget: round4(rev.budget - exp.budget), actual: round4(rev.actual - exp.actual) };
    return {
      fiscal_year: q.fiscal_year, period: q.period ?? null, cost_center: q.cost_center ?? null, rows,
      rollup: {
        revenue: { ...rev, variance: round4(rev.actual - rev.budget), favorable: rev.actual >= rev.budget },
        expense: { ...exp, variance: round4(exp.actual - exp.budget), favorable: exp.actual <= exp.budget },
        net: { ...net, variance: round4(net.actual - net.budget), favorable: net.actual >= net.budget },
      },
    };
  }
}
