import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SubcontractsService, type CreateSubcontractDto, type CreateValuationDto } from './subcontracts.service';

const CreateBody = z.object({
  project_code: z.string().min(1),
  vendor_name: z.string().optional(),
  title: z.string().optional(),
  retention_pct: z.number().min(0).max(100).optional(),
  wht_pct: z.number().min(0).max(100).optional(),
  vat_pct: z.number().min(0).max(100).optional(),
  allow_over: z.boolean().optional(),
  scope: z.array(z.object({
    boq_line_id: z.number().int().positive(),
    amount: z.number().positive(),
    description: z.string().optional(),
  })).min(1),
});
const ValuationBody = z.object({
  period: z.string().optional(),
  pct_complete: z.number().min(0).max(100),
  back_charge: z.number().min(0).optional(),
});
const DocEmailBody = z.object({ to_email: z.string().email().optional() });

// Subcontractor management (docs/35 P2, PROJ-16). A buyer/PM (proj_subcon) issues a subcontract against BoQ
// scope (reserving budget) and raises the subcontractor's progress valuations; an independent certifier
// (proj_subcon_certify, ≠ preparer) certifies each valuation — posting the AP/WIP/retention-payable JE and
// withholding retention into the shared sub-ledger. Maker-checker enforced in the service (SOD_SELF_APPROVAL).
@Controller('api/subcontracts')
export class SubcontractsController {
  constructor(private readonly svc: SubcontractsService) {}

  @Post()
  @Permissions('proj_subcon', 'procurement', 'exec')
  create(@Body(new ZodValidationPipe(CreateBody)) b: CreateSubcontractDto, @CurrentUser() u: JwtUser) {
    return this.svc.createSubcontract(b, u);
  }

  // Raise a subcontractor progress valuation (preparer duty). Static segment — never collides with :subNo.
  @Post(':subNo/valuations')
  @Permissions('proj_subcon', 'procurement', 'exec')
  createValuation(@Param('subNo') subNo: string, @Body(new ZodValidationPipe(ValuationBody)) b: CreateValuationDto, @CurrentUser() u: JwtUser) {
    return this.svc.createValuation(subNo, b, u);
  }

  // Certify a draft valuation (certifier duty; ≠ preparer). Static 'valuations/…' path — no :subNo collision.
  @Post('valuations/:valNo/certify')
  @Permissions('proj_subcon_certify', 'gl_close', 'exec')
  certify(@Param('valNo') valNo: string, @CurrentUser() u: JwtUser) {
    return this.svc.certifyValuation(valNo, u);
  }

  @Get('project/:code')
  @Permissions('proj_subcon', 'proj_subcon_certify', 'procurement', 'exec', 'gl_close')
  listForProject(@Param('code') code: string) {
    return this.svc.listForProject(code);
  }

  // Printable ใบรับรองผลงานผู้รับเหมาช่วง (subcontract valuation certificate) — HTML→PDF via the shared
  // renderer (HTML fallback when Chromium absent). Static 'valuations/…/pdf' path — no :subNo collision.
  @Get('valuations/:valNo/pdf')
  @Permissions('proj_subcon', 'proj_subcon_certify', 'procurement', 'exec', 'gl_close')
  async valuationPdf(@Param('valNo') valNo: string, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const data = await this.svc.getValuationForPrint(valNo, u);
    const html = this.svc.valuationHtml(data);
    const buf = await this.svc.renderValuationPdf(data);
    if (buf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${valNo}.pdf"`).header('Content-Length', buf.length).send(buf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  }

  // Email the ใบรับรองผลงานผู้รับเหมาช่วง to the subcontractor as a PDF attachment.
  @Post('valuations/:valNo/send-email') @HttpCode(200)
  @Permissions('proj_subcon', 'proj_subcon_certify', 'procurement', 'exec')
  emailValuation(@Param('valNo') valNo: string, @Body(new ZodValidationPipe(DocEmailBody)) b: z.infer<typeof DocEmailBody>, @CurrentUser() u: JwtUser) {
    return this.svc.emailValuation(valNo, b.to_email, u);
  }

  @Get('valuations/:valNo')
  @Permissions('proj_subcon', 'proj_subcon_certify', 'procurement', 'exec', 'gl_close')
  getValuation(@Param('valNo') valNo: string) {
    return this.svc.getValuation(valNo);
  }

  @Get(':subNo')
  @Permissions('proj_subcon', 'proj_subcon_certify', 'procurement', 'exec', 'gl_close')
  get(@Param('subNo') subNo: string) {
    return this.svc.getSubcontract(subNo);
  }
}
