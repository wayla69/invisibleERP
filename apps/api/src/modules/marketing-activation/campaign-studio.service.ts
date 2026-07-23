import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { customerProfiles, miCampaignGenerations } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { CampaignsService } from '../campaigns/campaigns.service';
import { FactLayerService } from './fact-layer.service';
import { buildPrompt, draftCampaign, type SegmentFactSheet, type CampaignDraft } from './campaign-studio';

// AI Campaign Studio (docs/61 Phase 4, control MKT-21) — "generate a campaign that will actually sell". It
// assembles a segment FACT SHEET (size, avg CLV, dominant next-best-action, best channel by MMM ROI, modal
// send-hour) from the Fact Layer + a customer_profiles aggregation, feeds it to the generator as
// retrieval-grounded context (facts in the prompt, not hallucinated), and produces a bilingual campaign
// DRAFT. It never contacts anyone: `generate` is advisory, and `stage` creates a consent-gated campaign
// DRAFT (the send stays the existing consent-gated + maker-checker campaign flow) while LOGGING the model
// card (fact sheet + prompt + model + draft) to mi_campaign_generations as the ICFR evidence. Read model.

const STUDIO_MODEL = 'studio-template-v1';

@Injectable()
export class CampaignStudioService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly facts: FactLayerService,
    private readonly campaigns: CampaignsService,
  ) {}

  private assertTenant(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'no tenant', messageTh: 'ไม่มีผู้เช่า' });
    return user.tenantId;
  }

  // Assemble the fact sheet for one mi_segment: the Fact Layer roll-up + the segment's modal send-hour.
  private async loadFactSheet(user: JwtUser, segment: string): Promise<SegmentFactSheet> {
    const tenantId = this.assertTenant(user);
    const seg = (segment ?? '').trim();
    if (!seg) throw new BadRequestException({ code: 'NO_SEGMENT', message: 'segment required', messageTh: 'ต้องระบุกลุ่ม' });
    const sf = await this.facts.segmentFacts(user, seg); // tenant-scoped; reads MMM channel-ROI too
    const count = Number(sf.count) || 0;
    if (count === 0) throw new BadRequestException({ code: 'SEGMENT_EMPTY', message: `segment "${seg}" has no members`, messageTh: `กลุ่ม "${seg}" ไม่มีสมาชิก` });

    // Modal preferred send-hour for the segment (Asia/Bangkok) — a single-table aggregation.
    const [hourRow] = await this.db.select({ hour: customerProfiles.preferredHour, n: sql<number>`count(*)::int` })
      .from(customerProfiles)
      .where(and(eq(customerProfiles.tenantId, tenantId), eq(customerProfiles.miRfmSegment, seg), sql`${customerProfiles.preferredHour} is not null`))
      .groupBy(customerProfiles.preferredHour).orderBy(sql`count(*) desc`).limit(1);

    const value = (sf.value ?? {}) as Record<string, unknown>;
    const nba = (sf.next_best_action ?? {}) as Record<string, unknown>;
    const bestCh = (sf.best_channel ?? null) as { channel?: string; roi?: number | null } | null;
    return {
      segment: seg,
      count,
      avg_clv: value.avg_clv_platform == null ? null : Number(value.avg_clv_platform),
      dominant_nba: (nba.dominant as string | null) ?? null,
      best_channel: bestCh?.channel ?? null,
      best_channel_roi: bestCh?.roi == null ? null : Number(bestCh.roi),
      send_hour: hourRow?.hour == null ? null : Number(hourRow.hour),
      top_offer: null, // reserved: a featured product hint from Tool ③ (per-segment top un-bought item)
    };
  }

  // ADVISORY generate — the fact-grounded draft + the model card, WITHOUT persisting or contacting.
  async generate(user: JwtUser, segment: string): Promise<Record<string, unknown>> {
    const f = await this.loadFactSheet(user, segment);
    const prompt = buildPrompt(f);
    const draft = draftCampaign(f);
    return {
      segment: f.segment, model: STUDIO_MODEL, facts: f, prompt, draft,
      note: 'Advisory generation (MKT-21). The draft is fact-grounded and NOT sent — stage it to create a consent-gated campaign draft; only consented members are ever contacted.',
    };
  }

  // STAGE — create a consent-gated campaign DRAFT (never auto-sent) from the generated copy, and LOG the
  // model card (fact sheet + prompt + model + draft) as ICFR evidence. Overrides let a human edit the copy.
  async stageDraft(user: JwtUser, body: { segment: string; channel?: string; body_th?: string; body_en?: string; name?: string }): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const f = await this.loadFactSheet(user, body.segment);
    const draft: CampaignDraft = draftCampaign(f);
    const prompt = buildPrompt(f);
    const channel = body.channel ?? draft.channel;
    const bodyTh = body.body_th ?? draft.body_th;

    // The consent-gated campaign DRAFT (audience mi_segment; status 'draft' — the send is the existing flow).
    const camp = await this.campaigns.upsertCampaign(user, {
      name: body.name ?? `AI · ${f.segment}`, channel, audience: 'mi_segment', segment: f.segment,
      body: bodyTh, variant_b_body: body.body_en ?? draft.body_en,
    });
    const campaignId = camp && typeof camp === 'object' && 'id' in camp ? Number((camp as { id: unknown }).id) : null;

    const todayCount = (await this.db.select({ id: miCampaignGenerations.id }).from(miCampaignGenerations).where(eq(miCampaignGenerations.tenantId, tenantId))).length;
    const d = new Date();
    const genNo = `GEN-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${String(todayCount + 1).padStart(3, '0')}`;
    await this.db.insert(miCampaignGenerations).values({
      tenantId, genNo, segment: f.segment, channel, model: STUDIO_MODEL, prompt, facts: f, draft: { ...draft, body_th: bodyTh, body_en: body.body_en ?? draft.body_en },
      campaignId, requestedBy: user.username ?? 'user',
    });
    return { gen_no: genNo, campaign_id: campaignId, status: 'draft', model: STUDIO_MODEL, segment: f.segment, note: 'A consent-gated campaign DRAFT was created + the model card logged. The send stays the existing consent-gated, maker-checker flow — nothing auto-sends.' };
  }

  async listGenerations(user: JwtUser, limit = 20): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const rows = await this.db.select().from(miCampaignGenerations)
      .where(eq(miCampaignGenerations.tenantId, tenantId)).orderBy(desc(miCampaignGenerations.createdAt)).limit(Math.min(Math.max(limit, 1), 100));
    return { generations: rows.map((r) => ({ gen_no: r.genNo, segment: r.segment, channel: r.channel, model: r.model, campaign_id: r.campaignId, requested_by: r.requestedBy, created_at: r.createdAt })) };
  }
}
