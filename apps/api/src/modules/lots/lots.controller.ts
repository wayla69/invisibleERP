import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';
import { LotsService } from './lots.service';
import { qintOpt } from '../../common/query';

@Controller('api/lots')
@Permissions('lots', 'warehouse')
export class LotsController {
  constructor(private readonly svc: LotsService) {}

  @Get() ledger(@Query('item_id') itemId?: string, @Query('location') location?: string, @Query('status') status?: string, @Query('limit') limit?: string) {
    return this.svc.ledger({ item_id: itemId, location, status, limit: qintOpt('limit', limit) });
  }
  @Get('expiry') expiry() { return this.svc.expiry(); }
  @Get('fefo/:itemId') fefo(@Param('itemId') itemId: string) { return this.svc.fefo(itemId); }

  // INV-18 — lot genealogy trace (backward: GR → supplier; forward: pick/sale → customer).
  @Get(':lotNo/trace') trace(@Param('lotNo') lotNo: string) { return this.svc.trace(lotNo); }

  // INV-18 — quarantine / release. wh_adjust is the inventory-control duty; lots/warehouse can also act.
  @Post(':lotNo/hold') @Permissions('lots', 'warehouse', 'wh_adjust')
  hold(@Param('lotNo') lotNo: string, @Body() body: { reason?: string; item_id?: string }, @Req() req: { user: JwtUser }) {
    return this.svc.hold(lotNo, body ?? {}, req.user);
  }
  @Post(':lotNo/release') @Permissions('lots', 'warehouse', 'wh_adjust')
  release(@Param('lotNo') lotNo: string, @Body() body: { reason?: string }, @Req() req: { user: JwtUser }) {
    return this.svc.release(lotNo, body ?? {}, req.user);
  }
}
