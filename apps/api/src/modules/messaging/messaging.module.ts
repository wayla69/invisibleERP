import { Module } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { MessagingController } from './messaging.controller';
import { TenantMessagingService } from './tenant-messaging.service';
import { LineWebhookController, LineWebhookService } from './line-webhook.controller';
import { LineCopilotService } from './line-copilot.service';
import { LineLinkService } from './line-link.service';
import { LineNotifyService } from './line-notify.service';
import { DeliveryCallbackController, DeliveryCallbackService } from './delivery-callback.controller';
import { SavedSegmentsService } from '../loyalty/saved-segments.service';

// CRM customer messaging (LINE / SMS / email) — provider-agnostic, mock by default. DRIZZLE is global.
// TenantMessagingService holds per-tenant provider credentials (encrypted) that override the platform env.
// LineWebhookController receives LINE follow/unfollow events (signature-verified per tenant) + the staff
// chat-PR commands (0227/0228). LineNotifyService pushes workflow notifications to linked STAFF users.
// DeliveryCallbackController receives provider delivery-status callbacks (token-guarded, tenant-scoped).
@Module({
  controllers: [MessagingController, LineWebhookController, DeliveryCallbackController],
  providers: [MessagingService, TenantMessagingService, LineWebhookService, LineCopilotService, LineLinkService, LineNotifyService, DeliveryCallbackService, SavedSegmentsService],
  exports: [MessagingService, TenantMessagingService, LineNotifyService],
})
export class MessagingModule {}
