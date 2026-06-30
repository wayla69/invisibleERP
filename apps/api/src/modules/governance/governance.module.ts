import { Module } from '@nestjs/common';
import { GovernanceService } from './governance.service';
import { GovernanceController } from './governance.controller';

// Entity-level governance evidence capture (ELC-01 ethics acknowledgement register, ELC-04 whistleblower
// hotline case log). DRIZZLE is global; no other module dependencies.
@Module({ controllers: [GovernanceController], providers: [GovernanceService], exports: [GovernanceService] })
export class GovernanceModule {}
