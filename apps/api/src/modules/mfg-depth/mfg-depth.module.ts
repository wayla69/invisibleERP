import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { ProcurementModule } from '../procurement/procurement.module';
import { RoutingService } from './routing.service';
import { ShopFloorService } from './shopfloor.service';
import { QualityService } from './quality.service';
import { NcrService } from './ncr.service';
import { MrpService } from './mrp.service';
import { ApsService } from './aps.service';
import { RoutingController, ShopFloorController, QualityController, NcrController, MrpController, WorkCenterController, ApsController } from './mfg-depth.controller';

// Phase 18 depth — routings, shop-floor execution, quality (scrap GL), the NCR register with maker-checker
// disposition (QMS-1, QC-01), MRP planning, APS finite-capacity scheduling (docs/22 Phase A). LedgerModule for
// the QA scrap + NCR write-down.
@Module({
  imports: [LedgerModule, ProcurementModule],
  controllers: [RoutingController, ShopFloorController, QualityController, NcrController, MrpController, WorkCenterController, ApsController],
  providers: [RoutingService, ShopFloorService, QualityService, NcrService, MrpService, ApsService],
})
export class MfgDepthModule {}
