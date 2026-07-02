import { Module } from '@nestjs/common';
import { TaxModule } from '../tax/tax.module';
import { PaymentsModule } from '../payments/payments.module';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxDocsModule } from '../tax/documents/tax-docs.module';
import { MenuModule } from '../menu/menu.module';
import { MarketingModule } from '../marketing/marketing.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { GiftCardsModule } from '../giftcards/gift-card.module';
import { PricingModule } from '../pricing/pricing.module';
import { PrintingModule } from '../printing/printing.module';
import { PeripheralsModule } from '../peripherals/peripherals.module';
import { DineInService } from './dine-in.service';
import { KdsService } from './kds.service';
import { TableService } from './table.service';
import { QrService } from './qr.service';
import { BuffetService } from './buffet.service';
import { ChannelOrderService } from './channel-order.service';
import { RestaurantOfflineSyncService } from './offline-sync.service';
import { ReservationService } from './reservation.service';
import { TipService } from './tip.service';
import { MessagingModule } from '../messaging/messaging.module';
import { RealtimeScope } from './realtime.scope';
import { RestaurantController } from './restaurant.controller';
import { QrController } from './qr.controller';
import { ChannelController } from './channel.controller';
import { PosScaleModule } from '../pos/scale/pos-scale.module';

// Restaurant / F&B POS: dine-in orders + KDS, floor-plan tables, table QR sessions (public diner),
// online/delivery/kiosk channel orders, PromptPay pay → cust_pos_sales + GL + abbreviated tax invoice.
@Module({
  imports: [TaxModule, PaymentsModule, LedgerModule, TaxDocsModule, MenuModule, MarketingModule, LoyaltyModule, GiftCardsModule, PricingModule, PrintingModule, PeripheralsModule, PosScaleModule, MessagingModule],
  controllers: [RestaurantController, QrController, ChannelController],
  providers: [DineInService, KdsService, TableService, QrService, BuffetService, ChannelOrderService, RealtimeScope, RestaurantOfflineSyncService, ReservationService, TipService],
  exports: [DineInService, TableService],
})
export class RestaurantModule {}
