import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { LeasesService } from './leases.service';
import { LeasesController } from './leases.controller';

// LedgerModule supplies LedgerService for the GL postings (commencement + periodic interest/payment/ROU
// depreciation). DRIZZLE + DocNumberService are global. Exported so BiModule can ride lease_periodic_run.
@Module({ imports: [LedgerModule], providers: [LeasesService], controllers: [LeasesController], exports: [LeasesService] })
export class LeasesModule {}
