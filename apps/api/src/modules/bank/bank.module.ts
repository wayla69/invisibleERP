import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { BankService } from './bank.service';
import { BankController } from './bank.controller';

// Bank reconciliation. DocNumberService + DRIZZLE are global; LedgerService for fee/interest GL adjustments.
@Module({
  imports: [LedgerModule],
  controllers: [BankController],
  providers: [BankService],
  exports: [BankService],
})
export class BankModule {}
