import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gte } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { crmCampaignInfluence, crmOpportunities } from '../../../database/schema';
import { n, ymd } from '../../../database/queries';
import type { JwtUser } from '../../../common/decorators';

// CRM-15 multi-touch campaign attribution (control CRM-17, migration 0413). The pre-existing source-ROI read
// credits a won deal's whole revenue to a SINGLE touch (its lead source), so campaign ROI is mis-stated. Here
// each campaign TOUCHPOINT on an opportunity is recorded (crm_campaign_influence), and a won deal's amount is
// distributed across its touchpoints under an explicit attribution MODEL. Every model CONSERVES the total
// (the weights sum to 1), so the attributed campaign revenue reconciles to won revenue — that revenue-
// conservation invariant is the control's accuracy check. Read-only aggregation over the CRM spine.

export type AttributionModel = 'first_touch' | 'last_touch' | 'linear' | 'u_shaped';
export const ATTRIBUTION_MODELS: AttributionModel[] = ['first_touch', 'last_touch', 'linear', 'u_shaped'];
const TOUCH_TYPES = ['lead_source', 'meeting', 'email', 'event', 'webinar', 'content', 'other'];

export interface InfluenceDto { campaign_name: string; touch_type?: string; touched_at?: string; note?: string }

// Distribute weight 1.0 across n ordered touches under the model. Returns a weight per touch index (sums to 1).
function weightsFor(model: AttributionModel, count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [1];
  switch (model) {
    case 'first_touch': return Array.from({ length: count }, (_, i) => (i === 0 ? 1 : 0));
    case 'last_touch': return Array.from({ length: count }, (_, i) => (i === count - 1 ? 1 : 0));
    case 'linear': return Array.from({ length: count }, () => 1 / count);
    case 'u_shaped': {
      // position-based: 40% first, 40% last, 20% split evenly across the middle. count===2 → 50/50.
      if (count === 2) return [0.5, 0.5];
      const mid = count - 2;
      return Array.from({ length: count }, (_, i) => (i === 0 || i === count - 1 ? 0.4 : 0.2 / mid));
    }
  }
}

// Split `amount` across the weights, rounded to 2dp, with the rounding RESIDUAL absorbed by the last
// weight-bearing touch so the parts sum EXACTLY to `amount` — the revenue-conservation invariant the control
// relies on (independently rounding each part would leave a cent unattributed for e.g. linear over 3 touches).
function distribute(amount: number, weights: number[]): number[] {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const parts = weights.map((w) => r2(amount * w));
  let lastNonZero = -1;
  for (let i = 0; i < weights.length; i++) if (weights[i]! > 0) lastNonZero = i;
  if (lastNonZero >= 0) {
    const residual = r2(amount - parts.reduce((t, p) => t + p, 0));
    parts[lastNonZero] = r2(parts[lastNonZero]! + residual);
  }
  return parts;
}

