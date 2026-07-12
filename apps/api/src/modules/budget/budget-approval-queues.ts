import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { budgets } from '../../database/schema';
import { n } from '../../database/queries';
import { approvalAgeDays as ageDays, type ApprovalQueue, type ApprovalQueueSource, type PendingApprovalItem } from '../../common/approval-queues';

const round2 = (x: number) => Math.round(x * 100) / 100;

// docs/46 Phase 2 — the budget module's GOV-01 approval queue (discovered by
// ApprovalQueueRegistrarService; moved verbatim out of finance.service.ts pendingApprovals,
// behaviour identical).
@Injectable()
export class BudgetApprovalQueues implements ApprovalQueueSource {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  approvalQueues(): ApprovalQueue[] {
    return [
      {
        // BUD-01 — budgets awaiting approval (excluded from budget-vs-actual); grouped per fiscal-year/account/cost-centre.
        source: 'budget',
        pending: async () => {
          const items: PendingApprovalItem[] = [];
          for (const b of await this.db.select({ fiscalYear: budgets.fiscalYear, accountCode: budgets.accountCode, costCenterCode: budgets.costCenterCode, requestedBy: sql<string>`max(${budgets.requestedBy})`, total: sql<string>`coalesce(sum(${budgets.amount}),0)`, oldest: sql<string>`min(${budgets.updatedAt})` }).from(budgets).where(eq(budgets.status, 'PendingApproval')).groupBy(budgets.fiscalYear, budgets.accountCode, budgets.costCenterCode))
            items.push({ type: 'budget', control: 'BUD-01', ref: `FY${b.fiscalYear}/${b.accountCode}${b.costCenterCode ? '/' + b.costCenterCode : ''}`, label: `งบประมาณ FY${b.fiscalYear} ${b.accountCode}${b.costCenterCode ? ' @ ' + b.costCenterCode : ''}`, amount: round2(n(b.total)), requested_by: b.requestedBy ?? null, requested_at: b.oldest ?? null, age_days: ageDays(b.oldest) });
          return items;
        },
      },
    ];
  }
}
