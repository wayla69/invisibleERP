import { Module } from '@nestjs/common';
import { PosController, OrdersController } from './pos.controller';
import { PosService } from './pos.service';
import { PosProfileService } from './pos-profile.service';
import { SplitController } from './split.controller';
import { SplitBillService } from './split.service';
import { ReceiptController } from './receipt.controller';
import { ReceiptService } from './receipt.service';
import { ReceiptDeliveryService, NoopReceiptProvider } from './receipt-delivery.service';
import { CfdService } from './cfd.service';
import { TaxDocsPdfService } from '../tax/documents/tax-docs-pdf.service';
import { RealtimeScope } from '../restaurant/realtime.scope';
import { RestaurantModule } from '../restaurant/restaurant.module';
import { MessagingModule } from '../messaging/messaging.module';
import { PaymentsModule } from '../payments/payments.module';
import { TaxModule } from '../tax/tax.module';
import { PosAuditModule } from './audit/pos-audit.module';
import { PosControlModule } from './control/pos-control.module';
import { PosFiscalModule } from './fiscal/pos-fiscal.module';
import { PosLoyaltyLaborModule } from './labor/pos-loyalty-labor.module';
import { PosScaleModule } from './scale/pos-scale.module';
import { PosTerminalModule } from './terminal/pos-terminal.module';

// Umbrella POS module (docs/28 consolidation PR #5): the six satellite slices live under pos/ subfolders
// (audit, control, fiscal, labor, scale, terminal) and are imported + re-exported here. No cycle: no
// satellite imports PosModule (control→audit and terminal→payments only), and payments/restaurant import
// the satellites directly, never this umbrella.
@Module({
  // MessagingModule: POS-2 LINE e-receipt rides the existing messaging LINE client (no second client).
  imports: [RestaurantModule, PaymentsModule, TaxModule, MessagingModule, PosAuditModule, PosControlModule, PosFiscalModule, PosLoyaltyLaborModule, PosScaleModule, PosTerminalModule],
  controllers: [PosController, OrdersController, SplitController, ReceiptController],
  // TaxDocsPdfService + RealtimeScope have no own deps (DRIZZLE is global) → provide directly.
  providers: [PosService, PosProfileService, SplitBillService, ReceiptService, ReceiptDeliveryService, NoopReceiptProvider, CfdService, TaxDocsPdfService, RealtimeScope],
  exports: [PosService, PosProfileService, PosAuditModule, PosControlModule, PosFiscalModule, PosLoyaltyLaborModule, PosScaleModule, PosTerminalModule],
})
export class PosModule {}
