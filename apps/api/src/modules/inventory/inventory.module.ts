import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryQrController } from './inventory-qr.controller';
import { InventoryService } from './inventory.service';
import { InventoryRepository } from './inventory.repository';
import { QrModule } from '../qr/qr.module';

@Module({
  imports: [QrModule],
  controllers: [InventoryController, InventoryQrController],
  providers: [InventoryService, InventoryRepository],
  exports: [InventoryService],
})
export class InventoryModule {}
