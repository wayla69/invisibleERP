import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { fxRates } from '../../database/schema';
import { n } from '../../database/queries';
import { approvalAgeDays as ageDays, type ApprovalQueue, type ApprovalQueueSource, type PendingApprovalItem } from '../../common/approval-queues';

// docs/46 Phase 2 — the FX module's GOV-01 approval queue (discovered by ApprovalQueueRegistrarService;
// moved verbatim out of finance.service.ts pendingApprovals, behaviour identical).
@Injectable()
export class FxApprovalQueues implements ApprovalQueueSource {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  approvalQueues(): ApprovalQueue[] {
    return [
      {
        // FX-04 — manual FX rates awaiting approval (PendingApproval, unusable until approved; not a JE).
        source: 'fx_rate',
        pending: async () => {
          const items: PendingApprovalItem[] = [];
          for (const r of await this.db.select().from(fxRates).where(eq(fxRates.status, 'PendingApproval')))
            items.push({ type: 'fx_rate', control: 'FX-04', ref: `${r.currency}@${r.rateDate}`, label: `อัตรา ${r.currency} = ${n(r.rate)} (${r.rateDate})`, amount: 0, requested_by: r.requestedBy ?? null, requested_at: r.createdAt ?? null, age_days: ageDays(r.createdAt) });
          return items;
        },
      },
    ];
  }
}
