import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { RealEstateService } from './realestate.service';
import { RealEstateController } from './realestate.controller';
import { RealEstateBiReports } from './realestate-bi-reports';

// Real-estate developer vertical (docs/35 P4, RE-01/02/03). Needs the GL (LedgerModule → post booking-deposit
// / down-payment / installment receipts). One-way import → no DI cycle. DocNumberService is @Global.
// Permission-gated at the controller (re_sales / re_contract_approve) so a non-property tenant never sees it.
@Module({
  imports: [LedgerModule],
  controllers: [RealEstateController],
  providers: [RealEstateBiReports, RealEstateService],
  exports: [RealEstateService],
})
export class RealEstateModule {}
