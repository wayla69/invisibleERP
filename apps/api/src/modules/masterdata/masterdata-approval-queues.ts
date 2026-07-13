import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { masterdataImportBatches, masterdataChangeRequests } from '../../database/schema';
import { approvalAgeDays as ageDays, type ApprovalQueue, type ApprovalQueueSource, type PendingApprovalItem } from '../../common/approval-queues';

// docs/46 Phase 2 — master-data's GOV-01 approval queues (discovered by ApprovalQueueRegistrarService;
// moved verbatim out of finance.service.ts pendingApprovals, behaviour identical).
@Injectable()
export class MasterdataApprovalQueues implements ApprovalQueueSource {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  approvalQueues(): ApprovalQueue[] {
    return [
      {
        // MDM-03 — sensitive bulk-import batches staged for a distinct approver (incl. the canonical
        // CoA + posting-rule imports from PR-8).
        source: 'masterdata_import',
        pending: async () => {
          const items: PendingApprovalItem[] = [];
          for (const b of await this.db.select().from(masterdataImportBatches).where(eq(masterdataImportBatches.status, 'PendingApproval')))
            items.push({ type: 'masterdata_import', control: 'MDM-03', ref: b.reqNo, label: `นำเข้า ${b.entityKey} (${Number(b.rowCount)} แถว)`, amount: 0, requested_by: b.requestedBy ?? null, requested_at: b.requestedAt ?? null, age_days: ageDays(b.requestedAt) });
          return items;
        },
      },
      {
        // MDM-01 — sensitive single-field master changes staged for a distinct approver (status is lowercase).
        source: 'masterdata_change',
        pending: async () => {
          const items: PendingApprovalItem[] = [];
          for (const c of await this.db.select().from(masterdataChangeRequests).where(eq(masterdataChangeRequests.status, 'pending')))
            items.push({ type: 'masterdata_change', control: 'MDM-01', ref: c.reqNo, label: `แก้ไข ${c.entityType} #${Number(c.entityId)} · ${c.field}`, amount: 0, requested_by: c.requestedBy ?? null, requested_at: c.requestedAt ?? null, age_days: ageDays(c.requestedAt) });
          return items;
        },
      },
    ];
  }
}
