import { Module } from '@nestjs/common';
import { PayrollModule } from '../modules/payroll/payroll.module';
import { HcmModule } from '../modules/hcm/hcm.module';
import { EssModule } from '../modules/ess/ess.module';

// docs/46 Phase 5 — people (payroll · HCM · employee self-service) aggregate.
// Pure WIRING: no providers/controllers of its own — it only groups the domain's feature modules so
// app.module.ts reads as ~10 domains instead of a 140-line flat array, ownership is legible, and a new
// feature module lands as a one-line change HERE (merge conflicts stay local to the domain). Cosmetic for
// DI: Nest registers the transitive imports identically; cross-module injection still flows through each
// feature module's own imports/exports.
@Module({
  imports: [
    PayrollModule,
    HcmModule,
    EssModule,
  ],
  // Re-export every member so providers the feature modules export stay visible to AppModule's own
  // injector context (the APP_GUARD/APP_INTERCEPTOR providers resolve there — e.g. JwtAuthGuard's
  // ApiKeyService) exactly as when the modules were direct imports.
  exports: [
    PayrollModule,
    HcmModule,
    EssModule,
  ],
})
export class PeopleDomainModule {}
