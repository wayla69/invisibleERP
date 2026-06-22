import { Module } from '@nestjs/common';
import { WmsController, ReplenishmentController, RmaController } from './wms.controller';
import { WmsService } from './wms.service';
import { ReplenishmentService } from './replenishment.service';
import { RmaService } from './rma.service';
import { ProcurementModule } from '../procurement/procurement.module';
import { ReturnsModule } from '../returns/returns.module';

// Phase 17B — WMS execution (bins/pick/pack/ship/wave) + min-max replenishment + RMA.
// DocNumberService + DRIZZLE are global. No LedgerModule — WMS posts no GL (RMA reuses ReturnsService).
@Module({
  imports: [ProcurementModule, ReturnsModule],
  controllers: [WmsController, ReplenishmentController, RmaController],
  providers: [WmsService, ReplenishmentService, RmaService],
  exports: [WmsService, ReplenishmentService, RmaService],
})
export class WmsModule {}
