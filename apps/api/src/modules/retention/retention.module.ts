import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { RetentionService } from './retention.service';
import { RetentionController } from './retention.controller';
import { RetentionBiReports } from './retention-bi-reports';

// Shared retention sub-ledger (docs/35 Phase 0). Standalone (DRIZZLE only, like CommitmentsModule) so the
// projects/AR side (Track A progress billing) and the procurement/AP side (Track B subcontract valuations)
// can both depend on RetentionService without a module cycle. Exports the service for that reuse.
@Module({
  imports: [LedgerModule],
  controllers: [RetentionController],
  providers: [RetentionBiReports, RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
