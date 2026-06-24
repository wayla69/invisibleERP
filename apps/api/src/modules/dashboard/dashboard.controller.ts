import { Controller, Get, Put, Query, Body, Param } from '@nestjs/common';
import { Permissions, CurrentUser } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';
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

  // ── Role-based layouts (Phase 5) ──
  // Resolved dashboard for the current user (their role's configured widgets, permission-filtered, with values).
  @Get('layout/me')
  @Permissions('dashboard', 'exec')
  myLayout(@CurrentUser() user: JwtUser) { return this.svc.resolveMine(user); }

  // Widget catalog + role list, for the designer.
  @Get('widgets/catalog')
  @Permissions('users', 'exec')
  catalog() { return this.svc.widgetCatalog(); }

  // Fetch / set a role's layout (admin).
  @Get('layouts/:role')
  @Permissions('users', 'exec')
  getLayout(@Param('role') role: string, @CurrentUser() user: JwtUser) { return this.svc.getLayout(role, user); }

  @Put('layouts/:role')
  @Permissions('users', 'exec')
  setLayout(@Param('role') role: string, @Body('widgets') widgets: unknown, @CurrentUser() user: JwtUser) { return this.svc.setLayout(role, widgets, user); }
}
