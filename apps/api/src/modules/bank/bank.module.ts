import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { BankService } from './bank.service';
import { BankController } from './bank.controller';
import { PromptPayReconService } from './promptpay-recon.service';
import { PromptPayReconController } from './promptpay-recon.controller';

// Bank reconciliation. DocNumberService + DRIZZLE are global; LedgerService for fee/interest GL adjustments.
// PromptPay store-level auto-reconciliation (POS-8) reuses the same match engine, so it lives here too.
@Module({
  imports: [LedgerModule],
  controllers: [BankController, PromptPayReconController],
  providers: [BankService, PromptPayReconService],
  exports: [BankService, PromptPayReconService],
})
export class BankModule {}
