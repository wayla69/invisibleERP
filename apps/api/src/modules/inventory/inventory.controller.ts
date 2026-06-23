import { Controller, Get, Param, Query } from '@nestjs/common';
import { StockQuery } from '@ierp/shared';
import { Permissions } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { InventoryService } from './inventory.service';
import { qint, qintOpt } from '../../common/query';

@Controller('api/inventory')
export class InventoryController {
  constructor(private readonly svc: InventoryService) {}

  @Get('stock')
  @Permissions('warehouse', 'dashboard', 'planner')
  getStock(@Query(new ZodValidationPipe(StockQuery)) q: StockQuery) {
    return this.svc.getStock(q);
  }

  @Get('stock/:itemId')
  @Permissions('warehouse', 'dashboard', 'planner')
  getStockDetail(@Param('itemId') itemId: string) {
    return this.svc.getStockDetail(itemId);
  }

  @Get('suppliers')
  @Permissions('warehouse', 'procurement', 'dashboard')
  getSuppliers() {
    return this.svc.getSuppliers();
  }

  @Get('purchase-orders')
  @Permissions('procurement', 'warehouse', 'dashboard')
  getPurchaseOrders(@Query('limit') limit?: string, @Query('offset') offset?: string, @Query('status') status?: string) {
    return this.svc.getPurchaseOrders(qint('limit', limit, 20), qint('offset', offset, 0), status);
  }
}
