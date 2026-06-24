import { Module } from '@nestjs/common';
import { AiConfigService } from './ai-config.service';
import { AiConfigController } from './ai-config.controller';

// AI configuration assistant (Phase 18 — B4). Self-contained: Claude when a key is set, deterministic
// starter templates otherwise. Suggestion-only — never writes config.
@Module({
  controllers: [AiConfigController],
  providers: [AiConfigService],
})
export class AiConfigModule {}
