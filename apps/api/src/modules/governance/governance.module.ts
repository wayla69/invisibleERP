import { Module } from '@nestjs/common';
import { GovernanceService } from './governance.service';
import { GovernanceController } from './governance.controller';
import { GovernanceBiReports } from './governance-bi-reports';
import { SmeReviewService } from './sme-review.service';
import { SmeReviewController } from './sme-review.controller';
import { PlatformNotificationsModule } from '../platform-notifications/platform-notifications.module';

// Entity-level governance evidence capture (ELC-01 ethics acknowledgement register, ELC-04 whistleblower
// hotline case log) + the SME single-user compensating controls: SME-01 self-approval review (report) and
// SME-02 review attestation (SmeReview*). DRIZZLE is global. PlatformNotificationsModule feeds the SME-01
// god-inbox leg (docs/49 v1.2) — @Optional in the provider, so harnesses without the module still boot.
@Module({
  imports: [PlatformNotificationsModule],
  controllers: [GovernanceController, SmeReviewController],
  providers: [GovernanceBiReports, GovernanceService, SmeReviewService],
  exports: [GovernanceService, SmeReviewService],
})
export class GovernanceModule {}
