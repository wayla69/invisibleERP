import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { ArInvoicePdfService } from './ar-invoice-pdf.service';
import { FinanceDocsPdfService } from './finance-docs-pdf.service';
import { FinancialHealthService } from './financial-health.service';
import { ArAllowanceService } from './ar-allowance.service';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';
import { FinanceMetricsController } from './finance-metrics.controller';
import { FinanceMetricsService } from './finance-metrics.service';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxModule } from '../tax/tax.module';
import { MatchModule } from '../match/match.module';
import { MessagingModule } from '../messaging/messaging.module';
import { CommitmentsModule } from '../commitments/commitments.module';
import { BudgetModule } from '../budget/budget.module';

@Module({
  imports: [LedgerModule, TaxModule, MatchModule, MessagingModule, CommitmentsModule, BudgetModule],
  controllers: [FinanceController, CollectionsController, FinanceMetricsController],
  providers: [FinanceService, ArInvoicePdfService, FinanceDocsPdfService, FinancialHealthService, ArAllowanceService, CollectionsService, FinanceMetricsService],
  exports: [FinanceService, FinancialHealthService, ArAllowanceService, CollectionsService, FinanceMetricsService],
})
export class FinanceModule {}
