import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { RetentionModule } from '../retention/retention.module';
import { ProgressBillingService } from './progress-billing.service';
import { ProgressBillingController } from './progress-billing.controller';
import { ProgressClaimPdfService } from './progress-claim-pdf.service';

// Progress billing / งวดงาน (docs/35 P1, PROJ-15). Needs the GL (LedgerModule → post the billing JE) and the
// shared retention sub-ledger (RetentionModule → withhold retention on certification). One-way imports (Ledger
// and Retention don't import this) → no DI cycle. DocNumberService comes from the @Global CommonModule.
@Module({
  imports: [LedgerModule, RetentionModule],
  controllers: [ProgressBillingController],
  providers: [ProgressBillingService, ProgressClaimPdfService],
  exports: [ProgressBillingService],
})
export class ProgressBillingModule {}
