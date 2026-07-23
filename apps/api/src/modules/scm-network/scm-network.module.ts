import { Module } from '@nestjs/common';
import { ProcurementModule } from '../procurement/procurement.module';
import { ScmPlanningModule } from '../scm-planning/scm-planning.module';
import { ScmNetworkController } from './scm-network.controller';
import { ScmNetworkService } from './scm-network.service';
import { ScmNetworkExtractService } from './scm-network-extract.service';
import { ScmNetworkRunService } from './scm-network-run.service';
import { ScmNetworkPlanService } from './scm-network-plan.service';

// docs/57 Track B (B1 + B2b) — multi-echelon supply-network master data + two-echelon planning.
//
// A NEW bounded context (CLAUDE.md Architecture-Gatekeeper rule 1): multi-echelon network planning is
// a distinct business responsibility — NOT appended to scm-planning (single-tier order plans) nor to
// procurement (it merely ends in a PR). Registered as one line in SupplyChainDomainModule; exports the
// master-data service so peers can consume the governed topology via the public API. B2b imports
// ScmPlanningModule (its PUBLIC demand-path seam + the ONE engine client) and ProcurementModule (the
// createPr roll-up seam) — loose coupling, no cross-module table access.

@Module({
  imports: [ScmPlanningModule, ProcurementModule],
  controllers: [ScmNetworkController],
  providers: [ScmNetworkService, ScmNetworkExtractService, ScmNetworkRunService, ScmNetworkPlanService],
  exports: [ScmNetworkService],
})
export class ScmNetworkModule {}
