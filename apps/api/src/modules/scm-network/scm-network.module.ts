import { Module } from '@nestjs/common';
import { ScmNetworkController } from './scm-network.controller';
import { ScmNetworkService } from './scm-network.service';

// docs/57 Track B (B1) — multi-echelon supply-network master data.
//
// A NEW bounded context (CLAUDE.md Architecture-Gatekeeper rule 1): multi-echelon network planning is
// a distinct business responsibility — NOT appended to scm-planning (single-tier order plans) nor to
// procurement (it merely ends in a PR). Registered as one line in SupplyChainDomainModule; exports the
// service so B2's optimizer + the demand planner can consume the governed topology via the public API.

@Module({
  controllers: [ScmNetworkController],
  providers: [ScmNetworkService],
  exports: [ScmNetworkService],
})
export class ScmNetworkModule {}
