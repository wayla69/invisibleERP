import { Module } from '@nestjs/common';
import { NpsController } from './nps.controller';
import { NpsService } from './nps.service';
import { MessagingModule } from '../messaging/messaging.module';
import { PlatformModule } from '../platform/platform.module';
import { AutomationModule } from '../automation/automation.module';

// W3 (docs/27) — NPS closed loop. Survey sends ride MessagingService (consent path; 'nps' is
// transactional-exempt from the governance caps); the detractor event fans out through webhooks + the
// automation engine. Exported so the BI scheduler's nps_post_purchase job can drive sendDue.
// No cycle: messaging/platform/automation never import NpsModule.
@Module({
  imports: [MessagingModule, PlatformModule, AutomationModule],
  controllers: [NpsController],
  providers: [NpsService],
  exports: [NpsService],
})
export class NpsModule {}
