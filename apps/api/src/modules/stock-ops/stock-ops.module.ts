import { Module } from '@nestjs/common';
import { StockOpsService } from './stock-ops.service';
import { StocktakeController, StockMovementController } from './stock-ops.controller';
import { CycleCountService } from './cycle-count.service';
import { CycleCountController } from './cycle-count.controller';
import { InventoryModule } from '../inventory/inventory.module';

// Stocktake + manual goods issue/transfer + cycle-count program. DocNumberService + DRIZZLE are global.
// Imports InventoryModule for the perpetual valued sub-ledger (InventoryLedgerService) so that
// tracked-item movements post valued moves + GL alongside the audit log.
// INV-3 / INV-17: CycleCountService/Controller add the ABC-classified, cadence-driven blind cycle-count
// program that SCHEDULES + BLINDS a count and feeds the EXISTING stocktake post path (StockOpsService).
@Module({
  imports: [InventoryModule],
  controllers: [StocktakeController, StockMovementController, CycleCountController],
  providers: [StockOpsService, CycleCountService],
  exports: [StockOpsService, CycleCountService],
})
export class StockOpsModule {}
