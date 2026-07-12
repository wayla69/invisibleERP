import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { assetRevaluations, fixedAssets } from '../../database/schema';
import { n } from '../../database/queries';
import { approvalAgeDays as ageDays, type ApprovalQueue, type ApprovalQueueSource, type PendingApprovalItem } from '../../common/approval-queues';

// docs/46 Phase 2 — the asset module's GOV-01 approval queues (discovered by ApprovalQueueRegistrarService;
// moved verbatim out of finance.service.ts pendingApprovals, behaviour identical).
@Injectable()
export class AssetsApprovalQueues implements ApprovalQueueSource {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  approvalQueues(): ApprovalQueue[] {
    return [
      {
        // FA-08 — asset revaluations/impairments awaiting approval.
        source: 'asset_revaluation',
        pending: async () => {
          const items: PendingApprovalItem[] = [];
          for (const v of await this.db.select().from(assetRevaluations).where(eq(assetRevaluations.status, 'PendingApproval')))
            items.push({ type: 'asset_revaluation', control: 'FA-08', ref: v.assetNo, label: `ตีมูลค่า ${v.assetNo} (${v.kind})`, amount: Math.abs(n(v.delta)), requested_by: v.actionedBy ?? null, requested_at: v.createdAt ?? null, age_days: ageDays(v.createdAt) });
          return items;
        },
      },
      {
        // FA-09 — asset disposals awaiting approval (disposed_date is the requested date).
        source: 'asset_disposal',
        pending: async () => {
          const items: PendingApprovalItem[] = [];
          for (const a of await this.db.select().from(fixedAssets).where(eq(fixedAssets.disposalPending, true)))
            items.push({ type: 'asset_disposal', control: 'FA-09', ref: a.assetNo, label: `จำหน่าย ${a.assetNo}`, amount: a.disposalProceeds != null ? n(a.disposalProceeds) : 0, requested_by: a.disposalRequestedBy ?? null, requested_at: a.disposedDate ?? null, age_days: ageDays(a.disposedDate) });
          return items;
        },
      },
    ];
  }
}
