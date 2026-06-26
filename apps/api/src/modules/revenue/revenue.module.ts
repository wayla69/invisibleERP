import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { RevenueService } from './revenue.service';
import { RevenueController } from './revenue.controller';
import { RevRecService } from './revrec.service';
import { RevRecController } from './revrec.controller';

// Revenue recognition / deferred revenue. DocNumberService + DRIZZLE are global; LedgerService for GL.
// RevRec* = the TFRS 15 contract/PO/SSP engine (WS3.4, REV-19); Revenue* = the legacy DEFREV schedule.
@Module({
  imports: [LedgerModule],
  controllers: [RevenueController, RevRecController],
  providers: [RevenueService, RevRecService],
  exports: [RevenueService, RevRecService],
})
export class RevenueModule {}
