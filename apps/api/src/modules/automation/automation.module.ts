import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { JourneysModule } from '../journeys/journeys.module';
import { AutomationService } from './automation.service';
import { AutomationController } from './automation.controller';

// Automation rules engine (Phase 13 — A4). Exports AutomationService so the webhook dispatcher can trigger
// rules when an event fires. Reuses MessagingModule for the LINE/SMS/email action. DRIZZLE is global.
@Module({
  imports: [MessagingModule, JourneysModule],
  controllers: [AutomationController],
  providers: [AutomationService],
  exports: [AutomationService],
})
export class AutomationModule {}
