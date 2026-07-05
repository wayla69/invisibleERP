import { Controller, Get, Param, Query } from '@nestjs/common';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { FinanceMetricsService } from './finance-metrics.service';

// docs/35 Phase 1 — CFO KPI scorecard. Read-only aggregation over the ledger/sub-ledgers; every value
// reconciles to the statement it drills from. Perms mirror the other finance-analytics reads (exec board).
@Controller('api/finance/metrics')
export class FinanceMetricsController {
  constructor(private readonly svc: FinanceMetricsService) {}

  // The canonical ~32-KPI scorecard with prior-period / prior-year / budget comparatives + RAG.
  // Optional filters: as_of=YYYY-MM-DD · period=YYYY-MM · from/to (custom window) · group=<metric group>.
  @Get('pack') @Permissions('exec', 'fin_report', 'dashboard', 'ar', 'creditors')
  pack(
    @CurrentUser() u: JwtUser,
    @Query('as_of') asOf?: string,
    @Query('period') period?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('group') group?: string,
  ) {
    return this.svc.pack({ as_of: asOf, period, from, to, group }, u);
  }

  // Single-KPI monthly trend (sparkline + table) for the last N months (default 12, max 24).
  @Get(':id/trend') @Permissions('exec', 'fin_report', 'dashboard', 'ar', 'creditors')
  trend(@Param('id') id: string, @CurrentUser() u: JwtUser, @Query('periods') periods?: string, @Query('as_of') asOf?: string) {
    return this.svc.trend(id, { periods: periods ? Number(periods) : undefined, as_of: asOf }, u);
  }

  // Drill-through: the GL account-group rows behind a KPI, as of a date.
  @Get(':id/drill') @Permissions('exec', 'fin_report', 'dashboard', 'ar', 'creditors')
  drill(@Param('id') id: string, @CurrentUser() u: JwtUser, @Query('as_of') asOf?: string) {
    return this.svc.drill(id, { as_of: asOf }, u);
  }
}
