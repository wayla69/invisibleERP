import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { sql, eq, and, ne, gte, lte, desc, asc, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import {
  marketingCampaigns, abTests, abVariants, promotions, promotionItems, priceList,
  surveys, surveyResponses, surveyAnswers, abandonedCarts, custPosSales, tenants,
} from '../../database/schema';
import { ymd, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

export interface CreateCampaignDto {
  campaign_name: string; campaign_type?: string; content_text?: string; image_key?: string;
  ticker_text?: string; start_date?: string; end_date?: string; target_type?: string;
  target_value?: string; priority?: number;
}
export interface CreateAbTestDto {
  test_name: string; campaign_id?: string;
  variant_a?: { content_text?: string; image_key?: string };
  variant_b?: { content_text?: string; image_key?: string };
}
export interface CreatePromotionDto {
  promo_name: string; promo_type: string; start_date?: string; end_date?: string;
  min_qty?: number; min_amount?: number; discount_pct?: number; discount_amt?: number;
  free_item_id?: string; free_qty?: number; customer_group?: string; category?: string;
  max_uses?: number; notes?: string; item_ids?: string[];
}
export interface CreatePriceListDto {
  list_name?: string; tenant_id?: number | null; item_id: string; item_description?: string;
  base_price?: number; special_price?: number; discount_pct?: number; min_qty?: number;
  valid_from?: string; valid_to?: string;
}
export interface CreateSurveyDto { survey_name: string; survey_type?: string; trigger?: string }
export interface SurveyResponseDto {
  tenant_id?: number | null; order_no?: string; nps_score?: number; comments?: string;
  q1?: string; q2?: string; q3?: string;
}

// 6 promotion types (parity กับ V1)
const PROMO_TYPES = ['Percent', 'Amount', 'BuyXGetY', 'Bundle', 'MinSpend', 'FreeGift'];

@Injectable()
export class MarketingService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ───────────────────────── CAMPAIGNS ─────────────────────────
  async createCampaign(dto: CreateCampaignDto, user: JwtUser) {
    const db = this.db as any;
    const campaignId = `CMP-${stamp()}`;
    await db.insert(marketingCampaigns).values({
      campaignId, campaignName: dto.campaign_name, campaignType: dto.campaign_type ?? 'Popup',
      contentText: dto.content_text ?? null, imageKey: dto.image_key ?? null, tickerText: dto.ticker_text ?? null,
      startDate: dto.start_date ?? null, endDate: dto.end_date ?? null,
      targetType: dto.target_type ?? 'All', targetValue: dto.target_value ?? null,
      priority: dto.priority ?? 0, active: true, createdBy: user.username, createdAt: new Date(),
    });
    return { campaign_id: campaignId, campaign_name: dto.campaign_name, active: true };
  }

  async toggleCampaign(id: number, user: JwtUser) {
    const db = this.db as any;
    const [c] = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, id)).limit(1);
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Campaign not found', messageTh: 'ไม่พบแคมเปญ' });
    const active = !c.active;
    await db.update(marketingCampaigns).set({ active }).where(eq(marketingCampaigns.id, id));
    return { id, active };
  }

  async listCampaigns() {
    const db = this.db as any;
    const rows = await db.select().from(marketingCampaigns).orderBy(desc(marketingCampaigns.id));
    return { campaigns: rows, count: rows.length };
  }

  // GET /api/marketing/campaigns/active — active Popup/Ticker (Active=1, อยู่ในช่วงวันที่) สำหรับ portal
  async activeCampaigns() {
    const db = this.db as any;
    const today = ymd();
    const rows = await db.select().from(marketingCampaigns).where(and(
      eq(marketingCampaigns.active, true),
      sql`(${marketingCampaigns.startDate} is null or ${marketingCampaigns.startDate} <= ${today})`,
      sql`(${marketingCampaigns.endDate} is null or ${marketingCampaigns.endDate} >= ${today})`,
      sql`${marketingCampaigns.campaignType}::text in ('Popup','Ticker')`,
    )).orderBy(desc(marketingCampaigns.priority), asc(marketingCampaigns.id));
    return { campaigns: rows, count: rows.length };
  }

  // ───────────────────────── SEGMENTS (RFM-lite) ─────────────────────────
  // คำนวณ spend/order_count/last_order/days_since ต่อ tenant จาก custPosSales
  async segments() {
    const db = this.db as any;
    const today = ymd();
    const rows = await db.select({
      tenant_id: custPosSales.tenantId,
      code: tenants.code,
      spend: sql<string>`coalesce(sum(${custPosSales.total}),0)`,
      order_count: sql<string>`count(*)`,
      last_order: sql<string>`max(${custPosSales.saleDate})`,
      days_since: sql<string>`coalesce(${today}::date - max(${custPosSales.saleDate}), 99999)`,
    }).from(custPosSales)
      .leftJoin(tenants, eq(custPosSales.tenantId, tenants.id))
      .where(and(ne(custPosSales.status, 'Voided'), sql`${custPosSales.tenantId} is not null`))
      .groupBy(custPosSales.tenantId, tenants.code);

    const spends = rows.map((r: any) => n(r.spend)).sort((a: number, b: number) => a - b);
    const p75 = percentile(spends, 75);

    const segmented = rows.map((r: any) => {
      const spend = n(r.spend);
      const orders = n(r.order_count);
      const days = n(r.days_since);
      let segment = 'Regular';
      if (days <= 30 && spend >= p75) segment = 'VIP';
      else if (days <= 60 && orders >= 3) segment = 'Loyal';
      else if (days > 90) segment = 'At Risk';
      else if (orders === 1) segment = 'New';
      return {
        tenant_id: r.tenant_id, customer_name: r.code, spend, order_count: orders,
        last_order: r.last_order, days_since: days, segment,
      };
    });

    const counts: Record<string, number> = {};
    for (const s of segmented) counts[s.segment] = (counts[s.segment] ?? 0) + 1;

    return { p75_spend: p75, segments: segmented, counts, total: segmented.length };
  }

  // ───────────────────────── A/B TESTS ─────────────────────────
  async createAbTest(dto: CreateAbTestDto, user: JwtUser) {
    const db = this.db as any;
    const testId = `AB-${stamp()}`;
    await db.transaction(async (tx: any) => {
      await tx.insert(abTests).values({
        testId, testName: dto.test_name, campaignId: dto.campaign_id ?? null,
        status: 'Running', createdBy: user.username, createdAt: new Date(),
      });
      await tx.insert(abVariants).values([
        { testId, variant: 'A', contentText: dto.variant_a?.content_text ?? null, imageKey: dto.variant_a?.image_key ?? null, impressions: 0, clicks: 0, conversions: 0 },
        { testId, variant: 'B', contentText: dto.variant_b?.content_text ?? null, imageKey: dto.variant_b?.image_key ?? null, impressions: 0, clicks: 0, conversions: 0 },
      ]);
    });
    return { test_id: testId, test_name: dto.test_name, status: 'Running', variants: ['A', 'B'] };
  }

  async listAbTests() {
    const db = this.db as any;
    const tests = await db.select().from(abTests).orderBy(desc(abTests.id));
    const variants = await db.select().from(abVariants);
    const out = tests.map((t: any) => {
      const vs = variants.filter((v: any) => v.testId === t.testId).map((v: any) => {
        const imp = n(v.impressions); const clk = n(v.clicks); const conv = n(v.conversions);
        return {
          variant: v.variant, content_text: v.contentText, image_key: v.imageKey,
          impressions: imp, clicks: clk, conversions: conv,
          ctr: imp > 0 ? round4(clk / imp) : 0,
          cvr: imp > 0 ? round4(conv / imp) : 0,
        };
      });
      return { ...t, variants: vs };
    });
    return { tests: out, count: out.length };
  }

  // ───────────────────────── ABANDONED CARTS ─────────────────────────
  // POST /api/marketing/abandoned-carts/remind — set notifiedAt บน recovered=false rows
  async remindAbandonedCarts() {
    const db = this.db as any;
    const now = new Date();
    const updated = await db.update(abandonedCarts)
      .set({ notifiedAt: now })
      .where(and(eq(abandonedCarts.recovered, false), isNull(abandonedCarts.notifiedAt)))
      .returning({ id: abandonedCarts.id });
    return { reminded: updated.length, notified_at: now.toISOString() };
  }

  // ───────────────────────── PROMOTIONS ─────────────────────────
  async listPromotions() {
    const db = this.db as any;
    const promos = await db.select().from(promotions).orderBy(desc(promotions.id));
    const items = await db.select().from(promotionItems);
    const out = promos.map((p: any) => ({
      ...p,
      item_ids: items.filter((i: any) => Number(i.promoId) === Number(p.id)).map((i: any) => i.itemId),
    }));
    return { promotions: out, count: out.length };
  }

  async createPromotion(dto: CreatePromotionDto, user: JwtUser) {
    const db = this.db as any;
    if (!PROMO_TYPES.includes(dto.promo_type))
      throw new BadRequestException({ code: 'BAD_PROMO_TYPE', message: `Invalid promo type: ${dto.promo_type}`, messageTh: 'ประเภทโปรโมชันไม่ถูกต้อง' });
    const promoId = `PROMO-${stamp()}`;
    const itemIds = Array.from(new Set((dto.item_ids ?? []).filter(Boolean)));
    let newId = 0;
    await db.transaction(async (tx: any) => {
      const [h] = await tx.insert(promotions).values({
        promoId, promoName: dto.promo_name, promoType: dto.promo_type,
        startDate: dto.start_date ?? null, endDate: dto.end_date ?? null,
        minQty: dto.min_qty != null ? String(dto.min_qty) : null,
        minAmount: dto.min_amount != null ? String(dto.min_amount) : null,
        discountPct: dto.discount_pct != null ? String(dto.discount_pct) : null,
        discountAmt: dto.discount_amt != null ? String(dto.discount_amt) : null,
        freeItemId: dto.free_item_id ?? null,
        freeQty: dto.free_qty != null ? String(dto.free_qty) : null,
        customerGroup: dto.customer_group ?? 'All', category: dto.category ?? null,
        maxUses: dto.max_uses ?? null, usedCount: 0, active: true, notes: dto.notes ?? null,
      }).returning({ id: promotions.id });
      newId = Number(h.id);
      if (itemIds.length) {
        await tx.insert(promotionItems).values(itemIds.map((itemId) => ({ promoId: newId, itemId })));
      }
    });
    return { promo_id: promoId, id: newId, promo_name: dto.promo_name, promo_type: dto.promo_type, item_count: itemIds.length };
  }

  async togglePromotion(id: number) {
    const db = this.db as any;
    const [p] = await db.select().from(promotions).where(eq(promotions.id, id)).limit(1);
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Promotion not found', messageTh: 'ไม่พบโปรโมชัน' });
    const active = !p.active;
    await db.update(promotions).set({ active }).where(eq(promotions.id, id));
    return { id, active };
  }

  // ───────────────────────── PRICE LIST ─────────────────────────
  // effective = special>0 ? special : base*(1-disc/100) ; tenant null = All Customers
  async listPriceList() {
    const db = this.db as any;
    const rows = await db.select({
      id: priceList.id, list_name: priceList.listName, tenant_id: priceList.tenantId,
      customer_name: tenants.code, item_id: priceList.itemId, item_description: priceList.itemDescription,
      base_price: priceList.basePrice, special_price: priceList.specialPrice, discount_pct: priceList.discountPct,
      min_qty: priceList.minQty, valid_from: priceList.validFrom, valid_to: priceList.validTo, active: priceList.active,
    }).from(priceList).leftJoin(tenants, eq(priceList.tenantId, tenants.id)).orderBy(desc(priceList.id));
    const out = rows.map((r: any) => {
      const base = n(r.base_price); const special = n(r.special_price); const disc = n(r.discount_pct);
      const effective = special > 0 ? special : round2(base * (1 - disc / 100));
      return {
        ...r, base_price: base, special_price: special, discount_pct: disc, min_qty: n(r.min_qty),
        customer_name: r.tenant_id == null ? 'All Customers' : r.customer_name,
        effective_price: effective,
      };
    });
    return { price_list: out, count: out.length };
  }

  async createPriceList(dto: CreatePriceListDto) {
    const db = this.db as any;
    const base = n(dto.base_price); const special = n(dto.special_price); const disc = n(dto.discount_pct);
    const effective = special > 0 ? special : round2(base * (1 - disc / 100));
    const [h] = await db.insert(priceList).values({
      listName: dto.list_name ?? 'Standard', tenantId: dto.tenant_id ?? null,
      itemId: dto.item_id, itemDescription: dto.item_description ?? null,
      basePrice: String(base), specialPrice: dto.special_price != null ? String(special) : null,
      discountPct: dto.discount_pct != null ? String(disc) : null,
      minQty: dto.min_qty != null ? String(dto.min_qty) : '1',
      validFrom: dto.valid_from ?? null, validTo: dto.valid_to ?? null, active: true,
    }).returning({ id: priceList.id });
    return { id: Number(h.id), item_id: dto.item_id, effective_price: effective, tenant: dto.tenant_id ?? 'All Customers' };
  }

  // ───────────────────────── SURVEYS ─────────────────────────
  async listSurveys() {
    const db = this.db as any;
    const rows = await db.select().from(surveys).orderBy(desc(surveys.id));
    return { surveys: rows, count: rows.length };
  }

  async createSurvey(dto: CreateSurveyDto) {
    const db = this.db as any;
    const surveyId = `SVY-${stamp()}`;
    await db.insert(surveys).values({
      surveyId, surveyName: dto.survey_name, surveyType: dto.survey_type ?? 'NPS',
      trigger: dto.trigger ?? 'Post-Delivery', active: true, createdAt: new Date(),
    });
    return { survey_id: surveyId, survey_name: dto.survey_name, active: true };
  }

  // POST /api/surveys/:id/responses — NPS + Q1-3 -> surveyAnswers (EAV)
  async createSurveyResponse(surveyId: string, dto: SurveyResponseDto) {
    const db = this.db as any;
    const [svy] = await db.select().from(surveys).where(eq(surveys.surveyId, surveyId)).limit(1);
    if (!svy) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Survey not found', messageTh: 'ไม่พบแบบสำรวจ' });
    let responseId = 0;
    await db.transaction(async (tx: any) => {
      const [r] = await tx.insert(surveyResponses).values({
        surveyId, tenantId: dto.tenant_id ?? null, orderNo: dto.order_no ?? null,
        responseDate: ymd(), npsScore: dto.nps_score ?? null, comments: dto.comments ?? null,
      }).returning({ id: surveyResponses.id });
      responseId = Number(r.id);
      const answers = [dto.q1, dto.q2, dto.q3]
        .map((answer, i) => ({ answer, questionNo: i + 1 }))
        .filter((a) => a.answer != null && a.answer !== '')
        .map((a) => ({ responseId, questionNo: a.questionNo, answer: a.answer as string }));
      if (answers.length) await tx.insert(surveyAnswers).values(answers);
    });
    return { survey_id: surveyId, response_id: responseId, nps_score: dto.nps_score ?? null };
  }
}

function round2(x: number) { return Math.round(x * 100) / 100; }
function round4(x: number) { return Math.round(x * 10000) / 10000; }
const pad = (v: number) => String(v).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
// percentile แบบ nearest-rank บน array ที่ sort แล้ว (ascending)
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank); const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}
