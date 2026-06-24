import { Module } from '@nestjs/common';
import { DeveloperService } from './developer.service';
import { DeveloperController } from './developer.controller';

// D1 (Phase 23) — API maturity / developer portal. DRIZZLE is global; reads the existing api_keys.
@Module({
  controllers: [DeveloperController],
  providers: [DeveloperService],
})
export class DeveloperModule {}
