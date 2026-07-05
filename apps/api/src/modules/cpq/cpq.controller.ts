import { Controller, Get, Post, Body, Param, ParseIntPipe, Query, HttpCode, Res } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import { CpqService } from './cpq.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

const EmailBody = z.object({ to_email: z.string().email() });

const ConfigBody = z.object({ code: z.string().min(1), name: z.string().min(1), base_price: z.number().nonnegative().optional(), description: z.string().optional() });
const OptionBody = z.object({ group_name: z.string().min(1), option_code: z.string().min(1), option_name: z.string().min(1), price_delta: z.number().optional(), is_default: z.boolean().optional() });
const RuleBody = z.object({ name: z.string().min(1), rule_type: z.string().optional(), discount_pct: z.number(), min_qty: z.number().nonnegative().optional() });
const QuoteBody = z.object({
  customer_name: z.string().min(1), opportunity_id: z.number().optional(), config_id: z.number().optional(),
  qty: z.number().positive().optional(),
  selected_options: z.array(z.object({ group_name: z.string().min(1), option_code: z.string().min(1) })).optional(),
  validity_days: z.number().int().positive().optional(), notes: z.string().optional(),
  lines: z.array(z.object({ description: z.string().min(1), qty: z.number().optional(), unit_price: z.number().optional() })).optional(),
});

@Controller('api/cpq')
export class CpqController {
  constructor(private readonly svc: CpqService) {}

  @Get('configs')
  @Permissions('exec')
  listConfigs(@CurrentUser() user: JwtUser) { return this.svc.listConfigs(user); }

  @Post('configs')
  @Permissions('masterdata')
  createConfig(@Body(new ZodValidationPipe(ConfigBody)) dto: z.infer<typeof ConfigBody>, @CurrentUser() user: JwtUser) { return this.svc.createConfig(dto, user); }

  @Post('configs/:id/options')
  @Permissions('masterdata')
  addOption(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(OptionBody)) dto: z.infer<typeof OptionBody>, @CurrentUser() user: JwtUser) { return this.svc.addOption(id, dto, user); }

  @Post('configs/:id/rules')
  @Permissions('masterdata')
  createRule(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(RuleBody)) dto: z.infer<typeof RuleBody>, @CurrentUser() user: JwtUser) { return this.svc.createRule({ ...dto, config_id: id }, user); }

  @Get('quotes')
  @Permissions('exec')
  listQuotes(@Query('status') status?: string, @CurrentUser() user?: JwtUser) { return this.svc.listQuotes({ status }, user!); }

  @Post('quotes')
  @Permissions('exec')
  createQuote(@Body(new ZodValidationPipe(QuoteBody)) dto: z.infer<typeof QuoteBody>, @CurrentUser() user: JwtUser) { return this.svc.createQuote(dto, user); }

  @Get('quotes/:id/lines')
  @Permissions('exec')
  getLines(@Param('id', ParseIntPipe) id: number) { return this.svc.getQuoteLines(id); }

  @Post('quotes/:id/send')
  @Permissions('exec')
  @HttpCode(200)
  send(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.sendQuote(id, user); }

  // Printable ใบเสนอราคา (Quotation) — HTML→PDF via the shared renderer, HTML fallback when Chromium absent.
  @Get('quotes/:id/pdf')
  @Permissions('exec')
  async pdf(@Param('id', ParseIntPipe) id: number, @Res() reply: FastifyReply) {
    const q = await this.svc.getQuoteForPrint(id);
    const html = this.svc.quotationHtml(q);
    const buf = await this.svc.renderQuotePdf(q);
    if (buf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${q.quote_no}.pdf"`).header('Content-Length', buf.length).send(buf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  }

  // Email the quotation to the customer as a PDF attachment (marks the quote Sent).
  @Post('quotes/:id/send-email')
  @Permissions('exec')
  @HttpCode(200)
  sendEmail(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(EmailBody)) b: z.infer<typeof EmailBody>, @CurrentUser() user: JwtUser) {
    return this.svc.emailQuote(id, b.to_email, user);
  }

  @Post('quotes/:id/accept')
  @Permissions('exec')
  @HttpCode(200)
  accept(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.acceptQuote(id, user); }

  @Post('quotes/:id/reject')
  @Permissions('exec')
  @HttpCode(200)
  reject(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.rejectQuote(id, user); }
}
