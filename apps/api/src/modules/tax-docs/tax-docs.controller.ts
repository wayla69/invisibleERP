import { Controller, Get, Post, Patch, Param, Query, Body, Res } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { TaxInvoiceService } from './tax-invoice.service';
import { TaxDocsPdfService } from './tax-docs-pdf.service';
import { buildEtaxInvoiceXml } from './etax-xml';
import { getSigningMaterial, signEtaxXml } from './etax-sign';
import { EtaxEmailService } from './etax-email.service';
import { IssueFullBody, type IssueFullDto } from './dto';

const VoidBody = z.object({ reason: z.string().optional() });
const SendEmailBody = z.object({ to_email: z.string().email() });

@Controller('api/tax-invoices')
export class TaxDocsController {
  constructor(
    private readonly svc: TaxInvoiceService,
    private readonly pdf: TaxDocsPdfService,
    private readonly etaxEmail: EtaxEmailService,
  ) {}

  // ใบกำกับภาษีเต็มรูป (ม.86/4)
  @Post('full') @Permissions('ar', 'pos')
  issueFull(@Body(new ZodValidationPipe(IssueFullBody)) b: IssueFullDto, @CurrentUser() u: JwtUser) {
    return this.svc.issueFull(b, u);
  }

  // ใบกำกับภาษีอย่างย่อ (ม.86/6) จากการขายหน้าร้าน
  @Post('abbreviated/from-sale/:saleNo') @Permissions('cust_pos', 'pos')
  issueAbbreviated(@Param('saleNo') saleNo: string, @CurrentUser() u: JwtUser) {
    return this.svc.issueAbbreviatedFromSale(saleNo, u);
  }

  @Get() @Permissions('ar', 'pos', 'cust_pos')
  list(@Query('type') type: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.list(u, type);
  }

  @Get(':docNo') @Permissions('ar', 'pos', 'cust_pos')
  get(@Param('docNo') docNo: string, @CurrentUser() u: JwtUser) {
    return this.svc.getByDocNo(u, docNo);
  }

  @Patch(':docNo/void') @Permissions('ar', 'pos')
  void(@Param('docNo') docNo: string, @Body(new ZodValidationPipe(VoidBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) {
    return this.svc.void(u, docNo, b.reason ?? '');
  }

  // ETDA "e-Tax Invoice by Email" (income ≤ 30M/yr, no CA cert): email the invoice to the buyer with a
  // CC to ETDA's time-stamp mailbox, which stamps it and returns it.
  @Post(':docNo/send-etax-email') @Permissions('ar', 'pos')
  sendEtaxEmail(@Param('docNo') docNo: string, @Body(new ZodValidationPipe(SendEmailBody)) b: { to_email: string }, @CurrentUser() u: JwtUser) {
    return this.etaxEmail.sendByEmail(u, docNo, b.to_email);
  }

  // ETDA e-Tax Invoice XML (UBL 2.1). Unsigned instance document by default; ?signed=1 appends the
  // XAdES enveloped signature when a certificate is configured (ETAX_SIGNING_*), else returns unsigned.
  @Get(':docNo/etax-xml') @Permissions('ar', 'pos', 'cust_pos')
  async etaxXml(@Param('docNo') docNo: string, @Query('signed') signed: string | undefined, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const inv = await this.svc.getByDocNo(u, docNo);
    let xml = buildEtaxInvoiceXml(inv as never);
    let suffix = '';
    if (signed === '1' || signed === 'true') {
      const material = getSigningMaterial();
      if (material) { xml = signEtaxXml(xml, material); suffix = '-signed'; }
    }
    reply
      .header('Content-Type', 'application/xml; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${docNo}${suffix}.xml"`)
      .send(xml);
  }

  @Get(':docNo/pdf') @Permissions('ar', 'pos', 'cust_pos')
  async pdfDoc(@Param('docNo') docNo: string, @Query('copy') copy: string | undefined, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const inv = await this.svc.getByDocNo(u, docNo);
    const html = inv.type === 'abbreviated' ? this.pdf.abbreviatedTaxInvoiceHtml(inv) : this.pdf.fullTaxInvoiceHtml(inv, copy === '1' || copy === 'copy');
    const buf = await this.pdf.renderToPdf(html, inv.type === 'abbreviated');
    if (buf) {
      reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${docNo}.pdf"`).header('Content-Length', buf.length).send(buf);
    } else {
      reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
    }
  }
}
