import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { RetentionModule } from '../retention/retention.module';
import { CommitmentsModule } from '../commitments/commitments.module';
import { SubcontractsService } from './subcontracts.service';
import { SubcontractsController } from './subcontracts.controller';

// Subcontractor management (docs/35 P2, PROJ-16). Needs the GL (LedgerModule → post the AP/WIP/retention JE),
// the shared retention sub-ledger (RetentionModule → withhold retention payable) and the commitment ledger
// (CommitmentsModule → reserve subcontract value against BoQ-line budget). One-way imports → no DI cycle.
// DocNumberService comes from the @Global CommonModule.
@Module({
  imports: [LedgerModule, RetentionModule, CommitmentsModule],
  controllers: [SubcontractsController],
  providers: [SubcontractsService],
  exports: [SubcontractsService],
})
export class SubcontractsModule {}
