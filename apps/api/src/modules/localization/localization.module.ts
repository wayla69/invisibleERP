import { Module } from '@nestjs/common';
import { LocalizationService } from './localization.service';
import { LocalizationController } from './localization.controller';

// C2 (Phase 21) — country localization packs. DRIZZLE is global.
@Module({
  controllers: [LocalizationController],
  providers: [LocalizationService],
})
export class LocalizationModule {}
