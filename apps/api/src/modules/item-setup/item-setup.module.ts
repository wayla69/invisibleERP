import { Module } from '@nestjs/common';
import { ItemSetupController } from './item-setup.controller';
import { ItemSetupService } from './item-setup.service';
import { MasterDataModule } from '../masterdata/masterdata.module';

// Item-posting setup (docs/33 PR3) — item categories, tax codes, per-item posting profile. DRIZZLE is global.
// Imports MasterDataModule to reuse its bulk import/export engine for the entity-scoped IO endpoints (the
// setup pages' own Excel/CSV template surface — gated to the same setup duties, not the coarse `masterdata`).
@Module({
  imports: [MasterDataModule],
  controllers: [ItemSetupController],
  providers: [ItemSetupService],
  exports: [ItemSetupService],
})
export class ItemSetupModule {}
