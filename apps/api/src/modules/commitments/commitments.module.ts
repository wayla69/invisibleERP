import { Module } from '@nestjs/common';
import { CommitmentsService } from './commitments.service';

// Project commitment / encumbrance ledger (M1, docs/32, PROJ-12). Standalone (DRIZZLE only) so both the
// procurement module (reserve on a project PO; release on cancel; consume on receipt) and the projects module
// (per-BoQ-line budget/committed/remaining read model) depend on it without a module cycle.
@Module({
  providers: [CommitmentsService],
  exports: [CommitmentsService],
})
export class CommitmentsModule {}
