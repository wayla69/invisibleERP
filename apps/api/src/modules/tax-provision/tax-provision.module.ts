import { Module } from '@nestjs/common';
import { TaxProvisionController } from './tax-provision.controller';
import { TaxProvisionService } from './tax-provision.service';
import { LedgerModule } from '../ledger/ledger.module';

// TAX-11 — Current income-tax provision + ETR reconciliation. Depends on LedgerModule for
// incomeStatement (pretax book income) + postEntry (the provision JE Dr 5960 / Cr 2110).
@Module({
  imports: [LedgerModule],
  controllers: [TaxProvisionController],
  providers: [TaxProvisionService],
  exports: [TaxProvisionService],
})
export class TaxProvisionModule {}
