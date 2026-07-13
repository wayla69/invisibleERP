import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { payruns } from '../../database/schema';
import { n } from '../../database/queries';
import { approvalAgeDays as ageDays, type ApprovalQueue, type ApprovalQueueSource, type PendingApprovalItem } from '../../common/approval-queues';

// docs/46 Phase 2 — payroll's GOV-01 approval queue (discovered by ApprovalQueueRegistrarService;
// moved verbatim out of finance.service.ts pendingApprovals, behaviour identical).
@Injectable()
export class PayrollApprovalQueues implements ApprovalQueueSource {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  approvalQueues(): ApprovalQueue[] {
    return [
      {
        // PAY-03 — payroll runs awaiting approval.
        source: 'payroll',
        pending: async () => {
          const items: PendingApprovalItem[] = [];
          for (const r of await this.db.select().from(payruns).where(eq(payruns.status, 'PendingApproval')))
            items.push({ type: 'payroll', control: 'PAY-03', ref: r.period, label: `เงินเดือนงวด ${r.period} (${Number(r.headcount)} คน)`, amount: n(r.netTotal), requested_by: r.runBy ?? null, requested_at: r.runAt ?? null, age_days: ageDays(r.runAt) });
          return items;
        },
      },
    ];
  }
}
