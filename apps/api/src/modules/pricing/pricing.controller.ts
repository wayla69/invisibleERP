import { Controller, Get, Post, Put, Delete, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { PricingService } from './pricing.service';

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

// SoD R10: price/promo maintenance (pricelist/promos) is segregated from POS selling (pos/order_mgt).
// Read-only quote is still available to sellers for checkout price resolution;
// CREATE/UPDATE/DELETE of pricing rules and combos require pricelist or exec.
@Controller('api/pricing')
@Permissions('pricelist', 'promos', 'pos', 'order_mgt', 'exec', 'cust_pos')
export class PricingController {
  constructor(private readonly svc: PricingService) {}

  @Post('quote') quote(@Body(new ZodValidationPipe(QuoteBody)) b: z.infer<typeof QuoteBody>, @CurrentUser() u: JwtUser) { return this.svc.quote(b, u); }

  @Get('rules') list() { return this.svc.listRules(); }
  @Get('rules/:id') get(@Param('id') id: string) { return this.svc.getRule(+id); }
  // R10: only PricingManager (pricelist) or exec may create/update/delete pricing rules.
  @Post('rules') @Permissions('pricelist', 'exec') upsert(@Body(new ZodValidationPipe(RuleBody)) b: z.infer<typeof RuleBody>, @CurrentUser() u: JwtUser) { return this.svc.upsertRule(b, u); }
  @Delete('rules/:id') @Permissions('pricelist', 'exec') del(@Param('id') id: string) { return this.svc.deleteRule(+id); }

  @Get('combos/:sku') getCombo(@Param('sku') sku: string) { return this.svc.getCombo(sku); }
  // R10: combo maintenance is pricelist/promos only.
  @Put('combos/:sku') @Permissions('pricelist', 'promos', 'exec') setCombo(@Param('sku') sku: string, @Body(new ZodValidationPipe(ComboBody)) b: z.infer<typeof ComboBody>, @CurrentUser() u: JwtUser) { return this.svc.setCombo(sku, b.components, u); }
}
