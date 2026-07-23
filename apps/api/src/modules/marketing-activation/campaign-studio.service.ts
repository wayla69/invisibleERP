import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { customerProfiles, miCampaignGenerations } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { llmClient } from '../../common/llm-client';
import { modelFor, aiDpaBlocked } from '../../common/ai-models';
import { aiTenantOptedOut } from '../../common/ai-consent';
import { CampaignsService } from '../campaigns/campaigns.service';
import { CrmService } from '../crm/crm.service';
import { FactLayerService } from './fact-layer.service';
import { PropensityService } from './propensity.service';
import { measureLiftDetailed } from '../../common/lift-math';
import { buildPrompt, draftCampaign, draftVariantB, type SegmentFactSheet, type CampaignDraft, type VariantCopy } from './campaign-studio';

// AI Campaign Studio (docs/61 Phase 4, control MKT-21) — "generate a campaign that will actually sell". It
// assembles a segment FACT SHEET (size, avg CLV, dominant next-best-action, best channel by MMM ROI, modal
// send-hour, and the ③→① top un-bought product) from the Fact Layer + a customer_profiles aggregation,
// feeds it to the generator as retrieval-grounded context (facts in the prompt, not hallucinated), and
// produces a bilingual campaign DRAFT. It never contacts anyone: `generate` is advisory, and `stage`
// creates a consent-gated campaign DRAFT (the send stays the existing consent-gated + maker-checker
// campaign flow) while LOGGING the model card (fact sheet + prompt + model + draft) to
// mi_campaign_generations as the ICFR evidence. Read model.
//
// Studio v2 — a live LLM refines the COPY behind the SAME fact sheet + prompt (the swap MKT-21 was designed
// for): DPA-gated (`aiDpaBlocked`), tenant-PDPA-gated (`aiTenantOptedOut`), STRICT schema-validated, and
// fail-closed — no key / opt-out / malformed output / provider error all fall back to the deterministic
// template silently (the LP-2 pattern). The LLM touches copy fields ONLY; channel, send-hour, reach,
// holdout and audience stay deterministic from the facts, and the `model` recorded on the model card is
// the path that actually produced the copy (real model id vs 'studio-template-v1'). Like the other
// one-shot consumers (nl-analytics, insights, doc-ai, LP-2) it does not meter ai_token_usage — that
// budget control (AIG-03) scopes the conversational agent.

const STUDIO_MODEL = 'studio-template-v1';

// The LLM may refine ONLY these copy fields — anything else in its answer is ignored by construction.
// docs/62 Phase 3: variant_b is an OPTIONAL second creative angle for the A/B split; when the LLM omits it
// (or the template path runs) the deterministic draftVariantB fills in, so a B variant always exists.
const STUDIO_VARIANT_SCHEMA = z.object({
  subject_th: z.string().min(1).max(200),
  subject_en: z.string().min(1).max(200),
  body_th: z.string().min(1).max(1000),
  body_en: z.string().min(1).max(1000),
});
const STUDIO_COPY_SCHEMA = STUDIO_VARIANT_SCHEMA.extend({
  variant_b: STUDIO_VARIANT_SCHEMA.optional(),
});
type StudioCopy = z.infer<typeof STUDIO_COPY_SCHEMA>;

