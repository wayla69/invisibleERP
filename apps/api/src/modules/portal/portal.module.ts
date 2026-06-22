import { Module } from '@nestjs/common';
import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';
import { PortalPosService } from './portal.pos.service';
import { OfflineSyncService } from './offline-sync.service';
import { PortalMyErpService } from './portal.myerp.service';
import { PortalUsersService } from './portal.users.service';
import { PasswordService } from '../auth/password.service';
import { TaxModule } from '../tax/tax.module';
import { PaymentsModule } from '../payments/payments.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MenuModule } from '../menu/menu.module';
import { CostingModule } from '../costing/costing.module';
import { PricingModule } from '../pricing/pricing.module';
import { PosFiscalModule } from '../pos-fiscal/pos-fiscal.module';
import { PosScaleModule } from '../pos-scale/pos-scale.module';

@Module({
  imports: [TaxModule, PaymentsModule, LedgerModule, MenuModule, CostingModule, PricingModule, PosFiscalModule, PosScaleModule],
  controllers: [PortalController],
  providers: [PortalService, PortalPosService, OfflineSyncService, PortalMyErpService, PortalUsersService, PasswordService],
  exports: [PortalService],
})
export class PortalModule {}
