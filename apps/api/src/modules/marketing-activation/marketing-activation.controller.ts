import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { FactLayerService } from './fact-layer.service';
import { PropensityService } from './propensity.service';
import { SegmentChannelRoiService } from './segment-channel-roi.service';
import { NbaOrchestratorService, type JourneyOpts } from './nba-orchestrator.service';

const qintOpt = (v?: string): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// Marketing Activation (docs/61) — the read-only fact + scoring surface. Gated to the marketing/exec duties
// (the same audience as /marketing-intel). Every activation tool (①–⑤) reads from here. All endpoints are
// advisory reads — none contacts a customer or posts spend (MKT-23).
@Controller('api/marketing-activation')
export class MarketingActivationController {
  constructor(
    private readonly facts: FactLayerService,
    private readonly propensity: PropensityService,
    private readonly segChannel: SegmentChannelRoiService,
    private readonly nba: NbaOrchestratorService,
  ) {}

  @Get('facts/customer/:code')
  @Permissions('marketing', 'exec')
  customerFacts(@Param('code') code: string, @CurrentUser() u: JwtUser) {
    return this.facts.customerFacts(u, code);
  }

  @Get('facts/segment/:segment')
  @Permissions('marketing', 'exec')
  segmentFacts(@Param('segment') segment: string, @CurrentUser() u: JwtUser) {
    return this.facts.segmentFacts(u, segment);
  }

  // ③ Propensity & Cross-Sell — per customer: the ranked "next product to offer" (advisory).
  @Get('propensity/customer/:code')
  @Permissions('marketing', 'exec')
  nextBestOffers(
    @Param('code') code: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('top') top: string | undefined,
    @CurrentUser() u: JwtUser,
  ) {
    return this.propensity.nextBestOffers(u, code, { from, to, top: qintOpt(top) });
  }

  // ③ Propensity & Cross-Sell — per product: the ranked "best audiences to push it to" (advisory).
  @Get('propensity/item/:itemId')
  @Permissions('marketing', 'exec')
  bestAudiences(
    @Param('itemId') itemId: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('top') top: string | undefined,
    @CurrentUser() u: JwtUser,
  ) {
    return this.propensity.bestAudiences(u, itemId, { from, to, top: qintOpt(top) });
  }

  // ⑤ Segment×Channel ROI — rank segment × channel cells by incremental ROI × value (advisory read).
  @Get('segment-channel-roi')
  @Permissions('marketing', 'exec')
  segmentChannelRoi(
    @Query('budget') budget: string | undefined,
    @Query('top') top: string | undefined,
    @CurrentUser() u: JwtUser,
  ) {
    return this.segChannel.rank(u, { budget: qintOpt(budget), top: qintOpt(top) });
  }

  // ⑤ Segment×Channel ROI — STAGE the recommended split as a maker-checker budget plan (reuses MKT-17).
  @Post('segment-channel-roi/stage')
  @Permissions('marketing', 'exec', 'pr_raise')
  stageSegmentChannelPlan(
    @Body() body: { total_budget: number; top?: number; note?: string },
    @CurrentUser() u: JwtUser,
  ) {
    return this.segChannel.stage(u, body ?? { total_budget: 0 });
  }

  // ② NBA Orchestrator — advisory preview of the prioritised per-customer journey (no persistence).
  @Get('nba/preview')
  @Permissions('marketing', 'exec')
  nbaPreview(
    @Query('segment') segment: string | undefined,
    @Query('control_pct') controlPct: string | undefined,
    @Query('max_targets') maxTargets: string | undefined,
    @Query('recent_days') recentDays: string | undefined,
    @CurrentUser() u: JwtUser,
  ) {
    return this.nba.preview(u, { segment, control_pct: qintOpt(controlPct), max_targets: qintOpt(maxTargets), recent_days: qintOpt(recentDays) });
  }

  // ② NBA Orchestrator — STAGE a journey (Pending); a DIFFERENT user must activate it.
  @Post('nba/stage')
  @Permissions('marketing', 'exec', 'crm_campaign')
  nbaStage(@Body() body: JourneyOpts, @CurrentUser() u: JwtUser) {
    return this.nba.stageJourney(u, body ?? {});
  }

  @Get('nba/journeys')
  @Permissions('marketing', 'exec')
  nbaJourneys(@CurrentUser() u: JwtUser) {
    return this.nba.listJourneys(u);
  }

  // ② NBA Orchestrator — ACTIVATE a staged journey (maker-checker; creates a consent-gated draft, no send).
  @Post('nba/activate')
  @Permissions('marketing', 'exec', 'crm_campaign')
  nbaActivate(@Body() body: { journey_no: string; self_approval_reason?: string }, @CurrentUser() u: JwtUser) {
    return this.nba.activateJourney(u, body ?? { journey_no: '' });
  }
}
