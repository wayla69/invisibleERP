import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxModule } from '../tax/tax.module';
import { MatchModule } from '../match/match.module';

@Module({
  imports: [LedgerModule, TaxModule, MatchModule],
  controllers: [FinanceController, CollectionsController],
  providers: [FinanceService, CollectionsService],
  exports: [FinanceService, CollectionsService],
})
export class FinanceModule {}
