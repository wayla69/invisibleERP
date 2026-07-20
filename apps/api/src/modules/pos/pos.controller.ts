import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { qint } from '../../common/query';
import { PosService, type CreateOrderDto } from './pos.service';
import { PosProfileService } from './pos-profile.service';
import { PosSaleService } from './pos-sale.service';
import { type PortalSaleDto } from '../portal/portal.pos.service';
import { ConvertAbbBody, type ConvertAbbDto } from '../tax/documents/dto';

const CreateOrderBody = z.object({
  customer_name: z.string().optional(),
  items: z.array(z.object({
    item_id: z.string().min(1),
    item_description: z.string().optional(),
    order_qty: z.number().positive(),
    stock_uom: z.string().optional(),
    unit_price: z.number().nonnegative(),
  })).min(1),
});

const UpdateStatusBody = z.object({
  status: z.string().min(1),
  estimated_delivery: z.string().nullish(),
});

// docs/52 Phase 1b — generic (non-restaurant) sale body. Mirrors the portal SaleBody (the shared engine).
const PosSaleBody = z.object({
  items: z.array(z.object({
    item_id: z.string().min(1), item_description: z.string().optional(),
    qty: z.number().positive(), unit_price: z.number().nonnegative(),
    uom: z.string().optional(), discount_pct: z.number().min(0).max(100).optional(),
    modifier_option_ids: z.array(z.number().int()).optional(),
    lot_no: z.string().trim().max(64).optional(), // docs/52 Phase 3a — explicit lot for a lot-tracked item (else FEFO)
    serial_nos: z.array(z.string().trim().min(1).max(64)).max(500).optional(), // docs/52 Phase 3b — serial/IMEI per unit for a serial-tracked item
  })).min(1),
  discount: z.number().nonnegative().optional(),
  payment_method: z.string().optional(),
  notes: z.string().optional(),
  apply_pricing: z.boolean().optional(),
  channel: z.string().optional(),
  party_size: z.number().int().optional(),
  service_charge_pct: z.number().min(0).max(100).optional(),
  service_min_party: z.number().int().positive().optional(),
  rounding: z.number().nonnegative().optional(),
  branch_id: z.number().int().positive().optional(),
  // docs/52 Phase 3c — age-restricted gate: cashier attests ID checked, or a customer birthdate proves age.
  age_ack: z.boolean().optional(),
  customer_birthdate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // docs/52 Phase 6a — split payment: settle one sale across several tenders (must sum to the total).
  tenders: z.array(z.object({
    method: z.string().min(1),
    amount: z.number().positive(),
    gateway: z.string().optional(),
    cash_tendered: z.number().nonnegative().optional(),
    reference: z.string().max(120).optional(),
  })).min(1).max(10).optional(),
  // docs/52 Phase 4a — price books: the customer price tier for this sale (governed base price by tier/branch).
  price_tier: z.string().max(60).optional(),
  customer_code: z.string().max(120).optional(),
  // docs/52 Phase 4b — discount authority: a supervisor's authorization (OVR-…) for an over-cap manual discount.
  discount_approval_no: z.string().max(60).optional(),
});

@Controller('api/pos')
export class PosController {
  constructor(private readonly svc: PosService, private readonly profile: PosProfileService, private readonly saleSvc: PosSaleService) {}

  // docs/52 Phase 1b — generic (non-restaurant) checkout for the internal register: rings a plain retail/
  // service sale through the shared engine (cust_pos_sales + stock move + VAT + tender), NO dine_in_orders /
  // KDS / table, revenue under the business-type profile's event. A restaurant tenant keeps the dine-in path.
  @Post('sales') @Permissions('pos_sell', 'cust_pos', 'ar')
  genericSale(@Body(new ZodValidationPipe(PosSaleBody)) b: PortalSaleDto, @CurrentUser() u: JwtUser) {
    return this.saleSvc.createGenericSale(b, u);
  }

  // docs/52 Phase 1 — the caller's tenant's business-type POS feature profile (tables/KDS/courses/buffet/
  // recipe_deduction/revenue_event/sale_path), derived from tenants.industry. The register reads this to
  // hide restaurant surfaces for a retail/services business. Readable by any POS operator.
  @Get('profile') @Permissions('pos', 'pos_sell', 'pos_till', 'cust_pos', 'order_mgt', 'dashboard')
  posProfile(@CurrentUser() u: JwtUser) { return this.profile.resolve(u); }

  // Read-only shift KPIs — also visible to single-duty POS operators (Cashier/PosSupervisor) for the POS home.
  @Get('summary') @Permissions('pos', 'pos_sell', 'pos_till', 'dashboard')
  summary(@Query('start_date') start: string, @Query('end_date') end: string) { return this.svc.summary(start, end); }

  @Get('orders') @Permissions('pos', 'pos_sell', 'pos_till', 'order_mgt', 'dashboard')
  orders(@Query('limit') limit?: string, @Query('offset') offset?: string, @Query('status') status?: string) {
    return this.svc.orders(qint('limit', limit, 20), qint('offset', offset, 0), status);
  }

  @Get('orders/:saleNo') @Permissions('pos', 'order_mgt', 'dashboard')
  orderDetail(@Param('saleNo') saleNo: string) { return this.svc.orderDetail(saleNo); }

  @Get('sessions') @Permissions('pos', 'pos_sell', 'pos_till', 'dashboard')
  sessions() { return this.svc.sessions(); }

  // WRITE
  @Post('orders') @Permissions('pos', 'order_cust')
  createOrder(@Body(new ZodValidationPipe(CreateOrderBody)) body: CreateOrderDto, @CurrentUser() user: JwtUser) {
    return this.svc.createOrder(body, user);
  }

  // C2 (docs/50 Wave 2 — POS roadmap P1b): full tax invoice (ใบกำกับเต็มรูป, ม.86/4) on demand at the
  // counter, keyed by the SALE number the buyer's receipt carries. Delegates to the SAME TAX-10 ABB→full
  // conversion (buyer tax-id validated, amounts verbatim, ABB → Replaced, idempotent one-full-per-ABB).
  // Counter duties may issue it — the same set that records the tender.
  @Post('orders/:saleNo/full-tax-invoice') @Permissions('pos', 'pos_sell', 'cust_pos', 'ar')
  fullTaxInvoice(@Param('saleNo') saleNo: string, @Body(new ZodValidationPipe(ConvertAbbBody)) b: ConvertAbbDto, @CurrentUser() u: JwtUser) {
    return this.svc.fullTaxInvoiceForSale(saleNo, b, u);
  }
}

@Controller('api/orders')
export class OrdersController {
  constructor(private readonly svc: PosService) {}

  @Patch(':orderNo/status') @Permissions('order_mgt', 'pos')
  updateStatus(
    @Param('orderNo') orderNo: string,
    @Body(new ZodValidationPipe(UpdateStatusBody)) body: { status: string; estimated_delivery?: string | null },
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.updateOrderStatus(orderNo, body.status, body.estimated_delivery ?? null, user);
  }
}
