import { Module } from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import { OnboardingController } from './onboarding.controller';
import { LedgerModule } from '../ledger/ledger.module';

// E1 (Phase 26) — guided onboarding + industry packs. DRIZZLE is global; pack apply writes custom_objects
// directly (idempotent). LedgerModule is imported so applying an industry pack also provisions that
// industry's Chart-of-Accounts overlay (GL-10).
@Module({
  imports: [LedgerModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
