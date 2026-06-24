import { Module } from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import { OnboardingController } from './onboarding.controller';

// E1 (Phase 26) — guided onboarding + industry packs. DRIZZLE is global; pack apply writes custom_objects
// directly (idempotent), so no cross-module provider dependency.
@Module({
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
