import { Module } from '@nestjs/common';
import { MigrationService } from './migration.service';
import { MigrationController } from './migration.controller';

// E2 (Phase 27) — data-migration toolkit. DRIZZLE is global; validation-only (defers the write to Phase-7).
@Module({
  controllers: [MigrationController],
  providers: [MigrationService],
})
export class MigrationModule {}
