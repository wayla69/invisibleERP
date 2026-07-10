import { Controller, Get, Post, Param, Query, Body, Res, UnauthorizedException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Permissions, CurrentUser, Public, NoTx, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ReceiptService } from './receipt.service';
import { ReceiptDeliveryService } from './receipt-delivery.service';
import { CfdService } from './cfd.service';
import { ReceiptFormatQuery, SendReceiptBody, type SendReceiptDto } from './receipt.dto';
import { verifyReceiptToken } from './receipt-token.util';
import { RealtimeScope } from '../restaurant/realtime.scope';
import { rateLimit } from '../restaurant/rate-limit.util';

@Controller('api/pos')
export class ReceiptController {
  constructor(
    private readonly receipts: ReceiptService,
    private readonly delivery: ReceiptDeliveryService,
    private readonly cfd: CfdService,
    private readonly scope: RealtimeScope,
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

  // GET /api/pos/receipt/public/:token — PUBLIC e-receipt view (POS-2). The token is an opaque HMAC
  // capability minted when a LINE e-receipt is pushed ("ดูใบเสร็จฉบับเต็ม" button). @NoTx opts out of the
  // per-request tenant tx (anonymous request); RealtimeScope re-enters RLS pinned to the token's tenant, so
  // a forged/foreign token can never read another tenant's sale (bodyFor 404s under RLS). No print row is
  // recorded — viewing the link is not a (re)print. Rate-limited per token against brute-force scraping.
  @Public() @NoTx() @Get('receipt/public/:token')
  async publicReceipt(@Param('token') token: string, @Res() reply: FastifyReply) {
    rateLimit(`rcpt:${token.slice(0, 32)}`, 20, 60_000);
    const claim = verifyReceiptToken(token);
    if (!claim) throw new UnauthorizedException({ code: 'BAD_TOKEN', message: 'Invalid receipt token', messageTh: 'ลิงก์ใบเสร็จไม่ถูกต้อง' });
    const html = await this.scope.run(claim.tenantId, () => this.receipts.bodyFor(claim.saleNo, 'html'));
    return reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  }

  // GET /api/pos/orders/:orderNo/display  (CFD second screen)
  @Get('orders/:orderNo/display') @Permissions('pos', 'order_mgt')
  display(@Param('orderNo') orderNo: string, @CurrentUser() u: JwtUser) { return this.cfd.byOrder(orderNo, u); }
}
