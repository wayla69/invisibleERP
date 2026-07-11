import { Module } from '@nestjs/common';
import { StockOpsService } from './stock-ops.service';
import { StocktakeController, StockMovementController } from './stock-ops.controller';
import { CycleCountService } from './cycle-count.service';
import { CycleCountController } from './cycle-count.controller';
import { TransferOrderService } from './transfer-order.service';
import { TransferOrderController } from './transfer-order.controller';
import { InventoryModule } from '../inventory/inventory.module';

// Stocktake + manual goods issue/transfer + two-step inter-warehouse transfer ORDERS (INV-2/INV-16)
// + the ABC-classified, cadence-driven blind cycle-count program (INV-3/INV-17). DocNumberService +
// DRIZZLE are global. Imports InventoryModule for the perpetual valued sub-ledger (InventoryLedgerService)
// so tracked-item movements post valued moves + GL (incl. in-transit Goods-in-Transit legs) alongside audit.
@Module({
  imports: [InventoryModule],
  controllers: [StocktakeController, StockMovementController, TransferOrderController, CycleCountController],
  providers: [StockOpsService, TransferOrderService, CycleCountService],
  exports: [StockOpsService, TransferOrderService, CycleCountService],
})
export class StockOpsModule {}
