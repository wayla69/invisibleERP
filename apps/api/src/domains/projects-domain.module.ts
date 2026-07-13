import { Module } from '@nestjs/common';
import { ProjectsModule } from '../modules/projects/projects.module';
import { PmrModule } from '../modules/pmr/pmr.module';
import { ProgressBillingModule } from '../modules/progress-billing/progress-billing.module';
import { SubcontractsModule } from '../modules/subcontracts/subcontracts.module';
import { TendersModule } from '../modules/tenders/tenders.module';
import { RealEstateModule } from '../modules/realestate/realestate.module';

// docs/46 Phase 5 — project & construction delivery (PPM · PMR · progress billing · subcontracts · tenders · real estate) aggregate.
// Pure WIRING: no providers/controllers of its own — it only groups the domain's feature modules so
// app.module.ts reads as ~10 domains instead of a 140-line flat array, ownership is legible, and a new
// feature module lands as a one-line change HERE (merge conflicts stay local to the domain). Cosmetic for
// DI: Nest registers the transitive imports identically; cross-module injection still flows through each
// feature module's own imports/exports.
@Module({
  imports: [
    ProjectsModule,
    PmrModule,
    ProgressBillingModule,
    SubcontractsModule,
    TendersModule,
    RealEstateModule,
  ],
  // Re-export every member so providers the feature modules export stay visible to AppModule's own
  // injector context (the APP_GUARD/APP_INTERCEPTOR providers resolve there — e.g. JwtAuthGuard's
  // ApiKeyService) exactly as when the modules were direct imports.
  exports: [
    ProjectsModule,
    PmrModule,
    ProgressBillingModule,
    SubcontractsModule,
    TendersModule,
    RealEstateModule,
  ],
})
export class ProjectsDomainModule {}
