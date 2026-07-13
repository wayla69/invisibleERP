import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tillSessions, refundRequests } from '../../database/schema';
import { n } from '../../database/queries';
import { approvalAgeDays as ageDays, type ApprovalQueue, type ApprovalQueueSource, type PendingApprovalItem } from '../../common/approval-queues';

// docs/46 Phase 2 — the payments module's GOV-01 approval queues (discovered by
// ApprovalQueueRegistrarService; moved verbatim out of finance.service.ts pendingApprovals,
// behaviour identical).
@Injectable()
export class PaymentsApprovalQueues implements ApprovalQueueSource {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  approvalQueues(): ApprovalQueue[] {
    return [
      {
        // REV-13 — material till-close cash over/short awaiting a manager's approval.
        source: 'till_variance',
        pending: async () => {
          const items: PendingApprovalItem[] = [];
          for (const t of await this.db.select().from(tillSessions).where(eq(tillSessions.varianceStatus, 'PendingApproval')))
            items.push({ type: 'till_variance', control: 'REV-13', ref: t.sessionNo, label: `เงินสด${n(t.variance) < 0 ? 'ขาด' : 'เกิน'} ${t.sessionNo}`, amount: Math.abs(n(t.variance)), requested_by: t.closedBy ?? null, requested_at: t.closedAt ?? null, age_days: ageDays(t.closedAt) });
          return items;
        },
      },
      {
        // REV-16 — large standalone refunds awaiting approval.
        source: 'refund',
        pending: async () => {
          const items: PendingApprovalItem[] = [];
          for (const r of await this.db.select().from(refundRequests).where(eq(refundRequests.status, 'PendingApproval')))
            items.push({ type: 'refund', control: 'REV-16', ref: `RR-${Number(r.id)}`, label: `คืนเงิน ${r.paymentNo}`, amount: n(r.amount), requested_by: r.requestedBy ?? null, requested_at: r.createdAt ?? null, age_days: ageDays(r.createdAt) });
          return items;
        },
      },
    ];
  }
}
