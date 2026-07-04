import { Module } from '@nestjs/common';
import { EmailCaptureController, EmailInboundController } from './email-capture.controller';
import { EmailCaptureService } from './email-capture.service';
import { MessagingModule } from '../messaging/messaging.module';
import { MAILER, NodemailerMailer } from '../tax/documents/mailer';

// Email-to-Capture (docs/34 Phase 4). Verifies a staff send-from address (mailed code) and turns a bill
// forwarded to the tenant capture inbox into an AP-intake DRAFT via the existing EXP-10 engine (resolved
// lazily from the root container to avoid a circular module graph). MessagingModule provides the per-tenant
// credential lookup (TenantMessagingService) for the inbound shared secret; a private Nodemailer transport
// mails the verification code.
@Module({
  imports: [MessagingModule],
  controllers: [EmailCaptureController, EmailInboundController],
  providers: [EmailCaptureService, { provide: MAILER, useClass: NodemailerMailer }],
})
export class EmailCaptureModule {}
