import { Module } from '@nestjs/common';
import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';
import { PortalPosService } from './portal.pos.service';
import { OfflineSyncService } from './offline-sync.service';
import { PortalMyErpService } from './portal.myerp.service';
import { TaxModule } from '../tax/tax.module';
import { PaymentsModule } from '../payments/payments.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MenuModule } from '../menu/menu.module';

@Module({
  imports: [TaxModule, PaymentsModule, LedgerModule, MenuModule],
  controllers: [PortalController],
  providers: [PortalService, PortalPosService, OfflineSyncService, PortalMyErpService],
  exports: [PortalService],
})
export class PortalModule {}
