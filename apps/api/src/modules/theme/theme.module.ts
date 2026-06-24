import { Module } from '@nestjs/common';
import { ThemeService } from './theme.service';
import { ThemeController } from './theme.controller';

// E4 (Phase 29) — white-label theming. DRIZZLE is global; no other deps.
@Module({
  controllers: [ThemeController],
  providers: [ThemeService],
})
export class ThemeModule {}
