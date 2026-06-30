import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { ProcurementModule } from '../procurement/procurement.module';
import { RoutingService } from './routing.service';
import { ShopFloorService } from './shopfloor.service';
import { QualityService } from './quality.service';
import { MrpService } from './mrp.service';
import { ApsService } from './aps.service';
import { RoutingController, ShopFloorController, QualityController, MrpController, WorkCenterController, ApsController } from './mfg-depth.controller';

// Phase 18 depth — routings, shop-floor execution, quality (scrap GL), MRP planning, APS finite-capacity
// scheduling (docs/22 Phase A). LedgerModule for the QA scrap write-down.
@Module({
  imports: [LedgerModule, ProcurementModule],
  controllers: [RoutingController, ShopFloorController, QualityController, MrpController, WorkCenterController, ApsController],
  providers: [RoutingService, ShopFloorService, QualityService, MrpService, ApsService],
})
export class MfgDepthModule {}
