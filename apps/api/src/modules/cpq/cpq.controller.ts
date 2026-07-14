import { Controller, Get, Post, Put, Body, Param, ParseIntPipe, Query, HttpCode, Res } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import { CpqService } from './cpq.service';
import { CpqPricebookService } from './cpq-pricebook.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

const EmailBody = z.object({ to_email: z.string().email() });

const ConfigBody = z.object({ code: z.string().min(1), name: z.string().min(1), base_price: z.number().nonnegative().optional(), description: z.string().optional() });
const OptionBody = z.object({ group_name: z.string().min(1), option_code: z.string().min(1), option_name: z.string().min(1), price_delta: z.number().optional(), is_default: z.boolean().optional() });
const RuleBody = z.object({ name: z.string().min(1), rule_type: z.string().optional(), discount_pct: z.number(), min_qty: z.number().nonnegative().optional() });
const QuoteBody = z.object({
  customer_name: z.string().min(1), opportunity_id: z.number().optional(), config_id: z.number().optional(),
  qty: z.number().positive().optional(), unit_cost: z.number().nonnegative().optional(),
  selected_options: z.array(z.object({ group_name: z.string().min(1), option_code: z.string().min(1) })).optional(),
  validity_days: z.number().int().positive().optional(), notes: z.string().optional(),
  pricebook_id: z.number().int().optional(), // CRM-15: price the lines from a governed pricebook
  lines: z.array(z.object({ description: z.string().min(1), qty: z.number().optional(), unit_price: z.number().optional(), unit_cost: z.number().nonnegative().optional(), item_code: z.string().optional() })).optional(),
});
// CRM-15 CPQ pricebooks — master-data CRUD (masterdata duty).
const PricebookBody = z.object({ code: z.string().min(1), name: z.string().min(1), currency: z.string().optional(), effective_from: z.string().optional().nullable(), effective_to: z.string().optional().nullable(), is_active: z.boolean().optional() });
const PricebookEntriesBody = z.object({ entries: z.array(z.object({ item_code: z.string().min(1), unit_price: z.number().nonnegative() })).min(1).max(2000) });
// CPQ-01 (SVC-1): per-tenant discount/margin floor. CRM-14 (CRM-12): exec_discount_pct is the optional
// tier-2 ceiling (null clears tiering).
const SettingsBody = z.object({ min_margin_pct: z.number().min(0).max(100).optional(), max_discount_pct: z.number().min(0).max(100).optional(), exec_discount_pct: z.number().min(0).max(100).nullable().optional() });
// CRM-14 (CRM-12): bundle master data + adding a bundle instance to a Draft quote.
const BundleBody = z.object({
  code: z.string().min(1), name: z.string().min(1), description: z.string().optional(),
  items: z.array(z.object({ config_id: z.number().int(), qty: z.number().positive().optional(), unit_cost: z.number().nonnegative().optional() })).min(1).max(50),
});
const BundleLineBody = z.object({ bundle_code: z.string().min(1), qty: z.number().positive().optional(), discount_pct: z.number().min(0).max(100).optional() });

@Controller('api/cpq')
export class CpqController {
  constructor(private readonly svc: CpqService, private readonly pricebooks: CpqPricebookService) {}

  // ── CRM-15 pricebooks: governed, effective-dated price lists a quote can be priced from ──
  @Get('pricebooks') @Permissions('exec', 'cpq') listPricebooks(@CurrentUser() u: JwtUser) { return this.pricebooks.listPricebooks(u); }
  @Get('pricebooks/:code') @Permissions('exec', 'cpq') getPricebook(@Param('code') code: string, @CurrentUser() u: JwtUser) { return this.pricebooks.getPricebook(code, u); }
  @Post('pricebooks') @Permissions('masterdata') createPricebook(@Body(new ZodValidationPipe(PricebookBody)) dto: z.infer<typeof PricebookBody>, @CurrentUser() u: JwtUser) { return this.pricebooks.createPricebook(dto, u); }
  @Post('pricebooks/:code/entries') @Permissions('masterdata') upsertEntries(@Param('code') code: string, @Body(new ZodValidationPipe(PricebookEntriesBody)) dto: z.infer<typeof PricebookEntriesBody>, @CurrentUser() u: JwtUser) { return this.pricebooks.upsertEntries(code, dto.entries, u); }

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

  // CPQ-01 (SVC-1): per-tenant discount/margin floor — read is exec/cpq, changing it is a config duty.
  @Get('settings')
  @Permissions('exec', 'cpq', 'cpq_approve')
  getSettings(@CurrentUser() user: JwtUser) { return this.svc.getSettings(user); }

