import { Module } from '@nestjs/common';
import { MessagingModule } from '../../messaging/messaging.module';
import { CrmInboundService } from './crm-inbound.service';
import { CrmEmailInboundController, CrmInboundController } from './crm-inbound.controller';

// CRM-6 (docs/41 CRM-4 note): inbound email capture → CRM (2-way comms). MessagingModule provides the
// per-tenant email credential lookup (TenantMessagingService) for the inbound shared secret / HMAC. DRIZZLE +
// the guards are global. Mirrors the email-capture AP rail; append-only (logs timeline activities + a review
// queue — no GL, no stage change).
@Module({
  imports: [MessagingModule],
  controllers: [CrmEmailInboundController, CrmInboundController],
  providers: [CrmInboundService],
  exports: [CrmInboundService],
})
export class CrmInboundModule {}
