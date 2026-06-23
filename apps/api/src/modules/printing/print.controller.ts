import { Controller, Get, Post, Param, Body, Query, Header } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { PrintService } from './print.service';

const EnqueueBody = z.object({
  job_type: z.enum(['receipt', 'kitchen', 'drawer']),
  sale_no: z.string().optional(), order_no: z.string().optional(), station: z.string().optional(),
  format: z.enum(['escpos', 'html']).optional(), printer_id: z.string().optional(), payload: z.string().optional(),
});
const AckBody = z.object({ ok: z.boolean(), error: z.string().optional() });
const SendBody = z.object({ channel: z.enum(['line', 'sms', 'email']), to: z.string().min(1) });

@Controller('api/print')
@Permissions('pos')
export class PrintController {
  constructor(private readonly svc: PrintService) {}

  @Post('enqueue') enqueue(@Body(new ZodValidationPipe(EnqueueBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.enqueue(b, u); }

  // printer / agent pull-print loop
  @Get('jobs/next') next(@Query('printer_id') p: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.nextJob(u, p || undefined); }
  @Post('jobs/:id/ack') ack(@Param('id') id: string, @Body(new ZodValidationPipe(AckBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.ack(+id, b.ok, b.error, u); }
  @Get('jobs') list(@Query('status') s: string | undefined, @Query('limit') l: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.list(u, s || undefined, l ? +l : 50); }

  // receipts
  @Post('reprint/:saleNo') reprint(@Param('saleNo') s: string, @Query('format') f: 'escpos' | 'html' | undefined, @CurrentUser() u: JwtUser) { return this.svc.reprint(s, u, f); }
  @Post('receipt/:saleNo/send') send(@Param('saleNo') s: string, @Body(new ZodValidationPipe(SendBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.sendReceipt(s, b.channel, b.to, u); }
  @Get('receipt/:saleNo/data') data(@Param('saleNo') s: string, @CurrentUser() u: JwtUser) { return this.svc.preview(s, 'data', u); }
  @Get('receipt/:saleNo') @Header('Content-Type', 'text/html; charset=utf-8')
  async receipt(@Param('saleNo') s: string, @CurrentUser() u: JwtUser) { return (await this.svc.preview(s, 'html', u)).html; }

  // REST-10 control: receipt ↔ fiscal sale tie-out
  @Get('tie-out/:saleNo') tieOut(@Param('saleNo') s: string, @CurrentUser() u: JwtUser) { return this.svc.tieOut(s, u); }
}
