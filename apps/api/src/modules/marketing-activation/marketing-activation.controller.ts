import { Controller, Get, Param, Query } from '@nestjs/common';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { FactLayerService } from './fact-layer.service';
import { PropensityService } from './propensity.service';

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
}
