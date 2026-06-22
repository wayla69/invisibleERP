import { Controller, Get, Param, Query } from '@nestjs/common';
import { Permissions } from '../../common/decorators';
import { LotsService } from './lots.service';

@Controller('api/lots')
@Permissions('lots', 'warehouse')
export class LotsController {
  constructor(private readonly svc: LotsService) {}

  @Get() ledger(@Query('item_id') itemId?: string, @Query('location') location?: string, @Query('status') status?: string, @Query('limit') limit?: string) {
    return this.svc.ledger({ item_id: itemId, location, status, limit: limit ? +limit : undefined });
  }
  @Get('expiry') expiry() { return this.svc.expiry(); }
  @Get('fefo/:itemId') fefo(@Param('itemId') itemId: string) { return this.svc.fefo(itemId); }
}
