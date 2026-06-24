import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { CashflowService } from './cashflow.service';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxModule } from '../tax/tax.module';
import { MatchModule } from '../match/match.module';

@Module({ imports: [LedgerModule, TaxModule, MatchModule], controllers: [FinanceController], providers: [FinanceService, CashflowService], exports: [FinanceService, CashflowService] })
export class FinanceModule {}
