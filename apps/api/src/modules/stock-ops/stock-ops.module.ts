import { Module } from '@nestjs/common';
import { StockOpsService } from './stock-ops.service';
import { StocktakeController, StockMovementController } from './stock-ops.controller';
import { InventoryModule } from '../inventory/inventory.module';

// Stocktake + manual goods issue/transfer. DocNumberService + DRIZZLE are global.
// Imports InventoryModule for the perpetual valued sub-ledger (InventoryLedgerService) so that
// tracked-item movements post valued moves + GL alongside the audit log.
@Module({
  imports: [InventoryModule],
  controllers: [StocktakeController, StockMovementController],
  providers: [StockOpsService],
  exports: [StockOpsService],
})
export class StockOpsModule {}
