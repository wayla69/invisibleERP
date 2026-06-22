import { Controller, Get, Post, Body, Param, ParseIntPipe, HttpCode } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

@Controller('api/recon')
export class ReconciliationController {
  constructor(private readonly svc: ReconciliationService) {}

  @Get('periods')
  @Permissions('exec')
  listPeriods(@CurrentUser() user: JwtUser) {
    return this.svc.listPeriods(user);
  }

  @Post('periods')
  @Permissions('exec')
  openPeriod(@Body() dto: any, @CurrentUser() user: JwtUser) {
    return this.svc.openPeriod(dto, user);
  }

  @Get('periods/:id/summary')
  @Permissions('exec')
  summary(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.svc.getPeriodSummary(id, user);
  }

  @Post('periods/:id/import-gl')
  @Permissions('exec')
  @HttpCode(200)
  importGl(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.svc.importGlItems(id, user);
  }

  @Post('periods/:id/items')
  @Permissions('exec')
  addItem(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() user: JwtUser) {
    return this.svc.addItem(id, dto, user);
  }

  @Post('periods/:id/auto-match')
  @Permissions('exec')
  @HttpCode(200)
  autoMatch(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.svc.autoMatch(id, user);
  }

  @Post('periods/:id/certify')
  @Permissions('approvals')
  @HttpCode(200)
  certify(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.svc.certify(id, user);
  }
}
