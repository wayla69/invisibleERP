import { Module } from '@nestjs/common';
import { StockOpsService } from './stock-ops.service';
import { StocktakeController, StockMovementController } from './stock-ops.controller';
import { TransferOrderService } from './transfer-order.service';
import { TransferOrderController } from './transfer-order.controller';
import { InventoryModule } from '../inventory/inventory.module';

// Stocktake + manual goods issue/transfer + two-step inter-warehouse transfer ORDERS (INV-2/INV-16).
// DocNumberService + DRIZZLE are global. Imports InventoryModule for the perpetual valued sub-ledger
// (InventoryLedgerService) so that tracked-item movements post valued moves + GL (incl. the in-transit
// Goods-in-Transit legs) alongside the audit log.
@Module({
  imports: [InventoryModule],
  controllers: [StocktakeController, StockMovementController, TransferOrderController],
  providers: [StockOpsService, TransferOrderService],
  exports: [StockOpsService, TransferOrderService],
})
export class StockOpsModule {}
