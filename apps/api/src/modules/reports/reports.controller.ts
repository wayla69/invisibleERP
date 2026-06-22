import { Controller, Get, Post, Param, Query, Body, Res, Inject, BadRequestException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { orders, orderLines, tenants } from '../../database/schema';
import { ReportsService } from './reports.service';
import { ReportExcelService } from './reports-excel.service';
import { ReportPdfService } from './reports-pdf.service';
import { ReportExportService } from './reports-export.service';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const UTF8_BOM = '﻿';

const ExportOrderBody = z.object({ format: z.enum(['pdf', 'express_txt']) });
type ExportOrderDto = z.infer<typeof ExportOrderBody>;

@Controller()
export class ReportsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly svc: ReportsService,
    private readonly excel: ReportExcelService,
    private readonly pdf: ReportPdfService,
    private readonly exporter: ReportExportService,
  ) {}

  // ───────────────────── existing JSON reads ─────────────────────
  @Get('api/reports/daily-sales')
  @Permissions('dashboard', 'pos', 'exec')
  daily(@Query('date') date?: string) {
    return this.svc.dailySales(date);
  }

  @Get('api/reports/stock-summary')
  @Permissions('warehouse', 'dashboard', 'planner')
  stock() {
    return this.svc.stockSummary();
  }

  // ───────────────────── Excel exports ─────────────────────
  // GET /api/reports/daily-sales/export?date=
  @Get('api/reports/daily-sales/export')
  @Permissions('dashboard', 'warehouse')
  async dailySalesExport(@Query('date') date: string | undefined, @Res() reply: FastifyReply) {
    const buf = await this.excel.dailySalesXlsx(date);
    const fname = `daily-sales-${date ?? 'today'}.xlsx`;
    this.sendDownload(reply, buf, XLSX_MIME, fname);
  }

  // GET /api/reports/monthly-pl/export?month=&year=
  @Get('api/reports/monthly-pl/export')
  @Permissions('dashboard', 'warehouse')
  async monthlyPlExport(@Query('month') month: string, @Query('year') year: string, @Res() reply: FastifyReply) {
    const m = parseInt(month, 10);
    const y = parseInt(year, 10);
    if (!m || m < 1 || m > 12 || !y) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'month (1-12) and year required', messageTh: 'ต้องระบุเดือน (1-12) และปี' });
    }
    const buf = await this.excel.monthlyPlXlsx(m, y);
    this.sendDownload(reply, buf, XLSX_MIME, `monthly-pl-${y}-${String(m).padStart(2, '0')}.xlsx`);
  }

  // GET /api/reports/stock-summary/export?low=
  @Get('api/reports/stock-summary/export')
  @Permissions('dashboard', 'warehouse')
  async stockSummaryExport(@Query('low') low: string | undefined, @Res() reply: FastifyReply) {
    const lowOnly = low === '1' || low === 'true';
    const buf = await this.excel.stockSummaryXlsx(lowOnly);
    this.sendDownload(reply, buf, XLSX_MIME, `stock-summary${lowOnly ? '-low' : ''}.xlsx`);
  }

  // GET /api/reports/ap-aging/export
  @Get('api/reports/ap-aging/export')
  @Permissions('creditors', 'exec')
  async apAgingExport(@Res() reply: FastifyReply) {
    const buf = await this.excel.apAgingXlsx();
    this.sendDownload(reply, buf, XLSX_MIME, 'ap-aging.xlsx');
  }

  // ───────────────────── per-order export (PDF / Express TXT) ─────────────────────
  // POST /api/orders/:orderNo/export  body {format:'pdf'|'express_txt'}
  @Post('api/orders/:orderNo/export')
  @Permissions('order_mgt', 'pos')
  async exportOrder(
    @Param('orderNo') orderNo: string,
    @Body(new ZodValidationPipe(ExportOrderBody)) body: ExportOrderDto,
    @CurrentUser() _user: JwtUser,
    @Res() reply: FastifyReply,
  ) {
    if (body.format === 'express_txt') {
      const txt = await this.exporter.expressTxt(orderNo);
      this.sendDownload(reply, Buffer.from(UTF8_BOM + txt, 'utf-8'), 'text/plain; charset=utf-8', `${orderNo}.txt`);
      return;
    }

    // pdf → sales confirmation
    const db = this.db as any;
    const [order] = await db.select().from(orders).where(eq(orders.orderNo, orderNo)).limit(1);
    if (!order) {
      throw new BadRequestException({ code: 'NOT_FOUND', message: 'Order not found', messageTh: 'ไม่พบคำสั่งซื้อ' });
    }
    let tenant: any = null;
    if (order.tenantId != null) {
      [tenant] = await db.select().from(tenants).where(eq(tenants.id, order.tenantId)).limit(1);
    }
    const lines = await db.select().from(orderLines).where(eq(orderLines.orderId, order.id));

    const html = this.pdf.salesConfirmationHtml(order, lines, tenant);
    const pdfBuf = await this.pdf.renderHtmlToPdf(html);
    if (pdfBuf) {
      this.sendDownload(reply, pdfBuf, 'application/pdf', `${orderNo}.pdf`);
    } else {
      // Chromium unavailable → fall back to HTML
      reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
    }
  }

  // ── helper ──────────────────────────────────────────────────────────
  private sendDownload(reply: FastifyReply, buf: Buffer, mime: string, filename: string) {
    reply
      .header('Content-Type', mime)
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .header('Content-Length', buf.length)
      .send(buf);
  }
}
