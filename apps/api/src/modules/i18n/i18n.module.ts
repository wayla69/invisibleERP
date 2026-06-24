import { Module } from '@nestjs/common';
import { I18nService } from './i18n.service';
import { I18nController } from './i18n.controller';

// C1 (Phase 20) — i18n / locale framework. DRIZZLE is global; no other deps.
@Module({
  controllers: [I18nController],
  providers: [I18nService],
})
export class I18nModule {}