@Injectable()
export class CrmAttributionService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async oppByNo(oppNo: string): Promise<any> {
    const [o] = await this.db.select().from(crmOpportunities).where(eq(crmOpportunities.oppNo, oppNo)).limit(1);
    if (!o) throw new NotFoundException({ code: 'OPP_NOT_FOUND', message: `Opportunity ${oppNo} not found`, messageTh: 'ไม่พบดีล' });
    return o;
  }

  async addTouch(oppNo: string, dto: InfluenceDto, user: JwtUser) {
    const o = await this.oppByNo(oppNo);
    const campaign = (dto.campaign_name ?? '').trim();
    if (!campaign) throw new BadRequestException({ code: 'CAMPAIGN_REQUIRED', message: 'A campaign name is required', messageTh: 'ต้องระบุชื่อแคมเปญ' });
    const touchType = TOUCH_TYPES.includes(String(dto.touch_type)) ? String(dto.touch_type) : 'other';
    await this.db.insert(crmCampaignInfluence).values({
      tenantId: user.tenantId ?? null, opportunityId: Number(o.id), campaignName: campaign,
      touchType, touchedAt: dto.touched_at ?? ymd(), note: dto.note ?? null, createdBy: user.username,
    });
    return this.opportunityInfluence(oppNo);
  }

  // A deal's touchpoints (chronological) + the per-model attributed amount for THIS deal (only meaningful once won).
  async opportunityInfluence(oppNo: string) {
    const o = await this.oppByNo(oppNo);
    const touches = await this.db.select().from(crmCampaignInfluence)
      .where(eq(crmCampaignInfluence.opportunityId, Number(o.id)))
      .orderBy(asc(crmCampaignInfluence.touchedAt), asc(crmCampaignInfluence.id));
    const amount = n(o.amount);
    const isWon = o.status === 'Won';
    const models: Record<string, { campaign: string; touch_type: string; touched_at: string; amount: number }[]> = {};
    for (const model of ATTRIBUTION_MODELS) {
      const parts = isWon ? distribute(amount, weightsFor(model, touches.length)) : touches.map(() => 0);
      models[model] = touches.map((tch: any, i: number) => ({
        campaign: tch.campaignName, touch_type: tch.touchType, touched_at: tch.touchedAt, amount: parts[i] ?? 0,
      }));
    }
    return {
      opp_no: oppNo, amount, status: o.status, touch_count: touches.length,
      touches: touches.map((tch: any) => ({ id: Number(tch.id), campaign: tch.campaignName, touch_type: tch.touchType, touched_at: tch.touchedAt, note: tch.note })),
      attributed: models,
    };
  }

  // The attribution report: distribute every WON deal's amount (in the window) across its campaign touchpoints
  // under `model`, aggregate attributed revenue per campaign, and reconcile the total to won-with-touches.
  async attribution(user: JwtUser, opts: { model?: string; months?: number } = {}) {
    const db = this.db;
    const model: AttributionModel = ATTRIBUTION_MODELS.includes(opts.model as AttributionModel) ? (opts.model as AttributionModel) : 'linear';
    const months = Math.min(24, Math.max(1, Math.floor(opts.months ?? 6)));
    const since = monthsAgoYmd(months);

    // Won opportunities in the window (created_at is the business anchor used by the other CRM analytics).
    const wonOpps = await db.select({ id: crmOpportunities.id, amount: crmOpportunities.amount })
      .from(crmOpportunities)
      .where(and(eq(crmOpportunities.status, 'Won'), gte(crmOpportunities.createdAt, sinceTs(since))));
    const wonIds = new Set(wonOpps.map((o: any) => Number(o.id)));
    const amountById = new Map(wonOpps.map((o: any) => [Number(o.id), n(o.amount)]));

    // All touchpoints for those won deals, grouped per opportunity (chronological).
    const perOpp = new Map<number, any[]>();
    if (wonIds.size) {
      const touches = await db.select().from(crmCampaignInfluence).orderBy(asc(crmCampaignInfluence.touchedAt), asc(crmCampaignInfluence.id));
      for (const tch of touches) {
        const oid = Number(tch.opportunityId);
        if (!wonIds.has(oid)) continue;
        (perOpp.get(oid) ?? perOpp.set(oid, []).get(oid)!).push(tch);
      }
    }

    const byCampaign = new Map<string, { attributed: number; touches: number; deals: Set<number> }>();
    let totalAttributed = 0, dealsWithTouches = 0, wonWithTouchesAmount = 0;
    for (const [oid, touches] of perOpp) {
      const amount = amountById.get(oid) ?? 0;
      const parts = distribute(amount, weightsFor(model, touches.length));
      dealsWithTouches += 1;
      wonWithTouchesAmount += amount;
      touches.forEach((tch: any, i: number) => {
        const attr = parts[i] ?? 0;
        totalAttributed += attr;
        const key = tch.campaignName;
        const cur = byCampaign.get(key) ?? { attributed: 0, touches: 0, deals: new Set<number>() };
        cur.attributed += attr; cur.touches += 1; cur.deals.add(oid);
        byCampaign.set(key, cur);
      });
    }

    const campaigns = [...byCampaign.entries()]
      .map(([campaign, v]) => ({ campaign, attributed_revenue: Math.round(v.attributed * 100) / 100, touch_count: v.touches, deal_count: v.deals.size }))
      .sort((a, b) => b.attributed_revenue - a.attributed_revenue);

    return {
      model, window_months: months, as_of: ymd(),
      campaigns,
      totals: {
        campaign_count: campaigns.length,
        deals_with_touches: dealsWithTouches,
        won_with_touches_revenue: Math.round(wonWithTouchesAmount * 100) / 100,
        total_attributed: Math.round(totalAttributed * 100) / 100,
        // revenue-conservation invariant: attributed == won-with-touches (each model's weights sum to 1)
        reconciled: Math.abs(totalAttributed - wonWithTouchesAmount) < 0.01,
      },
    };
  }
}

// ── local date helpers (business-day anchored) ──────────────────────────────
function monthsAgoYmd(months: number): string {
  const today = ymd(); // YYYY-MM-DD (Asia/Bangkok business day)
  const [y, m, d] = today.split('-').map(Number);
  const total = y! * 12 + (m! - 1) - months;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function sinceTs(sinceYmd: string): Date {
  return new Date(`${sinceYmd}T00:00:00+07:00`);
}
