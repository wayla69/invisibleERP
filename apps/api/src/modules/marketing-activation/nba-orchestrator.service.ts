import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { customerProfiles, posMembers, miJourneys, miJourneyTargets } from '../../database/schema';
import { assertMakerChecker } from '../../common/control-profile';
import type { JwtUser } from '../../common/decorators';
import { CampaignsService } from '../campaigns/campaigns.service';
import { assembleJourney, type NbaCustomer, type Journey } from './nba-scoring';

// Next-Best-Action Orchestrator (docs/61 Phase 3, control MKT-22) — turns the advisory mi_nba into
// SEQUENCED, PRIORITISED action. For each customer it picks the single highest expected-value action now
// (CLV × action uplift, churn-weighted for retention), assembles a journey, applies fatigue cap + consent
// suppression + recent-purchase suppression, and tags each acted-on member to a holdout arm (MKT-19 hash).
//
// STAGED + MAKER-CHECKER (the control): staging persists a Pending journey with its per-customer targets +
// the suppression evidence; NOTHING is contacted until a DIFFERENT user ACTIVATES it (assertMakerChecker,
// approver ≠ requester → SOD_SELF_APPROVAL), and even then activation only creates a consent-gated campaign
// DRAFT for the treatment arm — nothing auto-sends. Reads customer_profiles + pos_members in SEPARATE
// queries (no cross-domain join). A read/orchestration model — no GL posting.

export interface JourneyOpts { segment?: string; control_pct?: number; max_targets?: number; recent_days?: number; channel?: string; note?: string }

