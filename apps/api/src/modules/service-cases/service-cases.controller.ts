import { Controller, Get, Post, Body, Param, Query, Headers, Req, HttpCode } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Public, NoTx, Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ServiceCasesService, type CaseInboundEmail } from './service-cases.service';

const SLA_TIERS = ['Standard', 'Bronze', 'Silver', 'Gold', 'Platinum'] as const;
const CreateBody = z.object({
  subject: z.string().min(1).max(300),
  description: z.string().max(20_000).optional(),
  priority: z.enum(['P1', 'P2', 'P3', 'P4']).optional(),
  contact_email: z.string().max(320).optional(),
  customer_name: z.string().max(200).optional(),
  assignee: z.string().max(120).optional(),
  sla_tier: z.enum(SLA_TIERS).optional(),
});
const AssignBody = z.object({ assignee: z.string().min(1).max(120) });
const ResolveBody = z.object({ note: z.string().max(20_000).optional() });
const ReplyBody = z.object({ body: z.string().min(1).max(200_000), subject: z.string().max(500).optional(), to: z.string().max(320).optional() });
const EntitlementBody = z.object({ tier: z.enum(SLA_TIERS) });

// SVC-4 — Support Cases (authenticated surface). Reads + governed lifecycle for the customer-service team.
// Coarse duties (mirrors the /service nav perms): service agents (marketing) and executives manage cases.
@Controller('api/service/cases')
@Permissions('exec', 'marketing')
export class ServiceCasesController {
  constructor(private readonly svc: ServiceCasesService) {}

  @Get() list(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listCases(u, status); }
  @Get('sla/breaches') slaBreaches(@CurrentUser() u: JwtUser) { return this.svc.slaBreaches(u); } // SVC-5 detective worklist (before :id)
  @Get(':id') get(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.getCase(u, +id); }
  @Post() @HttpCode(201) create(@Body(new ZodValidationPipe(CreateBody)) b: z.infer<typeof CreateBody>, @CurrentUser() u: JwtUser) { return this.svc.createCase(u, b); }
  @Post(':id/entitlement') @HttpCode(200) entitlement(@Param('id') id: string, @Body(new ZodValidationPipe(EntitlementBody)) b: { tier: (typeof SLA_TIERS)[number] }, @CurrentUser() u: JwtUser) { return this.svc.setEntitlement(u, +id, b); } // SVC-5
  @Post(':id/assign') @HttpCode(200) assign(@Param('id') id: string, @Body(new ZodValidationPipe(AssignBody)) b: { assignee: string }, @CurrentUser() u: JwtUser) { return this.svc.assignCase(u, +id, b); }
  @Post(':id/pending') @HttpCode(200) pending(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.setPending(u, +id); }
  @Post(':id/resolve') @HttpCode(200) resolve(@Param('id') id: string, @Body(new ZodValidationPipe(ResolveBody)) b: { note?: string }, @CurrentUser() u: JwtUser) { return this.svc.resolveCase(u, +id, b); }
  @Post(':id/close') @HttpCode(200) close(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.closeCase(u, +id); }
  @Post(':id/reopen') @HttpCode(200) reopen(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.reopenCase(u, +id); }
  @Post(':id/reply') @HttpCode(200) reply(@Param('id') id: string, @Body(new ZodValidationPipe(ReplyBody)) b: { body: string; subject?: string; to?: string }, @CurrentUser() u: JwtUser) { return this.svc.addReply(u, +id, b); }
}

const InboundBody = z.object({
  from: z.string().min(3).max(320),
  subject: z.string().max(500).optional(),
  text: z.string().max(200_000).optional(),
  message_id: z.string().max(200).optional(),
  in_reply_to: z.string().max(998).optional(),
  references: z.string().max(4000).optional(),
});

// Email-to-Case webhook — public + no JWT: authenticity is the per-tenant email shared secret / HMAC (mirrors
// the CRM-6 crm/inbound + email-capture rails, so the same provider config works). The provider (SendGrid
// Inbound Parse / Mailgun route / …) posts the parsed support email to /api/service/email-to-case/inbound/
// <tenant code>. @NoTx (system caller) — every write is scoped by the resolved tenant_id.
@Controller('api/service/email-to-case')
export class CaseEmailInboundController {
  constructor(private readonly svc: ServiceCasesService) {}

  @Public()
  @NoTx()
  @Post('inbound/:tenantCode')
  inbound(
    @Param('tenantCode') tenantCode: string,
    @Headers('x-inbound-secret') secret: string | undefined,
    @Headers('x-inbound-signature') signature: string | undefined,
    @Headers('x-inbound-timestamp') timestamp: string | undefined,
    @Req() req: FastifyRequest & { rawBody?: Buffer },
    @Body(new ZodValidationPipe(InboundBody)) b: CaseInboundEmail,
  ) {
    return this.svc.handleInbound(tenantCode, secret, b, { rawBody: req.rawBody, signature, timestamp });
  }
}
