import { Controller, Get, Post, Patch, Param, Query, Body, Res } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { TaxInvoiceService } from './tax-invoice.service';
import { TaxDocsPdfService } from './tax-docs-pdf.service';
import { buildEtaxInvoiceXml } from './etax-xml';
import { IssueFullBody, type IssueFullDto } from './dto';

const VoidBody = z.object({ reason: z.string().optional() });

@Controller('api/tax-invoices')
export class TaxDocsController {
  constructor(
    private readonly svc: TaxInvoiceService,
    private readonly pdf: TaxDocsPdfService,
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

  // ETDA e-Tax Invoice XML (UBL 2.1) — unsigned instance document; XAdES signing added with the RD cert.
  @Get(':docNo/etax-xml') @Permissions('ar', 'pos', 'cust_pos')
  async etaxXml(@Param('docNo') docNo: string, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const inv = await this.svc.getByDocNo(u, docNo);
    const xml = buildEtaxInvoiceXml(inv as never);
    reply
      .header('Content-Type', 'application/xml; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${docNo}.xml"`)
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
