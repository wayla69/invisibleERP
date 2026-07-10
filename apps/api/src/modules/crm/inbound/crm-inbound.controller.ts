import { Controller, Post, Get, Body, Param, Query, Headers, Req, HttpCode } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Public, NoTx, Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { CrmInboundService, type CrmInboundEmail } from './crm-inbound.service';

const InboundBody = z.object({
  from: z.string().min(3).max(320),
  subject: z.string().max(500).optional(),
  text: z.string().max(200_000).optional(),
  message_id: z.string().max(200).optional(),
  in_reply_to: z.string().max(998).optional(),
  references: z.string().max(4000).optional(),
});
const LinkBody = z.object({ entity_type: z.enum(['opportunity', 'lead']), entity_no: z.string().min(1).max(60) });

// CRM-6 inbound-email webhook — public + no JWT: authenticity is the per-tenant email shared secret / HMAC
// (mirrors the email-capture + LINE webhooks). One CRM inbox per tenant → the provider (SendGrid Inbound
// Parse / Mailgun route / …) posts the parsed reply (normalized shape) to /api/crm/email/inbound/<tenant code>
// with the secret/signature header. @NoTx (system caller) — every write is scoped by the resolved tenant_id.
@Controller('api/crm/email')
export class CrmEmailInboundController {
  constructor(private readonly svc: CrmInboundService) {}

  @Public()
  @NoTx()
  @Post('inbound/:tenantCode')
  inbound(
    @Param('tenantCode') tenantCode: string,
    @Headers('x-inbound-secret') secret: string | undefined,
    @Headers('x-inbound-signature') signature: string | undefined,
    @Headers('x-inbound-timestamp') timestamp: string | undefined,
    @Req() req: FastifyRequest & { rawBody?: Buffer },
    @Body(new ZodValidationPipe(InboundBody)) b: CrmInboundEmail,
  ) {
    return this.svc.handleInbound(tenantCode, secret, b, { rawBody: req.rawBody, signature, timestamp });
  }
}

// Authenticated CRM surface for the inbound-capture review queue (unmatched replies) + manual linking.
@Controller('api/crm/inbound')
@Permissions('crm', 'exec', 'ar')
export class CrmInboundController {
  constructor(private readonly svc: CrmInboundService) {}

  @Get('review') review(@CurrentUser() u: JwtUser) { return this.svc.reviewQueue(u); }
  @Get() recent(@Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listRecent(u, limit != null ? Number(limit) : undefined); }
  @Post(':id/link') @HttpCode(200) link(@Param('id') id: string, @Body(new ZodValidationPipe(LinkBody)) b: { entity_type: 'opportunity' | 'lead'; entity_no: string }, @CurrentUser() u: JwtUser) { return this.svc.link(+id, b, u); }
  @Post(':id/dismiss') @HttpCode(200) dismiss(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.dismiss(+id, u); }
}
