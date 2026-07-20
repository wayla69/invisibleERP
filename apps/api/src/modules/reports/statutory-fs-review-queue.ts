import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { fsStatementReviews } from '../../database/schema';
import { n } from '../../database/queries';
import { approvalAgeDays as ageDays, type ApprovalQueue, type ApprovalQueueSource, type PendingApprovalItem } from '../../common/approval-queues';

// docs/46 Phase 2 — GL-29 statement-issuance reviews awaiting a DIFFERENT user's approval surface in the
// GOV-01 pending-approvals center (discovered at boot by ApprovalQueueRegistrarService). Tenant scoping is by
// RLS (the aggregator runs in the caller's request context), like the sibling ledger queues.
@Injectable()
export class StatutoryFsReviewQueue implements ApprovalQueueSource {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  approvalQueues(): ApprovalQueue[] {
    const db = this.db;
    return [
      {
        source: 'fs_statement_review',
        pending: async () => {
          const items: PendingApprovalItem[] = [];
          for (const r of await db.select().from(fsStatementReviews).where(eq(fsStatementReviews.status, 'PendingApproval'))) {
            items.push({
              type: 'fs_statement_review', control: 'GL-29', ref: `FSR-${Number(r.id)}`,
              label: `งบการเงินรอสอบทาน ปี ${r.fiscalYear} (${r.ledger})`,
              amount: n(r.totalAssets ?? 0), requested_by: r.preparedBy ?? null,
              requested_at: r.preparedAt ?? null, age_days: ageDays(r.preparedAt),
            });
          }
          return items;
        },
      },
    ];
  }
}
