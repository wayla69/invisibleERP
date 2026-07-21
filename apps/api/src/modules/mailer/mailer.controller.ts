import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { PlatformAdmin } from '../../common/decorators';
import { MailerService } from './mailer.service';

// God-only outbox surface: the audit/ops view of every customer-facing platform email, plus a manual
// deliver-pending sweep (also what the control harness uses to make delivery deterministic — the
// background worker delivers the same rows in production).
@Controller('api')
export class MailerController {
  constructor(private readonly mailer: MailerService) {}

  @Get('admin/emails') @PlatformAdmin()
  list(@Query('limit') limit?: string) {
    return this.mailer.list(limit ? Number(limit) : undefined);
  }

  @Post('admin/emails/deliver-pending') @PlatformAdmin() @HttpCode(200)
  deliverPending() {
    return this.mailer.deliverPending();
  }
}
