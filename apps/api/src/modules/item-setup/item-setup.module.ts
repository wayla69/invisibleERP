import { Module } from '@nestjs/common';
import { ItemSetupController } from './item-setup.controller';
import { ItemSetupService } from './item-setup.service';

// Item-posting setup (docs/33 PR3) — item categories, tax codes, per-item posting profile. DRIZZLE is global.
@Module({
  controllers: [ItemSetupController],
  providers: [ItemSetupService],
  exports: [ItemSetupService],
})
export class ItemSetupModule {}
