import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { ProcurementModule } from '../procurement/procurement.module';
import { RoutingService } from './routing.service';
import { ShopFloorService } from './shopfloor.service';
import { QualityService } from './quality.service';
import { MrpService } from './mrp.service';
import { RoutingController, ShopFloorController, QualityController, MrpController } from './mfg-depth.controller';

// Phase 18 depth — routings, shop-floor execution, quality (scrap GL), MRP planning.
// LedgerModule for the QA scrap write-down.
@Module({
  imports: [LedgerModule, ProcurementModule],
  controllers: [RoutingController, ShopFloorController, QualityController, MrpController],
  providers: [RoutingService, ShopFloorService, QualityService, MrpService],
})
export class MfgDepthModule {}
