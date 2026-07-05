import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { ArInvoicePdfService } from './ar-invoice-pdf.service';
import { FinancialHealthService } from './financial-health.service';
import { ArAllowanceService } from './ar-allowance.service';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxModule } from '../tax/tax.module';
import { MatchModule } from '../match/match.module';
import { MessagingModule } from '../messaging/messaging.module';
import { CommitmentsModule } from '../commitments/commitments.module';

@Module({
  imports: [LedgerModule, TaxModule, MatchModule, MessagingModule, CommitmentsModule],
  controllers: [FinanceController, CollectionsController],
  providers: [FinanceService, ArInvoicePdfService, FinancialHealthService, ArAllowanceService, CollectionsService],
  exports: [FinanceService, FinancialHealthService, ArAllowanceService, CollectionsService],
})
export class FinanceModule {}
