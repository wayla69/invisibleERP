import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { scmOrderPlans } from '../../database/schema';
import { n } from '../../database/queries';
import {
  approvalAgeDays, type ApprovalQueue, type ApprovalQueueSource, type PendingApprovalItem,
} from '../../common/approval-queues';
import { PLAN_STATUS } from './scm-planning.types';

// docs/54 — surfaces order plans awaiting approval in the GOV-01 pending-approvals centre.
// Discovered at boot by ApprovalQueueRegistrarService (no module edge needed), which is why a new
// maker-checker queue belongs in its OWNING module rather than as another query in finance.service.

@Injectable()
export class ScmApprovalQueues implements ApprovalQueueSource {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  approvalQueues(): ApprovalQueue[] {
    return [{
      source: 'scm_order_plan',
      pending: async (): Promise<PendingApprovalItem[]> => {
        // RLS scopes the read to the caller's tenant.
        const rows = await this.db.select().from(scmOrderPlans)
          .where(eq(scmOrderPlans.status, PLAN_STATUS.pending));
        return rows.map((p) => ({
          type: 'scm_order_plan',
          control: 'SCM-01',
          ref: p.planNo,
          label: `แผนสั่งซื้อวัตถุดิบ ${p.planNo}${p.branchId != null ? ` (สาขา ${p.branchId})` : ''}`,
          amount: n(p.estTotalCost),
          requested_by: p.submittedBy ?? p.createdBy,
          requested_at: p.submittedAt ?? p.createdAt,
          age_days: approvalAgeDays(p.submittedAt ?? p.createdAt),
        }));
      },
    }];
  }
}
