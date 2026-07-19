import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MenuModule } from '../menu/menu.module';
import { GiftCardsModule } from '../giftcards/gift-card.module';
import { TaxDocsModule } from '../tax/documents/tax-docs.module';
import { ReturnsService } from './returns.service';
import { ReturnsController } from './returns.controller';

// POS item-level returns. DocNumberService + DRIZZLE are global. TaxDocsModule provides TaxInvoiceService
// (#2: auto-issue a credit note ใบลดหนี้ on a return so the output-VAT report is reduced).
@Module({
  imports: [PaymentsModule, LedgerModule, MenuModule, GiftCardsModule, TaxDocsModule],
  controllers: [ReturnsController],
  providers: [ReturnsService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
