import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { expenseRequests } from '../../database/schema';
import { n } from '../../database/queries';
import { approvalAgeDays as ageDays, type ApprovalQueue, type ApprovalQueueSource, type PendingApprovalItem } from '../../common/approval-queues';

// docs/46 Phase 2 — petty-cash's GOV-01 approval queue (discovered by ApprovalQueueRegistrarService;
// moved verbatim out of finance.service.ts pendingApprovals, behaviour identical).
@Injectable()
export class PettyCashApprovalQueues implements ApprovalQueueSource {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  approvalQueues(): ApprovalQueue[] {
    return [
      {
        // EXP-08 — petty-cash expense / advance requests awaiting approval.
        source: 'petty_cash',
        pending: async () => {
          const items: PendingApprovalItem[] = [];
          for (const e of await this.db.select().from(expenseRequests).where(eq(expenseRequests.status, 'PendingApproval')))
            items.push({ type: 'petty_cash', control: 'EXP-08', ref: e.reqNo, label: `${e.kind === 'advance' ? 'เงินเบิกล่วงหน้า' : 'ค่าใช้จ่าย'} ${e.payee ?? ''}`.trim(), amount: n(e.amount), requested_by: e.requestedBy ?? null, requested_at: e.requestedAt ?? null, age_days: ageDays(e.requestedAt) });
          return items;
        },
      },
    ];
  }
}
