import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, isNotNull, lte, gt } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { miJourneys, miSavePolicies, miSaveRuns } from '../../database/schema';
import { approvalAgeDays as ageDays, type ApprovalQueue, type ApprovalQueueSource, type PendingApprovalItem } from '../../common/approval-queues';

// docs/62 Phase 1 — marketing-activation's GOV-01 queues (discovered by ApprovalQueueRegistrarService;
// no inline query in finance.service.ts — the check-service-size ratchet enforces this pattern). Reads are
// RLS-scoped by the request tx like the sibling providers. Three queues:
//  • mi_nba_journey  (MKT-22) — staged journeys awaiting the maker-checker ACTIVATION (a different human);
//  • mi_save_policy  (MKT-24) — staged save-offer policies awaiting a different human's approval;
//  • mkt_measure_due (MKT-19 discipline) — Active journeys / save runs whose measurement window elapsed
//    but nobody measured — the evidence is WAITING (detective, ages from measure_after; the
//    close_task_overdue shape). Rows without a control arm are excluded (structurally unmeasurable).
@Injectable()
export class MarketingActivationApprovalQueues implements ApprovalQueueSource {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  approvalQueues(): ApprovalQueue[] {
    return [
      {
        source: 'mi_nba_journey',
        pending: async () => {
          const rows = await this.db.select({ journeyNo: miJourneys.journeyNo, segment: miJourneys.segment, targetCount: miJourneys.targetCount, requestedBy: miJourneys.requestedBy, createdAt: miJourneys.createdAt })
            .from(miJourneys).where(eq(miJourneys.status, 'Pending'));
          return rows.map((r): PendingApprovalItem => ({
            type: 'mi_nba_journey',
            control: 'MKT-22',
            ref: r.journeyNo,
            label: `แผน NBA ${r.journeyNo}${r.segment ? ` · ${r.segment}` : ''} (${r.targetCount} เป้าหมาย) — รอเปิดใช้งาน`,
            amount: 0,
            requested_by: r.requestedBy ?? null,
            requested_at: r.createdAt ?? null,
            age_days: ageDays(r.createdAt),
          }));
        },
      },
      {
        source: 'mi_save_policy',
        pending: async () => {
          const rows = await this.db.select({ policyNo: miSavePolicies.policyNo, offerCap: miSavePolicies.offerCap, requestedBy: miSavePolicies.requestedBy, createdAt: miSavePolicies.createdAt })
            .from(miSavePolicies).where(eq(miSavePolicies.status, 'Pending'));
          return rows.map((r): PendingApprovalItem => ({
            type: 'mi_save_policy',
            control: 'MKT-24',
            ref: r.policyNo,
            label: `นโยบายรักษาลูกค้า ${r.policyNo} (เพดาน ${Number(r.offerCap)}) — รออนุมัติ`,
            amount: 0,
            requested_by: r.requestedBy ?? null,
            requested_at: r.createdAt ?? null,
            age_days: ageDays(r.createdAt),
          }));
        },
      },
      {
        source: 'mkt_measure_due',
        pending: async () => {
          const now = new Date();
          const dueJourneys = await this.db.select({ journeyNo: miJourneys.journeyNo, segment: miJourneys.segment, requestedBy: miJourneys.requestedBy, measureAfter: miJourneys.measureAfter })
            .from(miJourneys)
            .where(and(eq(miJourneys.status, 'Active'), isNull(miJourneys.measuredAt), isNotNull(miJourneys.measureAfter), lte(miJourneys.measureAfter, now), gt(miJourneys.controlCount, 0)));
          const dueRuns = await this.db.select({ runNo: miSaveRuns.runNo, segment: miSaveRuns.segment, requestedBy: miSaveRuns.requestedBy, measureAfter: miSaveRuns.measureAfter })
            .from(miSaveRuns)
            .where(and(isNull(miSaveRuns.measuredAt), isNotNull(miSaveRuns.measureAfter), lte(miSaveRuns.measureAfter, now), gt(miSaveRuns.controlCount, 0)));
          return [
            ...dueJourneys.map((r): PendingApprovalItem => ({
              type: 'mkt_measure_due', control: 'MKT-22', ref: r.journeyNo,
              label: `ครบกำหนดวัดผลแผน NBA ${r.journeyNo}${r.segment ? ` · ${r.segment}` : ''} — lift จริงรอการวัด`,
              amount: 0, requested_by: r.requestedBy ?? null, requested_at: r.measureAfter ?? null, age_days: ageDays(r.measureAfter),
            })),
            ...dueRuns.map((r): PendingApprovalItem => ({
              type: 'mkt_measure_due', control: 'MKT-24', ref: r.runNo,
              label: `ครบกำหนดวัดผลรอบรักษาลูกค้า ${r.runNo}${r.segment ? ` · ${r.segment}` : ''} — P&L จริงรอการวัด`,
              amount: 0, requested_by: r.requestedBy ?? null, requested_at: r.measureAfter ?? null, age_days: ageDays(r.measureAfter),
            })),
          ];
        },
      },
    ];
  }
}
