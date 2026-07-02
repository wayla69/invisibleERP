import { Module } from '@nestjs/common';
import { PosController, OrdersController } from './pos.controller';
import { PosService } from './pos.service';
import { SplitController } from './split.controller';
import { SplitBillService } from './split.service';
import { ReceiptController } from './receipt.controller';
import { ReceiptService } from './receipt.service';
import { ReceiptDeliveryService, NoopReceiptProvider } from './receipt-delivery.service';
import { CfdService } from './cfd.service';
import { TaxDocsPdfService } from '../tax/documents/tax-docs-pdf.service';
import { RestaurantModule } from '../restaurant/restaurant.module';
import { PaymentsModule } from '../payments/payments.module';
import { TaxModule } from '../tax/tax.module';

@Module({
  imports: [RestaurantModule, PaymentsModule, TaxModule],
  controllers: [PosController, OrdersController, SplitController, ReceiptController],
  // TaxDocsPdfService has no own deps → provide it directly (no cross-module export needed).
  providers: [PosService, SplitBillService, ReceiptService, ReceiptDeliveryService, NoopReceiptProvider, CfdService, TaxDocsPdfService],
  exports: [PosService],
})
export class PosModule {}
