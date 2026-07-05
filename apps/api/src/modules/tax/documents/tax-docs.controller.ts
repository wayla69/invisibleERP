import { Controller, Get, Post, Patch, Param, Query, Body, Res, Optional } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { TaxInvoiceService } from './tax-invoice.service';
import { TaxDocsPdfService } from './tax-docs-pdf.service';
import { buildEtaxInvoiceXml } from './etax-xml';
import { getSigningMaterial, signEtaxXml } from './etax-sign';
import { EtaxEmailService } from './etax-email.service';
import { IssueFullBody, type IssueFullDto } from './dto';
import { normalizeA4Template, type A4TemplateConfig } from '../../../common/a4-template';
import { DocumentTemplatesService } from '../../document-templates/document-templates.service';

const VoidBody = z.object({ reason: z.string().optional() });
const SendEmailBody = z.object({ to_email: z.string().email() });
// ใบลดหนี้ (ม.86/10) / ใบเพิ่มหนี้ (ม.86/9) against a prior full tax invoice.
const AdjustmentNoteBody = z.object({
  original_doc_no: z.string().min(1),
  reason: z.string().min(1),
  lines: z.array(z.object({ description: z.string().min(1), qty: z.number().optional(), unit_price: z.number().optional(), amount: z.number() })).min(1),
});
const RejectNoteBody = z.object({ reason: z.string().optional() });

@Controller('api/tax-invoices')
export class TaxDocsController {
  constructor(
    private readonly svc: TaxInvoiceService,
    private readonly pdf: TaxDocsPdfService,
    private readonly etaxEmail: EtaxEmailService,
    @Optional() private readonly docTemplates?: DocumentTemplatesService, // no-code full-tax-invoice template (presentation)
  ) {}

  // The tenant's active, presentation-only template for a FISCAL A4 doc. Normalized with { fiscal: true } so
  // the mandatory ม.86/4 seller name/address/tax-id lines are always kept; a lookup failure never blocks the
  // document (fall open to the brand default).
  private async fiscalTemplate(docType: string): Promise<A4TemplateConfig> {
    try {
      if (this.docTemplates) return normalizeA4Template(await this.docTemplates.resolveActive(docType), { fiscal: true });
    } catch { /* keep default */ }
    return normalizeA4Template({}, { fiscal: true });
  }

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

  // ── ใบลดหนี้ (ม.86/10) / ใบเพิ่มหนี้ (ม.86/9) — issued by the seller (ar/pos), each posts a Draft GL entry ──
  @Post('credit-note') @Permissions('ar', 'pos')
  creditNote(@Body(new ZodValidationPipe(AdjustmentNoteBody)) b: z.infer<typeof AdjustmentNoteBody>, @CurrentUser() u: JwtUser) {
    return this.svc.issueAdjustment('credit_note', b, u);
  }
  @Post('debit-note') @Permissions('ar', 'pos')
  debitNote(@Body(new ZodValidationPipe(AdjustmentNoteBody)) b: z.infer<typeof AdjustmentNoteBody>, @CurrentUser() u: JwtUser) {
    return this.svc.issueAdjustment('debit_note', b, u);
  }
  // Maker-checker (TAX-07): a DIFFERENT user (approvals/gl_close/exec) approves → posts the GL + flips to Issued.
  @Post(':docNo/approve-note') @Permissions('approvals', 'gl_close', 'exec')
  approveNote(@Param('docNo') docNo: string, @CurrentUser() u: JwtUser) {
    return this.svc.approveAdjustment(docNo, u);
  }
  @Post(':docNo/reject-note') @Permissions('approvals', 'gl_close', 'exec')
  rejectNote(@Param('docNo') docNo: string, @Body(new ZodValidationPipe(RejectNoteBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) {
    return this.svc.rejectAdjustment(docNo, u, b.reason);
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
    const html = inv.type === 'abbreviated' ? this.pdf.abbreviatedTaxInvoiceHtml(inv, await this.fiscalTemplate('tax_invoice_abbreviated'))
      : (inv.type === 'credit_note' || inv.type === 'debit_note') ? this.pdf.creditDebitNoteHtml(inv)
      : this.pdf.fullTaxInvoiceHtml(inv, copy === '1' || copy === 'copy', await this.fiscalTemplate('tax_invoice_full'));
    const buf = await this.pdf.renderToPdf(html, inv.type === 'abbreviated');
    if (buf) {
      reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${docNo}.pdf"`).header('Content-Length', buf.length).send(buf);
    } else {
      reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
    }
  }
}
