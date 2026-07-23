import { Controller, Get, Param } from '@nestjs/common';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { FactLayerService } from './fact-layer.service';

// Marketing Activation (docs/61) — the read-only Fact Layer surface. Gated to the marketing/exec duties (the
// same audience as /marketing-intel). Every activation tool (①–⑤) reads its facts from here.
@Controller('api/marketing-activation')
export class MarketingActivationController {
  constructor(private readonly facts: FactLayerService) {}

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
}
