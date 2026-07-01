import { Module } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { MessagingController } from './messaging.controller';
import { TenantMessagingService } from './tenant-messaging.service';
import { LineWebhookController, LineWebhookService } from './line-webhook.controller';

// CRM customer messaging (LINE / SMS / email) — provider-agnostic, mock by default. DRIZZLE is global.
// TenantMessagingService holds per-tenant provider credentials (encrypted) that override the platform env.
// LineWebhookController receives LINE follow/unfollow events (signature-verified per tenant).
@Module({
  controllers: [MessagingController, LineWebhookController],
  providers: [MessagingService, TenantMessagingService, LineWebhookService],
  exports: [MessagingService, TenantMessagingService],
})
export class MessagingModule {}
