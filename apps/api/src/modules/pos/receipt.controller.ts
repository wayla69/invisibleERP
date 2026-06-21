import { Controller, Get, Post, Param, Query, Body, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ReceiptService } from './receipt.service';
import { ReceiptDeliveryService } from './receipt-delivery.service';
import { CfdService } from './cfd.service';
import { ReceiptFormatQuery, SendReceiptBody, type SendReceiptDto } from './receipt.dto';

@Controller('api/pos')
export class ReceiptController {
  constructor(
    private readonly receipts: ReceiptService,
    private readonly delivery: ReceiptDeliveryService,
    private readonly cfd: CfdService,
  ) {}

  // GET /api/pos/sales/:saleNo/receipt?format=html|pdf|escpos
  @Get('sales/:saleNo/receipt') @Permissions('pos', 'cust_pos', 'order_mgt')
  async receipt(@Param('saleNo') saleNo: string, @Query('format') format: string | undefined, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const fmt = ReceiptFormatQuery.parse(format ?? 'html');
    if (fmt === 'escpos') {
      const { text } = await this.receipts.renderEscPos(saleNo, u);
      return reply.header('Content-Type', 'text/plain; charset=utf-8').send(text);
    }
    if (fmt === 'pdf') {
      const { pdf, html } = await this.receipts.renderPdfOrHtml(saleNo, u);
      return pdf
        ? reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${saleNo}-receipt.pdf"`).send(pdf)
        : reply.header('Content-Type', 'text/html; charset=utf-8').send(html); // Chromium-absent fallback
    }
    const { html } = await this.receipts.renderHtml(saleNo, u);
    return reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  }

  // POST /api/pos/sales/:saleNo/receipt/send  { channel, to }
  @Post('sales/:saleNo/receipt/send') @Permissions('pos', 'cust_pos', 'order_mgt')
  send(@Param('saleNo') saleNo: string, @Body(new ZodValidationPipe(SendReceiptBody)) b: SendReceiptDto, @CurrentUser() u: JwtUser) {
    return this.delivery.send(saleNo, b, u);
  }

  // GET /api/pos/orders/:orderNo/display  (CFD second screen)
  @Get('orders/:orderNo/display') @Permissions('pos', 'order_mgt')
  display(@Param('orderNo') orderNo: string, @CurrentUser() u: JwtUser) { return this.cfd.byOrder(orderNo, u); }
}
