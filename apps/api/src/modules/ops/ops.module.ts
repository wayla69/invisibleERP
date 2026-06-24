import { Module } from '@nestjs/common';
import { CacheService } from './cache.service';
import { OpsController } from './ops.controller';

// E5 (Phase 30) — scale interfaces. CacheService is exported so other modules can adopt it; in-memory default.
@Module({
  controllers: [OpsController],
  providers: [CacheService],
  exports: [CacheService],
})
export class OpsModule {}
