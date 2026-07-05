import { Global, Module } from '@nestjs/common';
import { MAILER, NodemailerMailer } from '../tax/documents/mailer';
import { DocEmailService } from './doc-email.service';

// @Global so any document-producing module can inject DocEmailService to email a rendered document without
// wiring a mail transport itself. Provides its own MAILER binding (SMTP via NodemailerMailer); the tax
// module keeps its own module-local MAILER for the e-Tax-by-email path, so the two never collide.
@Global()
@Module({
  providers: [{ provide: MAILER, useClass: NodemailerMailer }, DocEmailService],
  exports: [DocEmailService, MAILER],
})
export class MailModule {}
