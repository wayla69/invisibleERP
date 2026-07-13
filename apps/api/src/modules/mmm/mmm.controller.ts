import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';
import { MmmIngestService } from './mmm-ingest.service';
import { MmmModelService } from './mmm-model.service';
import { MmmReadsService } from './mmm-reads.service';

// docs/48 — Marketing Mix Modeling. Gated to marketing/exec throughout (same duty as reputation +
// marketing_roi; no new permission). Ingest endpoints receive external signals; the run endpoint executes
// the model; the read endpoints serve the /mmm dashboard (web UI is a phase-2 follow-up).
const SocialFeedBody = z.object({ platform: z.string().min(1).max(20), payload: z.unknown() });
const SalesDailyBody = z.object({
  rows: z.array(z.object({
    bizDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    productSku: z.string().max(50).optional(),
    revenue: z.number().finite(),
    unitsSold: z.number().int().optional(),
    utmSource: z.string().max(50).optional(),
    promoCode: z.string().max(50).optional(),
  })).min(1).max(1000),
});
const SentimentBody = z.object({
  rows: z.array(z.object({
    bizDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    platform: z.string().min(1).max(20),
    keywordOrTopic: z.string().max(100).optional(),
    mentionCount: z.number().int().nonnegative(),
    sentimentScore: z.number().min(-1).max(1).optional(),
  })).min(1).max(1000),
});
const CustomerBehaviorBody = z.object({
  rows: z.array(z.object({
    customerNo: z.string().min(1).max(50),
    lastPurchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    totalOrders: z.number().int().nonnegative().optional(),
    totalSpend: z.number().finite().optional(),
    avgSocialSentimentInteraction: z.number().min(-1).max(1).optional(),
  })).min(1).max(1000),
});
const RunBody = z.object({
  windowDays: z.number().int().min(1).max(365).optional(),
  spendByChannel: z.record(z.string(), z.number().nonnegative()).optional(),
});

@Controller('api/mmm')
export class MmmController {
  constructor(
    private readonly ingest: MmmIngestService,
    private readonly model: MmmModelService,
    private readonly reads: MmmReadsService,
  ) {}

  // ── Ingest (staging/core write path) ──────────────────────────────────────────────────────────────
  @Post('ingest/social-feed')
  @Permissions('marketing', 'exec')
  ingestSocialFeed(@Body() body: unknown, @CurrentUser() user: JwtUser) {
    const dto = SocialFeedBody.parse(body);
    return this.ingest.ingestSocialFeed(user, dto.platform, dto.payload);
  }

  @Post('ingest/sales-daily')
  @Permissions('marketing', 'exec')
  ingestSalesDaily(@Body() body: unknown, @CurrentUser() user: JwtUser) {
    const dto = SalesDailyBody.parse(body);
    return this.ingest.ingestSalesDaily(user, dto.rows);
  }

  @Post('ingest/sentiment')
  @Permissions('marketing', 'exec')
  ingestSentiment(@Body() body: unknown, @CurrentUser() user: JwtUser) {
    const dto = SentimentBody.parse(body);
    return this.ingest.ingestSentiment(user, dto.rows);
  }

  @Post('ingest/customer-behavior')
  @Permissions('marketing', 'exec')
  ingestCustomerBehavior(@Body() body: unknown, @CurrentUser() user: JwtUser) {
    const dto = CustomerBehaviorBody.parse(body);
    return this.ingest.upsertCustomerBehavior(user, dto.rows);
  }

  // ── Model (analytics) ─────────────────────────────────────────────────────────────────────────────
  @Post('run')
  @Permissions('marketing', 'exec')
  run(@Body() body: unknown, @CurrentUser() user: JwtUser) {
    const dto = RunBody.parse(body ?? {});
    return this.model.runModel(user, dto);
  }

  @Get('runs')
  @Permissions('marketing', 'exec')
  listRuns(@Query('limit') limit: string | undefined, @CurrentUser() user: JwtUser) {
    return this.model.listRuns(user, limit != null ? Number(limit) : undefined);
  }

  @Get('runs/:runNo')
  @Permissions('marketing', 'exec')
  getRun(@Param('runNo') runNo: string, @CurrentUser() user: JwtUser) {
    return this.model.getRun(user, runNo);
  }

  @Get('summary')
  @Permissions('marketing', 'exec')
  summary(@CurrentUser() user: JwtUser) {
    return this.model.latestSummary(user);
  }

  // ── Staging/core reads ────────────────────────────────────────────────────────────────────────────
  @Get('sales-daily')
  @Permissions('marketing', 'exec')
  salesDaily(@Query('days') days: string | undefined, @CurrentUser() user: JwtUser) {
    return this.reads.salesDaily(user, days != null ? Number(days) : undefined);
  }

  @Get('sentiment')
  @Permissions('marketing', 'exec')
  sentiment(@Query('days') days: string | undefined, @CurrentUser() user: JwtUser) {
    return this.reads.sentiment(user, days != null ? Number(days) : undefined);
  }
}
