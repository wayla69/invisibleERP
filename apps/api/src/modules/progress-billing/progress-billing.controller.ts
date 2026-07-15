import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { ProgressBillingService, type CreateClaimDto } from './progress-billing.service';

const CreateBody = z.object({
  project_code: z.string().min(1),
  period: z.string().optional(),
  retention_pct: z.number().min(0).max(100).optional(),
  vat_pct: z.number().min(0).max(100).optional(),
  lines: z.array(z.object({
    boq_line_id: z.number().int().positive(),
    pct_complete_to_date: z.number().min(0).max(100),
  })).min(1),
});

const DocEmailBody = z.object({ to_email: z.string().email().optional() });

// Progress billing / งวดงาน (docs/35 P1, PROJ-16). A preparer (proj_billing) raises a progress claim valuing
// work by BoQ line; an independent certifier (proj_billing_certify, ≠ preparer) certifies it — which posts the
// billing JE (AR net + retention receivable + revenue; WIP→COGS) and withholds retention into the shared
// sub-ledger. Maker-checker is enforced in the service (SOD_SELF_APPROVAL).
@Controller('api/progress-billing')
export class ProgressBillingController {
  constructor(private readonly svc: ProgressBillingService) {}

  // Raise a draft progress claim (preparer duty).
  @Post()
  @Permissions('proj_billing', 'ar', 'exec')
  create(@Body(new ZodValidationPipe(CreateBody)) b: CreateClaimDto, @CurrentUser() u: JwtUser) {
    return this.svc.createClaim(b, u);
  }

  // Certify a draft claim (certifier duty; ≠ preparer). Static segment — never collides with :claimNo below.
  @Post(':claimNo/certify')
  @Permissions('proj_billing_certify', 'gl_close', 'exec')
  certify(@Param('claimNo') claimNo: string, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) {
    return this.svc.certifyClaim(claimNo, u, b?.self_approval_reason);
  }

  @Get('project/:code')
  @Permissions('proj_billing', 'proj_billing_certify', 'ar', 'exec', 'gl_close')
  listForProject(@Param('code') code: string) {
    return this.svc.listForProject(code);
  }

  // Printable ใบวางบิลงวดงาน / ใบกำกับภาษี (progress-claim tax invoice) — HTML→PDF via the shared renderer
  // (HTML fallback when Chromium absent). Two-segment path — never collides with `:claimNo` below.
  @Get(':claimNo/pdf')
  @Permissions('proj_billing', 'proj_billing_certify', 'ar', 'exec', 'gl_close')
  async pdf(@Param('claimNo') claimNo: string, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const data = await this.svc.getClaimForPrint(claimNo, u);
    const html = this.svc.claimHtml(data);
    const buf = await this.svc.renderClaimPdf(data);
    if (buf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${claimNo}.pdf"`).header('Content-Length', buf.length).send(buf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  }

  // Email the ใบวางบิลงวดงาน to the employer as a PDF attachment.
  @Post(':claimNo/send-email') @HttpCode(200)
  @Permissions('proj_billing', 'proj_billing_certify', 'ar', 'exec')
  emailClaim(@Param('claimNo') claimNo: string, @Body(new ZodValidationPipe(DocEmailBody)) b: z.infer<typeof DocEmailBody>, @CurrentUser() u: JwtUser) {
    return this.svc.emailClaim(claimNo, b.to_email, u);
  }

  @Get(':claimNo')
  @Permissions('proj_billing', 'proj_billing_certify', 'ar', 'exec', 'gl_close')
  get(@Param('claimNo') claimNo: string) {
    return this.svc.get(claimNo);
  }
}
