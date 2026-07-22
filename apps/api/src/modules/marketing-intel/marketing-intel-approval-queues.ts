import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { miAnalyticsSnapshots } from '../../database/schema';
import { approvalAgeDays as ageDays, type ApprovalQueue, type ApprovalQueueSource, type PendingApprovalItem } from '../../common/approval-queues';

// docs/60 Phase 4 (MKT-20) — the marketing-intel module's GOV-01 approval queue: analytics runs awaiting a
// second-person approval before they can drive spend/contact (governed tenants only). Discovered at boot by
// ApprovalQueueRegistrarService; a drift-blocked run is highlighted in its label. No inline query in
// finance.service.ts (the check-service-size ratchet enforces this pattern).
@Injectable()
export class MarketingIntelApprovalQueues implements ApprovalQueueSource {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  approvalQueues(): ApprovalQueue[] {
    return [
      {
        source: 'mi_analytics_run',
        pending: async () => {
          const rows = await this.db.select({ id: miAnalyticsSnapshots.id, kind: miAnalyticsSnapshots.kind, modelRunRef: miAnalyticsSnapshots.modelRunRef, quality: miAnalyticsSnapshots.quality, pushedBy: miAnalyticsSnapshots.pushedBy, pushedAt: miAnalyticsSnapshots.pushedAt })
            .from(miAnalyticsSnapshots)
            .where(and(eq(miAnalyticsSnapshots.status, 'Pending')));
          return rows.map((r): PendingApprovalItem => {
            const drift = (r.quality as { blocked?: boolean } | null)?.blocked === true;
            return {
              type: 'mi_analytics_run',
              control: 'MKT-20',
              ref: r.id,
              label: `ผลวิเคราะห์ ${r.kind.toUpperCase()}${r.modelRunRef ? ` ${r.modelRunRef}` : ''}${drift ? ' ⚠ drift' : ''}`,
              amount: 0,
              requested_by: r.pushedBy ?? null,
              requested_at: r.pushedAt ?? null,
              age_days: ageDays(r.pushedAt),
            };
          });
        },
      },
    ];
  }
}
