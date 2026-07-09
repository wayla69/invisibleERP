import { Controller, Get, Post, Body, Param, Query, Res, BadRequestException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { TaxReportsService } from './tax-reports.service';
import { TaxReportsPdfService } from './tax-reports-pdf.service';
import { tis620, outputVatCsv, inputVatCsv, pp30Csv } from './rd-efiling';

const FileBody = z.object({ filing_type: z.enum(['PP30', 'PND3', 'PND53', 'PP36', 'PT40']), month: z.number().int().min(1).max(12), year: z.number().int().min(2000) });
const SubmitBody = z.object({ submission_ref: z.string().min(1) });

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

  // TAX-08 — ภ.พ.36 reverse-charge / self-assessed VAT on imported services (ม.83/6).
  @Get('pp36') @Permissions('exec', 'creditors')
  pp36(@Query('month') month: string, @Query('year') year: string) { const { m, y } = parseMY(month, year); return this.svc.pp36(m, y); }

  // TAX-09 — ภ.ธ.40 Specific Business Tax on commercial immovable-property sales (ม.91/2(6)).
  @Get('pt40') @Permissions('exec', 'ar')
  pt40(@Query('month') month: string, @Query('year') year: string) { const { m, y } = parseMY(month, year); return this.svc.pt40(m, y); }

  // TAX-03 — ภ.ง.ด.3/53 → GL 2361 tie-out (vendor WHT held vs withheld vs certificated).
  @Get('pnd-tieout') @Permissions('exec', 'creditors')
  pndTieOut(@Query('month') month: string, @Query('year') year: string) { const { m, y } = parseMY(month, year); return this.svc.pndTieOut(m, y); }

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

  // ── RD e-Filing attachment files (machine-readable; PDF exports above stay the human working papers) ──
  // ภ.ง.ด.3/53 ใบแนบ .txt for the RD transfer program. Default TIS-620 (the program's encoding);
  // ?enc=utf8 for inspection in modern editors.
  @Get('pnd/efiling') @Permissions('exec', 'creditors')
  async pndEfiling(@Query('type') type: string, @Query('month') month: string, @Query('year') year: string, @Query('enc') enc: string | undefined, @Res() reply: FastifyReply) {
    const { m, y } = parseMY(month, year);
    const f = await this.svc.pndEfiling(type, m, y);
    const body = enc === 'utf8' ? Buffer.from(f.text, 'utf8') : tis620(f.text);
    reply.header('Content-Type', `text/plain; charset=${enc === 'utf8' ? 'utf-8' : 'tis-620'}`)
      .header('Content-Disposition', `attachment; filename="${f.filename}"`)
      .header('Content-Length', body.length).send(body);
  }

  @Get('output-vat/csv') @Permissions('exec', 'ar')
  async outputVatCsv(@Query('month') month: string, @Query('year') year: string, @Res() reply: FastifyReply) {
    const { m, y } = parseMY(month, year);
    const rep = await this.svc.outputVat(m, y);
    this.sendCsv(reply, outputVatCsv(rep), `output-vat-${rep.period}`);
  }

  @Get('input-vat/csv') @Permissions('exec', 'creditors')
  async inputVatCsv(@Query('month') month: string, @Query('year') year: string, @Res() reply: FastifyReply) {
    const { m, y } = parseMY(month, year);
    const rep = await this.svc.inputVat(m, y);
    this.sendCsv(reply, inputVatCsv(rep), `input-vat-${rep.period}`);
  }

  @Get('pp30/csv') @Permissions('exec')
  async pp30Csv(@Query('month') month: string, @Query('year') year: string, @Res() reply: FastifyReply) {
    const { m, y } = parseMY(month, year);
    const rep = await this.svc.pp30(m, y);
    this.sendCsv(reply, pp30Csv(rep), `pp30-${rep.period}`);
  }

  // ── filing register + remittance calendar (TAX-05) ──
  @Get('filings') @Permissions('exec', 'creditors', 'ar')
  listFilings(@Query('year') year?: string) { return this.svc.listFilings({ year: year ? parseInt(year, 10) : undefined }); }

  @Get('remittance-calendar') @Permissions('exec', 'creditors', 'ar')
  remittanceCalendar(@Query('year') year: string) { const y = parseInt(year, 10); if (!y) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'year required', messageTh: 'ต้องระบุปี' }); return this.svc.remittanceCalendar(y); }

  @Post('filings') @Permissions('exec')
  file(@Body(new ZodValidationPipe(FileBody)) b: { filing_type: string; month: number; year: number }, @CurrentUser() u: JwtUser) { return this.svc.fileReturn(b.filing_type, b.month, b.year, u); }

  @Post('filings/:id/submit') @Permissions('exec')
  submit(@Param('id') id: string, @Body(new ZodValidationPipe(SubmitBody)) b: { submission_ref: string }, @CurrentUser() u: JwtUser) { return this.svc.submitFiling(Number(id), b.submission_ref, u); }

  @Post('filings/:id/accept') @Permissions('exec')
  accept(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.acceptFiling(Number(id), u); }

  // CSV with a UTF-8 BOM so Thai opens correctly in Excel (the standard accountant workflow).
  private sendCsv(reply: FastifyReply, csv: string, fname: string) {
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv, 'utf8')]);
    reply.header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${fname}.csv"`)
      .header('Content-Length', body.length).send(body);
  }

  private async send(reply: FastifyReply, html: string, fname: string) {
    const buf = await this.pdf.renderHtmlToPdf(html);
    if (buf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="${fname}.pdf"`).header('Content-Length', buf.length).send(buf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  }
}
