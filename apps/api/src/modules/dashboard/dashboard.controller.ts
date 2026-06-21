import { Controller, Get, Query } from '@nestjs/common';
import { Permissions } from '../../common/decorators';
import { DashboardService } from './dashboard.service';

@Controller('api/dashboard')
export class DashboardController {
  constructor(private readonly svc: DashboardService) {}

  @Get()
  @Permissions('dashboard', 'exec')
  dashboard() {
    return this.svc.getDashboard();
  }

  @Get('sales-trend')
  @Permissions('dashboard', 'exec')
  salesTrend(@Query('days') days?: string) {
    return this.svc.getSalesTrend(days ? Math.max(1, parseInt(days, 10) || 7) : 7);
  }
}
