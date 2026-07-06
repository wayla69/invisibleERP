import { Controller, Get, Post, Param, Query, Body, HttpCode, Res } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CollectionsService, DUNNING_STAGES } from './collections.service';

// to_email optional — defaults to the customer's email on file (master data) when omitted.
const DocEmailBody = z.object({ to_email: z.string().email().optional() });

const DunningBody = z.object({
  stage: z.enum(DUNNING_STAGES),
  channel: z.enum(['email', 'phone', 'letter', 'sms']).optional(),
  promise_to_pay_date: z.string().optional(),
  notes: z.string().optional(),
});
const CreditCheckBody = z.object({ tenant_id: z.number().int().positive(), amount: z.number().nonnegative() });
const HoldBody = z.object({ tenant_id: z.number().int().positive(), reason: z.string().optional() });
const LimitBody = z.object({ tenant_id: z.number().int().positive(), new_limit: z.number().nonnegative(), reason: z.string().optional() });
const ReasonBody = z.object({ reason: z.string().max(500).optional() });

@Controller('api/finance/ar')
export class CollectionsController {
  constructor(private readonly svc: CollectionsService) {}

  // Collections worklist — open AR with aging, current dunning stage and the next recommended rung.
  @Get('collections') @Permissions('ar', 'exec')
  worklist(@Query('overdue_only') overdueOnly?: string) { return this.svc.worklist({ onlyOverdue: overdueOnly === '1' || overdueOnly === 'true' }); }

  // Cron-callable: auto-advance dunning on every overdue invoice past its recommended stage.
  @Post('collections/sweep') @Permissions('ar', 'exec')
  sweep(@CurrentUser() u: JwtUser) { return this.svc.runDunningSweep(u); }

  // Dunning history for one invoice.
  @Get('collections/:invoiceNo/history') @Permissions('ar', 'exec')
  history(@Param('invoiceNo') invoiceNo: string) { return this.svc.history(invoiceNo); }

  // Record a dunning action (advances the collections stage on an open invoice).
  @Post('collections/:invoiceNo/dunning') @Permissions('ar')
  dun(@Param('invoiceNo') invoiceNo: string, @Body(new ZodValidationPipe(DunningBody)) b: z.infer<typeof DunningBody>, @CurrentUser() u: JwtUser) {
    return this.svc.recordDunning(invoiceNo, b, u);
  }

  // Printable หนังสือทวงถามหนี้ (Dunning / collection letter) over the latest dunning action — HTML→PDF.
  @Get('collections/:invoiceNo/dunning-letter/pdf') @Permissions('ar', 'exec')
  async dunningLetterPdf(@Param('invoiceNo') invoiceNo: string, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const d = await this.svc.getDunningLetterForPrint(invoiceNo, u);
    const buf = await this.svc.renderDunningPdf(d);
    if (buf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${d.dunning_no}.pdf"`).header('Content-Length', buf.length).send(buf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(this.svc.dunningLetterHtml(d));
  }
  @Post('collections/:invoiceNo/dunning-letter/send-email') @HttpCode(200) @Permissions('ar', 'exec')
  emailDunningLetter(@Param('invoiceNo') invoiceNo: string, @Body(new ZodValidationPipe(DocEmailBody)) b: z.infer<typeof DocEmailBody>, @CurrentUser() u: JwtUser) {
    return this.svc.emailDunningLetter(invoiceNo, b.to_email, u);
  }

  // All-customer credit positions — aggregate view for the credit-hold management dashboard.
  @Get('credit-positions') @Permissions('ar', 'exec', 'crm')
  creditPositions() { return this.svc.creditPositions(); }

  // Credit position of a customer (exposure vs limit, overdue, hold flag).
  @Get('credit-status') @Permissions('ar', 'exec', 'crm')
  creditStatus(@Query('tenant_id') tenantId: string) { return this.svc.creditStatus(Number(tenantId)); }

  // Credit decision for order entry: may this customer take on `amount` more credit now?
  @Post('credit-check') @Permissions('ar', 'exec', 'order_mgt', 'pos')
  creditCheck(@Body(new ZodValidationPipe(CreditCheckBody)) b: z.infer<typeof CreditCheckBody>) {
    return this.svc.creditCheck(b.tenant_id, b.amount);
  }

  // ── Credit-manager workflow ──
  // Place a manual credit hold (credit manager / AR).
  @Post('credit-hold') @Permissions('crm', 'exec', 'ar')
  placeHold(@Body(new ZodValidationPipe(HoldBody)) b: z.infer<typeof HoldBody>, @CurrentUser() u: JwtUser) { return this.svc.placeHold(b.tenant_id, b.reason, u); }

  // Release a hold — requires `approvals` (SoD: releaser ≠ the person who placed it).
  @Post('credit-release') @Permissions('approvals', 'exec')
  releaseHold(@Body(new ZodValidationPipe(HoldBody)) b: z.infer<typeof HoldBody>, @CurrentUser() u: JwtUser) { return this.svc.releaseHold(b.tenant_id, b.reason, u); }

  // Request a credit-limit change (audit G7 / REV-08). Staged PendingApproval — a DIFFERENT user must
  // approve it (the requesting duty is crm/exec; approval requires `approvals`, mirroring credit-release).
  @Post('credit-limit') @Permissions('crm', 'exec')
  changeLimit(@Body(new ZodValidationPipe(LimitBody)) b: z.infer<typeof LimitBody>, @CurrentUser() u: JwtUser) { return this.svc.changeLimit(b.tenant_id, b.new_limit, b.reason, u); }

  // Approve / reject a staged credit-limit change — approver ≠ requester (SoD enforced in the service).
  @Get('credit-limit/pending') @Permissions('approvals', 'exec', 'ar')
  pendingLimitChanges() { return this.svc.listPendingLimitChanges(); }
  @Post('credit-limit/:reqNo/approve') @Permissions('approvals', 'exec')
  approveLimitChange(@Param('reqNo') reqNo: string, @CurrentUser() u: JwtUser) { return this.svc.approveLimitChange(reqNo, u); }
  @Post('credit-limit/:reqNo/reject') @Permissions('approvals', 'exec')
  rejectLimitChange(@Param('reqNo') reqNo: string, @Body(new ZodValidationPipe(ReasonBody)) b: z.infer<typeof ReasonBody>, @CurrentUser() u: JwtUser) { return this.svc.rejectLimitChange(reqNo, u, b.reason); }

  // Credit-change audit (holds / releases / limit changes) for a customer.
  @Get('credit-events') @Permissions('ar', 'exec', 'crm')
  creditEvents(@Query('tenant_id') tenantId: string) { return this.svc.creditEventsFor(Number(tenantId)); }
}
