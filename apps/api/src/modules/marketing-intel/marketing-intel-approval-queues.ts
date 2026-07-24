import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { miAnalyticsSnapshots, miBudgetPlans } from '../../database/schema';
import { approvalAgeDays as ageDays, type ApprovalQueue, type ApprovalQueueSource, type PendingApprovalItem } from '../../common/approval-queues';

// docs/60 Phase 4 (MKT-20) — the marketing-intel module's GOV-01 approval queues: analytics runs awaiting a
// second-person approval before they can drive spend/contact (governed tenants only), and — docs/62
// Phase 1 — staged budget plans awaiting the MKT-17 maker-checker approval (Pending mi_budget_plans were
// previously invisible to GOV-01). Discovered at boot by ApprovalQueueRegistrarService; a drift-blocked
// run is highlighted in its label. No inline query in finance.service.ts (the check-service-size ratchet
// enforces this pattern).
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
      {
        source: 'mi_budget_plan',
        pending: async () => {
          const rows = await this.db.select({ planNo: miBudgetPlans.planNo, totalBudget: miBudgetPlans.totalBudget, requestedBy: miBudgetPlans.requestedBy, createdAt: miBudgetPlans.createdAt })
            .from(miBudgetPlans).where(and(eq(miBudgetPlans.status, 'Pending')));
          return rows.map((r): PendingApprovalItem => ({
            type: 'mi_budget_plan',
            control: 'MKT-17',
            ref: r.planNo,
            label: `แผนงบการตลาด ${r.planNo} — รออนุมัติ`,
            amount: Number(r.totalBudget) || 0,
            requested_by: r.requestedBy ?? null,
            requested_at: r.createdAt ?? null,
            age_days: ageDays(r.createdAt),
          }));
        },
      },
    ];
  }
}
