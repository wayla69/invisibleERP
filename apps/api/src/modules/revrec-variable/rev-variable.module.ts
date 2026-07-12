import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { RevenueModule } from '../revenue/revenue.module';
import { RevVariableService } from './rev-variable.service';
import { RevVariableController } from './rev-variable.controller';

// Track D — Wave 2 (REV-25): variable consideration + the constraint (TFRS 15 / IFRS 15 / ASC 606 §50-59).
// Extends the REV-19 recognition engine (RevenueModule exports RevRecService, REUSED for allocation + the
// unrecognized-schedule rebuild). LedgerModule for the GL true-up.
@Module({
  imports: [LedgerModule, RevenueModule],
  controllers: [RevVariableController],
  providers: [RevVariableService],
  exports: [RevVariableService],
})
export class RevVariableModule {}
