import { Module } from '@nestjs/common';
import { RetentionService } from './retention.service';
import { RetentionController } from './retention.controller';

// Shared retention sub-ledger (docs/35 Phase 0). Standalone (DRIZZLE only, like CommitmentsModule) so the
// projects/AR side (Track A progress billing) and the procurement/AP side (Track B subcontract valuations)
// can both depend on RetentionService without a module cycle. Exports the service for that reuse.
@Module({
  controllers: [RetentionController],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
