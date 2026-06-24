import { Module } from '@nestjs/common';
import { SavedViewsService } from './saved-views.service';
import { SavedViewsController } from './saved-views.controller';

// Phase 4 — saved views (per-user, per-module list presets). DRIZZLE is global.
@Module({
  controllers: [SavedViewsController],
  providers: [SavedViewsService],
  exports: [SavedViewsService],
})
export class SavedViewsModule {}
