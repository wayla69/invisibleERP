import { Module } from '@nestjs/common';
import { DashboardModule } from '../modules/dashboard/dashboard.module';
import { ReportsModule } from '../modules/reports/reports.module';
import { AnalyticsModule } from '../modules/analytics/analytics.module';
import { BiModule } from '../modules/bi/bi.module';
import { PlanningModule } from '../modules/planning/planning.module';
import { DemandMlModule } from '../modules/demand-ml/demand-ml.module';

// docs/46 Phase 5 — analytics & planning (dashboard · reports · BI · planning · demand ML) aggregate.
// Pure WIRING: no providers/controllers of its own — it only groups the domain's feature modules so
// app.module.ts reads as ~10 domains instead of a 140-line flat array, ownership is legible, and a new
// feature module lands as a one-line change HERE (merge conflicts stay local to the domain). Cosmetic for
// DI: Nest registers the transitive imports identically; cross-module injection still flows through each
// feature module's own imports/exports.
@Module({
  imports: [
    DashboardModule,
    ReportsModule,
    AnalyticsModule,
    BiModule,
    PlanningModule,
    DemandMlModule,
  ],
  // Re-export every member so providers the feature modules export stay visible to AppModule's own
  // injector context (the APP_GUARD/APP_INTERCEPTOR providers resolve there — e.g. JwtAuthGuard's
  // ApiKeyService) exactly as when the modules were direct imports.
  exports: [
    DashboardModule,
    ReportsModule,
    AnalyticsModule,
    BiModule,
    PlanningModule,
    DemandMlModule,
  ],
})
export class AnalyticsDomainModule {}
