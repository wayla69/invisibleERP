import { Controller, Get, Post, Patch, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  MarketingService,
  type CreateCampaignDto, type CreateAbTestDto, type CreatePromotionDto,
  type CreatePriceListDto, type CreateSurveyDto, type SurveyResponseDto,
} from './marketing.service';

const CampaignBody = z.object({
  campaign_name: z.string().min(1), campaign_type: z.string().optional(), content_text: z.string().optional(),
  image_key: z.string().optional(), ticker_text: z.string().optional(), start_date: z.string().optional(),
  end_date: z.string().optional(), target_type: z.string().optional(), target_value: z.string().optional(),
  priority: z.number().int().optional(),
});

const VariantBody = z.object({ content_text: z.string().optional(), image_key: z.string().optional() });
const AbTestBody = z.object({
  test_name: z.string().min(1), campaign_id: z.string().optional(),
  variant_a: VariantBody.optional(), variant_b: VariantBody.optional(),
});

const PromotionBody = z.object({
  promo_name: z.string().min(1), promo_type: z.string().min(1), start_date: z.string().optional(), end_date: z.string().optional(),
  min_qty: z.number().optional(), min_amount: z.number().optional(), discount_pct: z.number().optional(), discount_amt: z.number().optional(),
  free_item_id: z.string().optional(), free_qty: z.number().optional(), customer_group: z.string().optional(), category: z.string().optional(),
  max_uses: z.number().int().optional(), notes: z.string().optional(), item_ids: z.array(z.string()).optional(),
});

const PriceListBody = z.object({
  list_name: z.string().optional(), tenant_id: z.number().int().nullable().optional(), item_id: z.string().min(1),
  item_description: z.string().optional(), base_price: z.number().optional(), special_price: z.number().optional(),
  discount_pct: z.number().optional(), min_qty: z.number().optional(), valid_from: z.string().optional(), valid_to: z.string().optional(),
});

const SurveyBody = z.object({ survey_name: z.string().min(1), survey_type: z.string().optional(), trigger: z.string().optional() });
const SurveyResponseBody = z.object({
  tenant_id: z.number().int().nullable().optional(), order_no: z.string().optional(),
  nps_score: z.number().int().min(0).max(10).optional(), comments: z.string().optional(),
  q1: z.string().optional(), q2: z.string().optional(), q3: z.string().optional(),
});

@Controller('api')
export class MarketingController {
  constructor(private readonly svc: MarketingService) {}

  // ── CAMPAIGNS ──
  @Post('marketing/campaigns') @Permissions('marketing')
  createCampaign(@Body(new ZodValidationPipe(CampaignBody)) b: CreateCampaignDto, @CurrentUser() u: JwtUser) { return this.svc.createCampaign(b, u); }

  @Patch('marketing/campaigns/:id/toggle') @Permissions('marketing')
  toggleCampaign(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.toggleCampaign(Number(id), u); }

  @Get('marketing/campaigns') @Permissions('marketing')
  listCampaigns() { return this.svc.listCampaigns(); }

  @Get('marketing/campaigns/active') @Permissions('cust_dash', 'track')
  activeCampaigns() { return this.svc.activeCampaigns(); }

  // ── SEGMENTS ──
  @Get('marketing/segments') @Permissions('marketing')
  segments() { return this.svc.segments(); }

  // ── A/B TESTS ──
  @Post('marketing/ab-tests') @Permissions('marketing')
  createAbTest(@Body(new ZodValidationPipe(AbTestBody)) b: CreateAbTestDto, @CurrentUser() u: JwtUser) { return this.svc.createAbTest(b, u); }

  @Get('marketing/ab-tests') @Permissions('marketing')
  listAbTests() { return this.svc.listAbTests(); }

  // ── ABANDONED CARTS ──
  @Post('marketing/abandoned-carts/remind') @Permissions('marketing')
  remindCarts() { return this.svc.remindAbandonedCarts(); }

  // ── PROMOTIONS ──
  @Get('promotions') @Permissions('marketing')
  listPromotions() { return this.svc.listPromotions(); }

  @Post('promotions') @Permissions('marketing')
  createPromotion(@Body(new ZodValidationPipe(PromotionBody)) b: CreatePromotionDto, @CurrentUser() u: JwtUser) { return this.svc.createPromotion(b, u); }

  @Patch('promotions/:id/toggle') @Permissions('marketing')
  togglePromotion(@Param('id') id: string) { return this.svc.togglePromotion(Number(id)); }

  // ── PRICE LIST ──
  @Get('price-list') @Permissions('marketing')
  listPriceList() { return this.svc.listPriceList(); }

  @Post('price-list') @Permissions('marketing')
  createPriceList(@Body(new ZodValidationPipe(PriceListBody)) b: CreatePriceListDto) { return this.svc.createPriceList(b); }

  // ── SURVEYS ──
  @Get('surveys') @Permissions('marketing')
  listSurveys() { return this.svc.listSurveys(); }

  @Post('surveys') @Permissions('marketing')
  createSurvey(@Body(new ZodValidationPipe(SurveyBody)) b: CreateSurveyDto) { return this.svc.createSurvey(b); }

  @Post('surveys/:id/responses') @Permissions('marketing')
  createSurveyResponse(@Param('id') id: string, @Body(new ZodValidationPipe(SurveyResponseBody)) b: SurveyResponseDto) { return this.svc.createSurveyResponse(id, b); }
}
