import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { and, eq, isNull, isNotNull, lte, gt, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { miJourneys, miSavePolicies, miSaveRuns } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { MarketingIntelService } from '../marketing-intel/marketing-intel.service';

// docs/62 Phase 1 — the marketing ACTION CENTER: one "what needs me now" worklist over the docs/60+61
// spine (the PMO action-center shape — kind/severity/bilingual title/href). Read-only aggregator on
// module-owned reads: journeys/policies/runs are this module's tables; pending budget plans come through
// MarketingIntelService.listBudgetPlans (the owning module's public read — no cross-domain query). Every
// item deep-links into the workspace; the acts themselves (activate/approve/measure) stay on their own
// maker-checker routes. No GL, no contact, no spend.

export interface MarketingActionItem {
  kind: string;
  severity: 'high' | 'medium' | 'low';
  control: string;
  ref: string | null;
  title_th: string;
  title_en: string;
  href: string;
  requested_by?: string | null;
  as_of: string | Date | null;
}

const SEV_RANK: Record<MarketingActionItem['severity'], number> = { high: 0, medium: 1, low: 2 };

@Injectable()
export class MarketingActivationActionCenterService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly mi: MarketingIntelService,
  ) {}

  private assertTenant(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'no tenant', messageTh: 'ไม่มีผู้เช่า' });
    return user.tenantId;
  }

  async actionCenter(user: JwtUser): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const now = new Date();
    const items: MarketingActionItem[] = [];

    // HIGH — measurement windows that elapsed: the evidence is waiting (MKT-19 discipline).
    const dueJourneys = await this.db.select({ journeyNo: miJourneys.journeyNo, segment: miJourneys.segment, measureAfter: miJourneys.measureAfter })
      .from(miJourneys)
      .where(and(eq(miJourneys.tenantId, tenantId), eq(miJourneys.status, 'Active'), isNull(miJourneys.measuredAt), isNotNull(miJourneys.measureAfter), lte(miJourneys.measureAfter, now), gt(miJourneys.controlCount, 0)));
    for (const j of dueJourneys) {
      items.push({
        kind: 'journey_measure_due', severity: 'high', control: 'MKT-22', ref: j.journeyNo,
        title_th: `ครบกำหนดวัดผลแผน NBA ${j.journeyNo}${j.segment ? ` · ${j.segment}` : ''}`,
        title_en: `NBA journey ${j.journeyNo} is due for measurement${j.segment ? ` · ${j.segment}` : ''}`,
        href: '/marketing-activation?tab=nba', as_of: j.measureAfter,
      });
    }
    const dueRuns = await this.db.select({ runNo: miSaveRuns.runNo, segment: miSaveRuns.segment, measureAfter: miSaveRuns.measureAfter })
      .from(miSaveRuns)
      .where(and(eq(miSaveRuns.tenantId, tenantId), isNull(miSaveRuns.measuredAt), isNotNull(miSaveRuns.measureAfter), lte(miSaveRuns.measureAfter, now), gt(miSaveRuns.controlCount, 0)));
    for (const r of dueRuns) {
      items.push({
        kind: 'save_measure_due', severity: 'high', control: 'MKT-24', ref: r.runNo,
        title_th: `ครบกำหนดวัดผลรอบรักษาลูกค้า ${r.runNo}`,
        title_en: `Save run ${r.runNo} is due for measurement`,
        href: '/marketing-activation?tab=save', as_of: r.measureAfter,
      });
    }

    // MEDIUM — maker-checker acts waiting on a human: activation / approvals.
    const pendingJourneys = await this.db.select({ journeyNo: miJourneys.journeyNo, segment: miJourneys.segment, requestedBy: miJourneys.requestedBy, createdAt: miJourneys.createdAt })
      .from(miJourneys).where(and(eq(miJourneys.tenantId, tenantId), eq(miJourneys.status, 'Pending')));
    for (const j of pendingJourneys) {
      items.push({
        kind: 'journey_pending', severity: 'medium', control: 'MKT-22', ref: j.journeyNo,
        title_th: `แผน NBA ${j.journeyNo}${j.segment ? ` · ${j.segment}` : ''} รอเปิดใช้งาน (คนละคนกับผู้จัดทำ)`,
        title_en: `NBA journey ${j.journeyNo} awaits activation (a different user)`,
        href: '/marketing-activation?tab=nba', requested_by: j.requestedBy, as_of: j.createdAt,
      });
    }
    const pendingPolicies = await this.db.select({ policyNo: miSavePolicies.policyNo, requestedBy: miSavePolicies.requestedBy, createdAt: miSavePolicies.createdAt })
      .from(miSavePolicies).where(and(eq(miSavePolicies.tenantId, tenantId), eq(miSavePolicies.status, 'Pending')));
    for (const p of pendingPolicies) {
      items.push({
        kind: 'save_policy_pending', severity: 'medium', control: 'MKT-24', ref: p.policyNo,
        title_th: `นโยบายรักษาลูกค้า ${p.policyNo} รออนุมัติ`,
        title_en: `Save-offer policy ${p.policyNo} awaits approval`,
        href: '/marketing-activation?tab=save', requested_by: p.requestedBy, as_of: p.createdAt,
      });
    }
    const plans: any = await this.mi.listBudgetPlans(user); // owning-module read (MKT-17)
    for (const p of (Array.isArray(plans?.plans) ? plans.plans : []).filter((x: any) => x?.status === 'Pending')) {
      items.push({
        kind: 'budget_plan_pending', severity: 'medium', control: 'MKT-17', ref: String(p.plan_no ?? ''),
        title_th: `แผนงบการตลาด ${p.plan_no} รออนุมัติ`,
        title_en: `Marketing budget plan ${p.plan_no} awaits approval`,
        href: '/marketing-intel', requested_by: p.requested_by ?? null, as_of: p.created_at ?? null,
      });
    }

    // LOW — a standing nudge: the churn-save autopilot cannot run without an APPROVED policy.
    const [activePolicy] = await this.db.select({ id: miSavePolicies.id }).from(miSavePolicies)
      .where(and(eq(miSavePolicies.tenantId, tenantId), eq(miSavePolicies.status, 'Active')))
      .orderBy(desc(miSavePolicies.approvedAt)).limit(1);
    if (!activePolicy && pendingPolicies.length === 0) {
      items.push({
        kind: 'no_active_save_policy', severity: 'low', control: 'MKT-24', ref: null,
        title_th: 'ยังไม่มีนโยบายรักษาลูกค้าที่อนุมัติ — Autopilot รอนโยบาย',
        title_en: 'No approved save-offer policy — the autopilot is waiting for one',
        href: '/marketing-activation?tab=save', as_of: null,
      });
    }

    items.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || String(a.ref ?? '').localeCompare(String(b.ref ?? '')));
    return {
      items, count: items.length, as_of: now,
      note: 'Read-only worklist (docs/62). Every act stays on its own maker-checker route — nothing here activates, approves, sends or spends.',
    };
  }
}
