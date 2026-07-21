import { Module } from '@nestjs/common';
import { MailerController } from './mailer.controller';
import { MailerService } from './mailer.service';

// Outbound transactional email (A1). Lives in the platform domain aggregate; JobsModule is @Global so the
// queue/worker inject without an explicit import. Consumers (e.g. billing's provisioning flows) import
// this module and inject MailerService — the outbox table + templates stay private to this module.
@Module({
  controllers: [MailerController],
  providers: [MailerService],
  exports: [MailerService],
})
export class MailerModule {}
