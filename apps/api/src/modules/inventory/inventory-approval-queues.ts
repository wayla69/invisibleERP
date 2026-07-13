import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { invWriteoffRequests } from '../../database/schema';
import { n } from '../../database/queries';
import { approvalAgeDays as ageDays, type ApprovalQueue, type ApprovalQueueSource, type PendingApprovalItem } from '../../common/approval-queues';

// docs/46 Phase 2 — inventory's GOV-01 approval queue (discovered by ApprovalQueueRegistrarService;
// moved verbatim out of finance.service.ts pendingApprovals, behaviour identical).
@Injectable()
export class InventoryApprovalQueues implements ApprovalQueueSource {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  approvalQueues(): ApprovalQueue[] {
    return [
      {
        // INV-07 — inventory write-offs awaiting approval.
        source: 'inventory_writeoff',
        pending: async () => {
          const items: PendingApprovalItem[] = [];
          for (const w of await this.db.select().from(invWriteoffRequests).where(eq(invWriteoffRequests.status, 'PendingApproval')))
            items.push({ type: 'inventory_writeoff', control: 'INV-07', ref: `WO-${Number(w.id)}`, label: `ตัดสต๊อก ${w.itemId} (${n(w.qtyDelta)})`, amount: n(w.estValue), requested_by: w.requestedBy ?? null, requested_at: w.createdAt ?? null, age_days: ageDays(w.createdAt) });
          return items;
        },
      },
    ];
  }
}