@Injectable()
export class NbaOrchestratorService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly campaigns: CampaignsService,
  ) {}

  // Load the scored customers (optionally scoped to one mi_segment): the mi_* action/value + reach facts from
  // customer_profiles, plus consent/active from pos_members, stitched in-app (no cross-domain SQL join).
  private async loadCustomers(tenantId: number, segment?: string): Promise<NbaCustomer[]> {
    const seg = (segment ?? '').trim();
    const profiles = await this.db.select({
      memberId: customerProfiles.memberId, nba: customerProfiles.miNba, clv: customerProfiles.miClv,
      churn: customerProfiles.miChurnRisk, channel: customerProfiles.preferredChannel, lastOrderAt: customerProfiles.lastOrderAt,
    }).from(customerProfiles)
      .where(and(
        eq(customerProfiles.tenantId, tenantId),
        isNotNull(customerProfiles.memberId),
        seg ? eq(customerProfiles.miRfmSegment, seg) : isNotNull(customerProfiles.miNba),
      ));
    const memberIds = profiles.map((p) => Number(p.memberId)).filter((n) => Number.isFinite(n));
    const optIn = new Map<number, boolean>();
    if (memberIds.length) {
      const mems = await this.db.select({ id: posMembers.id, optIn: posMembers.marketingOptIn, active: posMembers.active })
        .from(posMembers).where(and(eq(posMembers.tenantId, tenantId), inArray(posMembers.id, memberIds)));
      for (const m of mems) optIn.set(Number(m.id), m.optIn !== false && m.active !== false);
    }
    return profiles.map((p) => ({
      member_id: Number(p.memberId),
      nba: p.nba ?? null,
      clv: p.clv == null ? null : Number(p.clv),
      churn_risk: p.churn == null ? null : Number(p.churn),
      opt_in: optIn.get(Number(p.memberId)) === true, // absent member → not contactable
      last_order_at: p.lastOrderAt ? new Date(p.lastOrderAt).getTime() : null,
      preferred_channel: p.channel ?? null,
    }));
  }

  private assertTenant(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'no tenant', messageTh: 'ไม่มีผู้เช่า' });
    return user.tenantId;
  }

  private build(customers: NbaCustomer[], opts?: JourneyOpts): Journey {
    return assembleJourney(customers, {
      nowMs: Date.now(),
      controlPct: opts?.control_pct, maxTargets: opts?.max_targets, recentPurchaseDays: opts?.recent_days,
    });
  }

  // ADVISORY preview — rank the journey without persisting anything (the planner reviews it before staging).
  async preview(user: JwtUser, opts?: JourneyOpts): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const customers = await this.loadCustomers(tenantId, opts?.segment);
    const j = this.build(customers, opts);
    return {
      segment: opts?.segment ?? null, scored: customers.length,
      treatment_count: j.treatment_count, control_count: j.control_count, suppressed_count: j.suppressed_count,
      targets: j.targets.slice(0, 100), suppressed: j.suppressed.slice(0, 100),
      note: 'Advisory preview (MKT-22). Stage a journey to persist it; nothing is contacted until a DIFFERENT user activates it.',
    };
  }

  // STAGE — persist a Pending journey + its per-customer targets (treatment/control) + suppression evidence.
  async stageJourney(user: JwtUser, opts?: JourneyOpts): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const customers = await this.loadCustomers(tenantId, opts?.segment);
    const j = this.build(customers, opts);
    if (!j.treatment_count && !j.control_count) throw new BadRequestException({ code: 'NO_TARGETS', message: 'no contactable targets — everyone was suppressed or nobody has a next-best-action', messageTh: 'ไม่มีเป้าหมายที่ติดต่อได้' });

    const todayCount = (await this.db.select({ id: miJourneys.id }).from(miJourneys).where(eq(miJourneys.tenantId, tenantId))).length;
    const d = new Date();
    const journeyNo = `NBA-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${String(todayCount + 1).padStart(3, '0')}`;
    const [head] = await this.db.insert(miJourneys).values({
      tenantId, journeyNo, segment: opts?.segment ?? null, channel: opts?.channel ?? 'sms', status: 'Pending',
      controlPct: String(opts?.control_pct ?? 0.2), targetCount: j.treatment_count, controlCount: j.control_count,
      suppressedCount: j.suppressed_count, note: opts?.note ?? null, requestedBy: user.username ?? 'user',
    }).returning({ id: miJourneys.id });
    if (!head) throw new BadRequestException({ code: 'STAGE_FAILED', message: 'could not stage journey', messageTh: 'สร้างแผนไม่สำเร็จ' });
    const journeyId = Number(head.id);

    const rows = [
      ...j.targets.map((t) => ({ tenantId, journeyId, memberId: t.member_id, action: t.action, expectedValue: String(t.expected_value), arm: t.arm, suppressed: false, suppressReason: null as string | null })),
      ...j.suppressed.map((s) => ({ tenantId, journeyId, memberId: s.member_id, action: s.action, expectedValue: null as string | null, arm: 'treatment', suppressed: true, suppressReason: s.reason })),
    ];
    for (let i = 0; i < rows.length; i += 500) await this.db.insert(miJourneyTargets).values(rows.slice(i, i + 500));

    return { journey_no: journeyNo, status: 'Pending', treatment_count: j.treatment_count, control_count: j.control_count, suppressed_count: j.suppressed_count };
  }

  async listJourneys(user: JwtUser, limit = 20): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const rows = await this.db.select().from(miJourneys)
      .where(eq(miJourneys.tenantId, tenantId)).orderBy(desc(miJourneys.createdAt)).limit(Math.min(Math.max(limit, 1), 100));
    return { journeys: rows.map((r) => ({
      journey_no: r.journeyNo, status: r.status, segment: r.segment, channel: r.channel,
      target_count: r.targetCount, control_count: r.controlCount, suppressed_count: r.suppressedCount,
      requested_by: r.requestedBy, approved_by: r.approvedBy, campaign_id: r.campaignId, created_at: r.createdAt, activated_at: r.activatedAt,
    })) };
  }

  // ACTIVATE — maker-checker (approver ≠ requester), then create a consent-gated campaign DRAFT for the
  // TREATMENT arm only. The control arm is structurally never contacted; nothing auto-sends (draft/scheduled).
  async activateJourney(user: JwtUser, body: { journey_no: string; self_approval_reason?: string }): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const [journey] = await this.db.select().from(miJourneys)
      .where(and(eq(miJourneys.tenantId, tenantId), eq(miJourneys.journeyNo, body.journey_no))).limit(1);
    if (!journey) throw new NotFoundException({ code: 'JOURNEY_NOT_FOUND', message: `journey ${body.journey_no} not found`, messageTh: `ไม่พบแผน ${body.journey_no}` });
    if (journey.status !== 'Pending') throw new BadRequestException({ code: 'JOURNEY_NOT_PENDING', message: `journey is ${journey.status}`, messageTh: `แผนนี้สถานะ ${journey.status} แล้ว` });

    await assertMakerChecker(this.db, {
      user, maker: journey.requestedBy ?? '', event: 'marketing.nba_journey.activate', ref: journey.journeyNo,
      reason: body.self_approval_reason, code: 'SOD_SELF_APPROVAL',
      message: 'Maker-checker: an NBA journey must be activated by a different user than the requester',
      messageTh: 'แบ่งแยกหน้าที่: แผน NBA ต้องเปิดใช้งานโดยผู้ใช้ที่ต่างจากผู้ขอ', httpStatus: 400,
    });

    // Treatment members = the contactable arm. The control arm + suppressed rows are deliberately excluded.
    const treat = await this.db.select({ memberId: miJourneyTargets.memberId })
      .from(miJourneyTargets)
      .where(and(eq(miJourneyTargets.tenantId, tenantId), eq(miJourneyTargets.journeyId, journey.id), eq(miJourneyTargets.arm, 'treatment'), eq(miJourneyTargets.suppressed, false)));
    const memberIds = treat.map((t) => Number(t.memberId));

    let campaignId: number | null = null;
    if (memberIds.length) {
      const camp = await this.campaigns.upsertCampaign(user, {
        name: `NBA · ${journey.journeyNo}`, channel: journey.channel ?? 'sms', audience: 'members',
        member_ids: memberIds, body: journey.note ?? `ข้อความ NBA (แก้ไขก่อนส่ง)`,
      });
      campaignId = camp && typeof camp === 'object' && 'id' in camp ? Number((camp as { id: unknown }).id) : null;
    }

    await this.db.update(miJourneys)
      .set({ status: 'Active', approvedBy: user.username ?? 'user', campaignId, activatedAt: new Date() })
      .where(and(eq(miJourneys.tenantId, tenantId), eq(miJourneys.id, journey.id)));

    return { journey_no: journey.journeyNo, status: 'Active', approved_by: user.username ?? 'user', campaign_id: campaignId, contacted: memberIds.length, note: 'A consent-gated DRAFT was created for the treatment arm — a human edits + sends; the control arm is never contacted.' };
  }
}
