import { Module } from '@nestjs/common';
import { StockOpsService } from './stock-ops.service';
import { StocktakeController, StockMovementController } from './stock-ops.controller';

// Stocktake + manual goods issue/transfer. DocNumberService + DRIZZLE are global.
@Module({
  controllers: [StocktakeController, StockMovementController],
  providers: [StockOpsService],
  exports: [StockOpsService],
})
export class StockOpsModule {}
