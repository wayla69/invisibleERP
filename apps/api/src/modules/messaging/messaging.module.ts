import { Module } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { MessagingController } from './messaging.controller';
import { TenantMessagingService } from './tenant-messaging.service';

// CRM customer messaging (LINE / SMS / email) — provider-agnostic, mock by default. DRIZZLE is global.
// TenantMessagingService holds per-tenant provider credentials (encrypted) that override the platform env.
@Module({
  controllers: [MessagingController],
  providers: [MessagingService, TenantMessagingService],
  exports: [MessagingService, TenantMessagingService],
})
export class MessagingModule {}
