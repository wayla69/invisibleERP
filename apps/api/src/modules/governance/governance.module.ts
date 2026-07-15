import { Module } from '@nestjs/common';
import { GovernanceService } from './governance.service';
import { GovernanceController } from './governance.controller';
import { GovernanceBiReports } from './governance-bi-reports';
import { PlatformNotificationsModule } from '../platform-notifications/platform-notifications.module';

// Entity-level governance evidence capture (ELC-01 ethics acknowledgement register, ELC-04 whistleblower
// hotline case log). DRIZZLE is global. PlatformNotificationsModule feeds the SME-01 god-inbox leg
// (docs/49 v1.2) — @Optional in the provider, so harnesses without the module still boot.
@Module({ imports: [PlatformNotificationsModule], controllers: [GovernanceController], providers: [GovernanceBiReports, GovernanceService], exports: [GovernanceService] })
export class GovernanceModule {}
