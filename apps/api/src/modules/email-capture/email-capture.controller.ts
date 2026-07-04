import { Controller, Post, Get, Body, Param, Headers } from '@nestjs/common';
import { z } from 'zod';
import { Public, NoTx, Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { EmailCaptureService, type InboundEmail } from './email-capture.service';

const RegisterBody = z.object({ email: z.string().min(3).max(200) });
const VerifyBody = z.object({ code: z.string().min(4).max(12) });
const InboundBody = z.object({
  from: z.string().min(3).max(320),
  subject: z.string().max(500).optional(),
  message_id: z.string().max(200).optional(),
  attachments: z.array(z.object({
    filename: z.string().max(200).optional(),
    content_type: z.string().max(120),
    data_base64: z.string().min(1).max(13_000_000),
  })).max(20).optional(),
});

// Email-to-Capture (docs/34 Phase 4). Staff self-service to verify their send-from address; booking a bill
// stays a creditors action (draft-only, SoD/EXP-06).
@Controller('api/capture-email')
export class EmailCaptureController {
  constructor(private readonly svc: EmailCaptureService) {}

  @Post('register') @Permissions('pr_raise', 'procurement', 'creditors')
  register(@Body(new ZodValidationPipe(RegisterBody)) b: { email: string }, @CurrentUser() u: JwtUser) { return this.svc.register(b.email, u); }

  @Post('verify') @Permissions('pr_raise', 'procurement', 'creditors')
  verify(@Body(new ZodValidationPipe(VerifyBody)) b: { code: string }, @CurrentUser() u: JwtUser) { return this.svc.verify(b.code, u); }

  @Get('status') @Permissions('pr_raise', 'procurement', 'creditors')
  status(@CurrentUser() u: JwtUser) { return this.svc.status(u); }
}

// Inbound-email webhook — public + no JWT: authenticity is the per-tenant shared secret (mirrors the LINE
// webhook). One capture inbox per tenant → the provider (SendGrid Inbound Parse / Mailgun route / …) posts
// the parsed mail (normalized shape) to /api/email/inbound/<shop code> with the secret header. @NoTx (system
// caller) — every write is scoped by the resolved tenant_id.
@Controller('api/email')
export class EmailInboundController {
  constructor(private readonly svc: EmailCaptureService) {}

  @Public()
  @NoTx()
  @Post('inbound/:tenantCode')
  inbound(
    @Param('tenantCode') tenantCode: string,
    @Headers('x-inbound-secret') secret: string | undefined,
    @Body(new ZodValidationPipe(InboundBody)) b: InboundEmail,
  ) {
    return this.svc.handleInbound(tenantCode, secret, b);
  }
}