@Injectable()
export class CampaignStudioService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly facts: FactLayerService,
    private readonly campaigns: CampaignsService,
    private readonly propensity: PropensityService,
    private readonly crm: CrmService, // per-member POS revenue for the A/B outcome read (owning read)
  ) {}

  private get apiKey(): string {
    return aiDpaBlocked() ? '' : (process.env.ANTHROPIC_API_KEY || '');
  }

  // Studio v2 LLM copy refinement — returns the validated copy + the real model id, or null on ANY
  // gate/error (the caller then keeps the deterministic template). Never throws.
  private async llmCopy(tenantId: number, prompt: string): Promise<{ copy: StudioCopy; model: string } | null> {
    if (!this.apiKey) return null;                              // no key / prod DPA gate → template
    if (await aiTenantOptedOut(this.db, tenantId)) return null; // PDPA tenant opt-out → template
    try {
      const model = modelFor('campaign_studio');
      const res: any = await llmClient(this.apiKey).create({
        model, max_tokens: 1200, // room for both variants' copy
        system: 'You refine marketing campaign COPY for a Thai business, grounded STRICTLY on the facts in the user prompt — never invent discounts, prices, or products that are not stated, and match the stated strategic tone. Return ONLY one JSON object: {"subject_th":string,"subject_en":string,"body_th":string,"body_en":string,"variant_b":{"subject_th":string,"subject_en":string,"body_th":string,"body_en":string}} — variant_b is the SAME facts from a different creative angle (for an A/B split). The result is a DRAFT for human review and must never promise automatic sending.',
        messages: [{ role: 'user', content: prompt }],
      });
      const rawText = (res.content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      const parsed = STUDIO_COPY_SCHEMA.safeParse(JSON.parse(rawText));
      if (!parsed.success) return null;                         // schema mismatch → template (fail-closed)
      return { copy: parsed.data, model };
    } catch { return null; }                                    // provider/JSON error → template (fail-closed)
  }

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
      // The ③→① hook: Tool ③'s per-segment top un-bought product becomes the CONCRETE offer on the sheet.
      top_offer: (await this.propensity.topSegmentOffer(user, seg))?.name ?? null,
      // docs/62 Phase 3: the strategic tone derived from the pushed TOWS matrix (Fact Layer) sets the voice.
      tone: (sf.tows_tone as string | null) ?? null,
    };
  }

  // ADVISORY generate — the fact-grounded draft + the model card, WITHOUT persisting or contacting.
  // Studio v2: the LLM (when allowed) refines the copy over the SAME prompt; targeting stays deterministic.
  async generate(user: JwtUser, segment: string): Promise<Record<string, unknown>> {
    const f = await this.loadFactSheet(user, segment);
    const prompt = buildPrompt(f);
    let draft = draftCampaign(f);
    let draftB: VariantCopy = draftVariantB(f); // docs/62 Phase 3: a second creative angle for the A/B split
    let model: string = STUDIO_MODEL;
    const llm = await this.llmCopy(this.assertTenant(user), prompt);
    if (llm) {
      const { variant_b, ...copyA } = llm.copy;
      draft = { ...draft, ...copyA };
      if (variant_b) draftB = variant_b;
      model = llm.model;
    }
    return {
      segment: f.segment, model, facts: f, prompt, draft, draft_b: draftB,
      note: 'Advisory generation (MKT-21). The draft is fact-grounded and NOT sent — stage it to create a consent-gated campaign draft; only consented members are ever contacted.',
    };
  }

  // STAGE — create a consent-gated campaign DRAFT (never auto-sent) from the generated copy, and LOG the
  // model card (fact sheet + prompt + model + draft) as ICFR evidence. Overrides let a human edit the copy.
  async stageDraft(user: JwtUser, body: { segment: string; channel?: string; body_th?: string; body_en?: string; name?: string; variant_b_body?: string; split_b_pct?: number }): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const f = await this.loadFactSheet(user, body.segment);
    const prompt = buildPrompt(f);
    const llm = await this.llmCopy(tenantId, prompt);
    let draft: CampaignDraft = draftCampaign(f);
    // docs/62 Phase 3: the staged campaign is a REAL A/B — variant B (a second creative angle, TH copy like
    // the primary body) rides the existing deterministic per-member split on the campaign (default 50/50).
    let draftB: VariantCopy = draftVariantB(f);
    let model: string = STUDIO_MODEL;
    if (llm) {
      const { variant_b, ...copyA } = llm.copy;
      draft = { ...draft, ...copyA };
      if (variant_b) draftB = variant_b;
      model = llm.model;
    }
    const channel = body.channel ?? draft.channel;
    const bodyTh = body.body_th ?? draft.body_th;
    const variantBBody = body.variant_b_body ?? draftB.body_th;
    const splitBPct = Math.min(90, Math.max(0, Number(body.split_b_pct ?? 50)));

    // The consent-gated campaign DRAFT (audience mi_segment; status 'draft' — the send is the existing flow).
    const camp = await this.campaigns.upsertCampaign(user, {
      name: body.name ?? `AI · ${f.segment}`, channel, audience: 'mi_segment', segment: f.segment,
      body: bodyTh, variant_b_body: variantBBody, split_b_pct: splitBPct,
    });
    const campaignId = camp && typeof camp === 'object' && 'id' in camp ? Number((camp as { id: unknown }).id) : null;

    const todayCount = (await this.db.select({ id: miCampaignGenerations.id }).from(miCampaignGenerations).where(eq(miCampaignGenerations.tenantId, tenantId))).length;
    const d = new Date();
    const genNo = `GEN-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${String(todayCount + 1).padStart(3, '0')}`;
    await this.db.insert(miCampaignGenerations).values({
      tenantId, genNo, segment: f.segment, channel, model, prompt, facts: f,
      // The model card records BOTH creative variants + the split, so the A/B is fully reconstructable.
      draft: { ...draft, body_th: bodyTh, body_en: body.body_en ?? draft.body_en, variant_b: { ...draftB, body_th: variantBBody }, split_b_pct: splitBPct },
      campaignId, requestedBy: user.username ?? 'user',
    });
    return { gen_no: genNo, campaign_id: campaignId, status: 'draft', model, segment: f.segment, split_b_pct: splitBPct, note: 'A consent-gated campaign DRAFT was created + the model card logged. The send stays the existing consent-gated, maker-checker flow — nothing auto-sends.' };
  }

  // docs/62 Phase 3 — the A/B OUTCOME read for a Studio-staged (or any body-A/B) campaign: real POS revenue
  // per creative arm since the send, with the honest CI/weak-evidence math (measureLiftDetailed). Arms come
  // from the owning CampaignsService read (message_log + the recomputed deterministic split); revenue from
  // the owning CrmService read. Advisory + read-only — it never contacts anyone or moves money.
  async abOutcome(user: JwtUser, campaignId: number): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const arms = await this.campaigns.recipientsByVariant(user, campaignId);
    if (!arms.has_variant_b) throw new BadRequestException({ code: 'NO_VARIANT_B', message: 'campaign has no B variant (variant_b_body + split_b_pct required)', messageTh: 'แคมเปญไม่มีข้อความแบบ B' });
    const all = [...arms.arm_a, ...arms.arm_b];
    if (!all.length) throw new BadRequestException({ code: 'NO_RECIPIENTS', message: 'campaign has no contacted recipients yet', messageTh: 'แคมเปญยังไม่มีผู้รับข้อความ' });
    const now = new Date();
    const from = arms.sent_at ? new Date(arms.sent_at as unknown as string) : new Date(now.getTime() - 90 * 86400_000);
    const rev = await this.crm.revenueByMembers(tenantId, all, from, now);
    const revA = arms.arm_a.map((id) => rev.get(id) ?? 0);
    const revB = arms.arm_b.map((id) => rev.get(id) ?? 0);
    const m = measureLiftDetailed(revB, revA); // B = treatment (the challenger), A = control (the champion)
    const r2 = (v: number): number => Math.round(v * 100) / 100;
    const rn = (v: number | null): number | null => (v == null ? null : r2(v));
    return {
      campaign_id: arms.campaign_id, campaign_code: arms.campaign_code, name: arms.name, status: arms.status,
      split_b_pct: arms.split_b_pct, window_from: from, measured_at: now,
      arm_a: { n: arms.arm_a.length, revenue: r2(revA.reduce((s, x) => s + x, 0)), per_head: r2(m.control_per_head) },
      arm_b: { n: arms.arm_b.length, revenue: r2(revB.reduce((s, x) => s + x, 0)), per_head: r2(m.treatment_per_head) },
      b_vs_a: {
        lift_pct: rn(m.lift_pct), lift_ci_low_pct: rn(m.lift_ci_low_pct), lift_ci_high_pct: rn(m.lift_ci_high_pct),
        weak_evidence: m.weak_evidence, min_arm_n: m.min_arm_n,
      },
      note: 'Advisory A/B outcome (docs/62 Phase 3). B is measured against A on real POS revenue since the send; weak_evidence flags small/inconclusive samples — it never changes any math.',
    };
  }

  async listGenerations(user: JwtUser, limit = 20): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const rows = await this.db.select().from(miCampaignGenerations)
      .where(eq(miCampaignGenerations.tenantId, tenantId)).orderBy(desc(miCampaignGenerations.createdAt)).limit(Math.min(Math.max(limit, 1), 100));
    return { generations: rows.map((r) => ({ gen_no: r.genNo, segment: r.segment, channel: r.channel, model: r.model, campaign_id: r.campaignId, requested_by: r.requestedBy, created_at: r.createdAt })) };
  }
}
