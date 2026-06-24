import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { PlatformModule } from '../platform/platform.module';
import { AlertsService } from './alerts.service';
import { AlertsController } from './alerts.controller';

// Phase 3 — alert/notification rules engine. No-code rules over a metric catalog; a sweep fires
// notifications (and optional LINE/SMS/email via MessagingModule) when breached. DRIZZLE is global.
@Module({
  imports: [MessagingModule, PlatformModule],
  controllers: [AlertsController],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
