import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryQrController } from './inventory-qr.controller';
import { InventoryLedgerController } from './inventory-ledger.controller';
import { WasteController } from './waste.controller';
import { InventoryService } from './inventory.service';
import { InventoryLedgerService } from './inventory-ledger.service';
import { WasteService } from './waste.service';
import { InventoryRepository } from './inventory.repository';
import { QrModule } from '../qr/qr.module';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [QrModule, LedgerModule],
  controllers: [InventoryController, InventoryQrController, InventoryLedgerController, WasteController],
  providers: [InventoryService, InventoryLedgerService, WasteService, InventoryRepository],
  exports: [InventoryService, InventoryLedgerService],
})
export class InventoryModule {}