  @Put('settings')
  @Permissions('masterdata', 'exec')
  updateSettings(@Body(new ZodValidationPipe(SettingsBody)) dto: z.infer<typeof SettingsBody>, @CurrentUser() user: JwtUser) { return this.svc.updateSettings(dto, user); }

  @Get('quotes')
  @Permissions('exec', 'cpq')
  listQuotes(@Query('status') status?: string, @CurrentUser() user?: JwtUser) { return this.svc.listQuotes({ status }, user!); }

  // CPQ-01: the maker-checker queue of floor-breaching quotes (author view + approver worklist).
  @Get('approvals')
  @Permissions('exec', 'cpq', 'cpq_approve')
  listApprovals(@Query('status') status?: string, @CurrentUser() user?: JwtUser) { return this.svc.listApprovals({ status }, user!); }

  @Post('quotes')
  @Permissions('exec', 'cpq')
  createQuote(@Body(new ZodValidationPipe(QuoteBody)) dto: z.infer<typeof QuoteBody>, @CurrentUser() user: JwtUser) { return this.svc.createQuote(dto, user); }

  @Get('quotes/:id/lines')
  @Permissions('exec', 'cpq')
  getLines(@Param('id', ParseIntPipe) id: number) { return this.svc.getQuoteLines(id); }

  @Post('quotes/:id/send')
  @Permissions('exec', 'cpq')
  @HttpCode(200)
  send(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.sendQuote(id, user); }

  // CPQ-01: approve a floor-breaching quote (PendingApproval → Sent). Reserved to the approver duty; the
  // author cannot self-approve (SOD_SELF_APPROVAL, enforced in the service regardless of permission).
  @Post('quotes/:id/approve')
  @Permissions('exec', 'cpq_approve')
  @HttpCode(200)
  approve(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.approveDiscount(id, user); }

  // Printable ใบเสนอราคา (Quotation) — HTML→PDF via the shared renderer, HTML fallback when Chromium absent.
  @Get('quotes/:id/pdf')
  @Permissions('exec', 'cpq')
  async pdf(@Param('id', ParseIntPipe) id: number, @Res() reply: FastifyReply) {
    const q = await this.svc.getQuoteForPrint(id);
    const html = this.svc.quotationHtml(q);
    const buf = await this.svc.renderQuotePdf(q);
    if (buf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${q.quote_no}.pdf"`).header('Content-Length', buf.length).send(buf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  }

  // Email the quotation to the customer as a PDF attachment (marks the quote Sent).
  @Post('quotes/:id/send-email')
  @Permissions('exec', 'cpq')
  @HttpCode(200)
  sendEmail(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(EmailBody)) b: z.infer<typeof EmailBody>, @CurrentUser() user: JwtUser) {
    return this.svc.emailQuote(id, b.to_email, user);
  }

  @Post('quotes/:id/accept')
  @Permissions('exec', 'cpq')
  @HttpCode(200)
  accept(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.acceptQuote(id, user); }

  // Reject: for a PendingApproval quote this is the checker declining the discount/margin breach (→ Draft,
  // SOD_SELF_APPROVAL); for a Sent/Draft quote it is the classic quote rejection (→ Rejected).
  @Post('quotes/:id/reject')
  @Permissions('exec', 'cpq', 'cpq_approve')
  @HttpCode(200)
  reject(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.rejectQuote(id, user); }

  // ── CRM-14 (CRM-12): bundles — master data (masterdata-gated, mirrors config/rule creation) ──
  @Get('bundles')
  @Permissions('exec', 'cpq')
  listBundles(@CurrentUser() user: JwtUser) { return this.svc.listBundles(user); }

  @Get('bundles/:code')
  @Permissions('exec', 'cpq')
  getBundle(@Param('code') code: string, @CurrentUser() user: JwtUser) { return this.svc.getBundle(code, user); }

  @Post('bundles')
  @Permissions('masterdata')
  createBundle(@Body(new ZodValidationPipe(BundleBody)) dto: z.infer<typeof BundleBody>, @CurrentUser() user: JwtUser) { return this.svc.createBundle(dto, user); }

  // Expand a bundle instance into the quote's lines (Draft only) — the SAME CPQ-01 floor check on send()
  // then covers the bundle's blended margin.
  @Post('quotes/:id/lines/bundle')
  @Permissions('exec', 'cpq')
  addBundleLine(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(BundleLineBody)) dto: z.infer<typeof BundleLineBody>, @CurrentUser() user: JwtUser) { return this.svc.addBundleLine(id, dto, user); }

  // ── CRM-14 (CRM-12): guided-selling — explainable co-purchase recommendations (no trained model) ──
  @Get('recommendations')
  @Permissions('exec', 'cpq')
  recommendations(@Query('config_code') configCode: string, @CurrentUser() user: JwtUser) { return this.svc.recommendations(configCode, user); }
}
