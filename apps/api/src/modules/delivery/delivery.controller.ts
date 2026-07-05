import { Controller, Get, Post, Patch, Param, Query, Body, HttpCode, Res } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { DeliveryService } from './delivery.service';

const EmailBody = z.object({ to_email: z.string().email() });

const CreateBody = z.object({
  order_no: z.string().optional(), address: z.string().optional(), driver: z.string().optional(),
  vehicle: z.string().optional(), remarks: z.string().optional(),
  lines: z.array(z.object({ item_id: z.string().min(1), item_description: z.string().optional(), qty: z.number().positive(), uom: z.string().optional() })).optional(),
});
const StatusBody = z.object({ status: z.string().min(1), pod_image_key: z.string().optional(), driver: z.string().optional(), vehicle: z.string().optional() });

@Controller('api/delivery')
@Permissions('delivery')
export class DeliveryController {
  constructor(private readonly svc: DeliveryService) {}

  @Post() create(@Body(new ZodValidationPipe(CreateBody)) b: z.infer<typeof CreateBody>, @CurrentUser() u: JwtUser) { return this.svc.create(b, u); }
  @Get() list(@Query('status') status?: string) { return this.svc.list(status); }
  @Get(':doNo') detail(@Param('doNo') no: string) { return this.svc.detail(no); }
  @Patch(':doNo/status') status(@Param('doNo') no: string, @Body(new ZodValidationPipe(StatusBody)) b: z.infer<typeof StatusBody>, @CurrentUser() u: JwtUser) { return this.svc.updateStatus(no, b, u); }

  // Printable ใบส่งของ (Delivery Note) — HTML→PDF via the shared renderer, HTML fallback when Chromium absent.
  @Get(':doNo/pdf')
  async pdf(@Param('doNo') no: string, @Res() reply: FastifyReply) {
    const d = await this.svc.getForPrint(no);
    const html = this.svc.deliveryNoteHtml(d);
    const buf = await this.svc.renderPdf(d);
    if (buf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${no}.pdf"`).header('Content-Length', buf.length).send(buf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  }

  // Email the delivery note to the customer as a PDF attachment.
  @Post(':doNo/send-email') @HttpCode(200)
  sendEmail(@Param('doNo') no: string, @Body(new ZodValidationPipe(EmailBody)) b: z.infer<typeof EmailBody>) {
    return this.svc.emailDelivery(no, b.to_email);
  }
}
