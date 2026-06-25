import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryQrController } from './inventory-qr.controller';
import { InventoryLedgerController } from './inventory-ledger.controller';
import { InventoryService } from './inventory.service';
import { InventoryLedgerService } from './inventory-ledger.service';
import { InventoryRepository } from './inventory.repository';
import { QrModule } from '../qr/qr.module';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [QrModule, LedgerModule],
  controllers: [InventoryController, InventoryQrController, InventoryLedgerController],
  providers: [InventoryService, InventoryLedgerService, InventoryRepository],
  exports: [InventoryService, InventoryLedgerService],
})
export class InventoryModule {}
