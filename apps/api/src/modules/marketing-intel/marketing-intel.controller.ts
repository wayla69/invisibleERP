import { Controller, Get } from '@nestjs/common';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { MarketingIntelService } from './marketing-intel.service';

// Internal read surface for the /marketing-intel web page. Gated to the marketing/exec duties (the same
// audience as the CRM / campaigns workspace). The WRITE side is the public API (scope analytics:write) —
// see PublicApiController POST /api/v1/analytics/snapshots — so the external platform never touches a
// human-JWT route.
@Controller('api/marketing-intel')
export class MarketingIntelController {
  constructor(private readonly svc: MarketingIntelService) {}

  @Get('summary')
  @Permissions('marketing', 'exec')
  summary(@CurrentUser() u: JwtUser) {
    return this.svc.getSummary(u);
  }
}
