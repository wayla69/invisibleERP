import { Controller, Get, Post, Put, Delete, Param, Body, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { PricingService } from './pricing.service';
import { PriceBookService } from './price-book.service';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';

const RuleBody = z.object({
  id: z.number().optional(), name: z.string().min(1), scope: z.enum(['all', 'item', 'category']).optional(),
  target_id: z.string().optional(), channel: z.enum(['any', 'dine_in', 'takeaway', 'delivery']).optional(),
  location: z.string().optional(), dow: z.string().optional(), time_start: z.string().optional(), time_end: z.string().optional(),
  type: z.enum(['percent', 'amount', 'fixed', 'bogo', 'qty_break']), value: z.number().optional(), min_qty: z.number().int().optional(),
  priority: z.number().int().optional(), stackable: z.boolean().optional(), active: z.boolean().optional(),
  valid_from: z.string().optional(), valid_to: z.string().optional(),
});
const QuoteBody = z.object({
  channel: z.string().optional(), location: z.string().optional(), party_size: z.number().int().optional(), at: z.string().optional(),
  service_charge_pct: z.number().optional(), service_min_party: z.number().int().optional(), surcharge_pct: z.number().optional(), rounding: z.number().optional(),
  lines: z.array(z.object({ sku: z.string(), qty: z.number(), unit_price: z.number().optional(), category: z.string().optional() })).min(1),
});
const ComboBody = z.object({ components: z.array(z.object({ component_sku: z.string(), qty: z.number().optional(), unit_price_override: z.number().optional() })) });
const RuleRejectBody = z.object({ reason: z.string().max(500).optional() });
// docs/52 Phase 4a — price books (governed base-price lists by customer tier / branch).
const BookBody = z.object({
  id: z.number().optional(), name: z.string().min(1), tier: z.string().max(60).nullish(),
  branch_id: z.number().int().nullish(), customer_code: z.string().max(120).nullish(), currency: z.string().max(3).optional(), priority: z.number().int().optional(),
  valid_from: z.string().nullish(), valid_to: z.string().nullish(),
});
const BookEntriesBody = z.object({ entries: z.array(z.object({ item_id: z.string().min(1), unit_price: z.number().min(0), min_qty: z.number().int().min(1).optional() })) });

// SoD R10: price/promo maintenance (pricelist/promos) is segregated from POS selling (pos/order_mgt).
// Read-only quote is still available to sellers for checkout price resolution;
// CREATE/UPDATE/DELETE of pricing rules and combos require pricelist or exec.
@Controller('api/pricing')
@Permissions('pricelist', 'promos', 'pos', 'order_mgt', 'exec', 'cust_pos')
export class PricingController {
  constructor(private readonly svc: PricingService, private readonly books: PriceBookService) {}

  @Post('quote') quote(@Body(new ZodValidationPipe(QuoteBody)) b: z.infer<typeof QuoteBody>, @CurrentUser() u: JwtUser) { return this.svc.quote(b, u); }

  @Get('rules') list() { return this.svc.listRules(); }
  // R10 maker-checker (audit G6): staged rules awaiting activation. Declared before `rules/:id` so the
  // literal path wins over the :id param.
  @Get('rules/pending') @Permissions('pricelist', 'exec', 'approvals') pendingRules() { return this.svc.listPendingRules(); }
  @Get('rules/:id') get(@Param('id') id: string) { return this.svc.getRule(+id); }
  // R10: only PricingManager (pricelist) or exec may create/update pricing rules. A change is STAGED
  // (inactive) and must be ACTIVATED by a DIFFERENT user (exec/approvals) — the author cannot self-approve.
  @Post('rules') @Permissions('pricelist', 'exec') upsert(@Body(new ZodValidationPipe(RuleBody)) b: z.infer<typeof RuleBody>, @CurrentUser() u: JwtUser) { return this.svc.upsertRule(b, u); }
  @Post('rules/:id/approve') @Permissions('exec', 'approvals') approveRule(@Param('id') id: string, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) { return this.svc.approveRule(+id, u, b?.self_approval_reason); }
  @Post('rules/:id/reject') @Permissions('exec', 'approvals') rejectRule(@Param('id') id: string, @Body(new ZodValidationPipe(RuleRejectBody)) b: z.infer<typeof RuleRejectBody>, @CurrentUser() u: JwtUser) { return this.svc.rejectRule(+id, u, b.reason); }
  @Delete('rules/:id') @Permissions('pricelist', 'exec') del(@Param('id') id: string) { return this.svc.deleteRule(+id); }

  // ── Price books (docs/52 Phase 4a) — governed base-price lists by customer tier / branch. ─────────────
  // Read the effective governed price for an item at the till (sellers may call it for display). A miss
  // (price:null) means no approved book prices this item → the client/list price stands.
  @Get('book-price') bookPrice(@CurrentUser() u: JwtUser, @Query('item_id') itemId: string, @Query('tier') tier?: string, @Query('branch_id') branchId?: string, @Query('qty') qty?: string) {
    const q = new Map<string, number>([[String(itemId), qty ? +qty : 1]]);
    return this.books.bookPrice(u.tenantId ?? 0, String(itemId), { tier: tier ?? null, branchId: branchId ? +branchId : null, qtyByItem: q });
  }
  @Get('books') listBooks() { return this.books.listBooks(); }
  // Staged books awaiting activation. Literal path declared before `books/:id` so it wins over the :id param.
  @Get('books/pending') @Permissions('pricelist', 'exec', 'approvals') pendingBooks() { return this.books.listPending(); }
  @Get('books/:id') getBook(@Param('id') id: string) { return this.books.getBook(+id); }
  // R10: only PricingManager (pricelist) or exec maintains a book. A change is STAGED (inactive) and must be
  // ACTIVATED by a DIFFERENT user (exec/approvals) — the author cannot self-approve (SoD, mirrors price rules).
  @Post('books') @Permissions('pricelist', 'exec') upsertBook(@Body(new ZodValidationPipe(BookBody)) b: z.infer<typeof BookBody>, @CurrentUser() u: JwtUser) { return this.books.upsertBook(b, u); }
  @Post('books/:id/entries') @Permissions('pricelist', 'exec') setEntries(@Param('id') id: string, @Body(new ZodValidationPipe(BookEntriesBody)) b: z.infer<typeof BookEntriesBody>, @CurrentUser() u: JwtUser) { return this.books.setEntries(+id, b.entries, u); }
  @Post('books/:id/approve') @Permissions('exec', 'approvals') approveBook(@Param('id') id: string, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) { return this.books.approveBook(+id, u, b?.self_approval_reason); }
  @Post('books/:id/reject') @Permissions('exec', 'approvals') rejectBook(@Param('id') id: string, @Body(new ZodValidationPipe(RuleRejectBody)) b: z.infer<typeof RuleRejectBody>, @CurrentUser() u: JwtUser) { return this.books.rejectBook(+id, u, b.reason); }
  @Delete('books/:id') @Permissions('pricelist', 'exec') delBook(@Param('id') id: string) { return this.books.deleteBook(+id); }

  @Get('combos/:sku') getCombo(@Param('sku') sku: string) { return this.svc.getCombo(sku); }
  // R10: combo maintenance is pricelist/promos only.
  @Put('combos/:sku') @Permissions('pricelist', 'promos', 'exec') setCombo(@Param('sku') sku: string, @Body(new ZodValidationPipe(ComboBody)) b: z.infer<typeof ComboBody>, @CurrentUser() u: JwtUser) { return this.svc.setCombo(sku, b.components, u); }
}
