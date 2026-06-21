import { Module } from '@nestjs/common';
import { TaxModule } from '../tax/tax.module';
import { PaymentsModule } from '../payments/payments.module';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxDocsModule } from '../tax-docs/tax-docs.module';
import { MenuModule } from '../menu/menu.module';
import { MarketingModule } from '../marketing/marketing.module';
import { DineInService } from './dine-in.service';
import { KdsService } from './kds.service';
import { TableService } from './table.service';
import { QrService } from './qr.service';
import { RealtimeScope } from './realtime.scope';
import { RestaurantController } from './restaurant.controller';
import { QrController } from './qr.controller';

// Restaurant / F&B POS: dine-in orders + KDS, floor-plan tables, table QR sessions (public diner),
// PromptPay pay → cust_pos_sales + GL + abbreviated tax invoice. DocNumberService is global (CommonModule).
@Module({
  imports: [TaxModule, PaymentsModule, LedgerModule, TaxDocsModule, MenuModule, MarketingModule],
  controllers: [RestaurantController, QrController],
  providers: [DineInService, KdsService, TableService, QrService, RealtimeScope],
  exports: [DineInService, TableService],
})
export class RestaurantModule {}
