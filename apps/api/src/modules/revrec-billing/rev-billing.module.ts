import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { RevBillingService } from './rev-billing.service';
import { RevBillingController } from './rev-billing.controller';

// Track D — Wave 1 (REV-24): contract-asset / contract-liability split + independent billing schedule
// (TFRS 15 / IFRS 15 / ASC 606 §105-107). Decoupled from the REV-19 recognition engine (RevenueModule).
@Module({
  imports: [LedgerModule],
  controllers: [RevBillingController],
  providers: [RevBillingService],
  exports: [RevBillingService],
})
export class RevBillingModule {}
