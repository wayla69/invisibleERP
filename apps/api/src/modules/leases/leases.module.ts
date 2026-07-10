import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { LeasesService } from './leases.service';
import { LeasesController } from './leases.controller';
import { LessorLeasesService } from './lessor-leases.service';
import { LessorLeasesController } from './lessor-leases.controller';

// LedgerModule supplies LedgerService for the GL postings — the lessee side (commencement + periodic
// interest/payment/ROU depreciation, LSE-01) and the lessor side (finance-lease commencement + periodic
// interest/rental income + depreciation, LSE-02). DRIZZLE + DocNumberService are global. Exported so
// BiModule can ride lease_periodic_run.
@Module({
  imports: [LedgerModule],
  providers: [LeasesService, LessorLeasesService],
  controllers: [LeasesController, LessorLeasesController],
  exports: [LeasesService, LessorLeasesService],
})
export class LeasesModule {}
