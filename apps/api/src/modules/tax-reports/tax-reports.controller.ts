import { Controller, Get, Query, Res, BadRequestException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Permissions } from '../../common/decorators';
import { TaxReportsService } from './tax-reports.service';
import { TaxReportsPdfService } from './tax-reports-pdf.service';

function parseMY(month: string, year: string) {
  const m = parseInt(month, 10), y = parseInt(year, 10);
  if (!m || m < 1 || m > 12 || !y) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'month (1-12) and year required', messageTh: 'ต้องระบุเดือน (1-12) และปี' });
  return { m, y };
}

@Controller('api/tax-reports')
export class TaxReportsController {
  constructor(private readonly svc: TaxReportsService, private readonly pdf: TaxReportsPdfService) {}

  // ── JSON reads ──
  @Get('output-vat') @Permissions('exec', 'ar')
  outputVat(@Query('month') month: string, @Query('year') year: string) { const { m, y } = parseMY(month, year); return this.svc.outputVat(m, y); }

  @Get('input-vat') @Permissions('exec', 'creditors')
  inputVat(@Query('month') month: string, @Query('year') year: string) { const { m, y } = parseMY(month, year); return this.svc.inputVat(m, y); }

  @Get('pp30') @Permissions('exec')
  pp30(@Query('month') month: string, @Query('year') year: string) { const { m, y } = parseMY(month, year); return this.svc.pp30(m, y); }

  @Get('pnd') @Permissions('exec', 'creditors')
  pnd(@Query('type') type: string, @Query('month') month: string, @Query('year') year: string) { const { m, y } = parseMY(month, year); return this.svc.pnd(type, m, y); }

  // ── exports (PDF; HTML fallback when Chromium absent) ──
  @Get('output-vat/export') @Permissions('exec', 'ar')
  async outputVatExport(@Query('month') month: string, @Query('year') year: string, @Res() reply: FastifyReply) {
    const { m, y } = parseMY(month, year);
    await this.send(reply, this.pdf.outputVatHtml(await this.svc.outputVat(m, y)), `output-vat-${y}-${String(m).padStart(2, '0')}`);
  }

  @Get('input-vat/export') @Permissions('exec', 'creditors')
  async inputVatExport(@Query('month') month: string, @Query('year') year: string, @Res() reply: FastifyReply) {
    const { m, y } = parseMY(month, year);
    await this.send(reply, this.pdf.inputVatHtml(await this.svc.inputVat(m, y)), `input-vat-${y}-${String(m).padStart(2, '0')}`);
  }

  @Get('pp30/export') @Permissions('exec')
  async pp30Export(@Query('month') month: string, @Query('year') year: string, @Res() reply: FastifyReply) {
    const { m, y } = parseMY(month, year);
    await this.send(reply, this.pdf.pp30Html(await this.svc.pp30(m, y)), `pp30-${y}-${String(m).padStart(2, '0')}`);
  }

  @Get('pnd/export') @Permissions('exec', 'creditors')
  async pndExport(@Query('type') type: string, @Query('month') month: string, @Query('year') year: string, @Res() reply: FastifyReply) {
    const { m, y } = parseMY(month, year);
    await this.send(reply, this.pdf.pndHtml(await this.svc.pnd(type, m, y)), `pnd-${type}-${y}-${String(m).padStart(2, '0')}`);
  }

  private async send(reply: FastifyReply, html: string, fname: string) {
    const buf = await this.pdf.renderHtmlToPdf(html);
    if (buf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="${fname}.pdf"`).header('Content-Length', buf.length).send(buf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  }
}
