import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ProcurementService, type CreatePrDto, type CreatePoDto, type CreateGrDto, type UpsertSupplierPriceDto } from './procurement.service';

const PrBody = z.object({
  remarks: z.string().optional(), priority: z.string().optional(),
  amount: z.number().nonnegative().optional(), // estimated value → drives approval-threshold routing
  items: z.array(z.object({ item_id: z.string().min(1), item_description: z.string().optional(), request_qty: z.number().positive(), uom: z.string().optional(), required_date: z.string().optional(), reason: z.string().optional() })).min(1),
});
const PoBody = z.object({
  vendor_id: z.number().optional(), vendor_name: z.string().optional(), expected_date: z.string().optional(), remarks: z.string().optional(),
  items: z.array(z.object({ item_id: z.string().min(1), item_description: z.string().optional(), order_qty: z.number().positive(), unit_price: z.number().nonnegative(), uom: z.string().optional(), is_capital: z.boolean().optional() })).min(1),
});
const GrBody = z.object({
  po_no: z.string().min(1), remarks: z.string().optional(),
  items: z.array(z.object({ item_id: z.string().min(1), received_qty: z.number().positive(), lot_no: z.string().optional(), expiry_date: z.string().optional(), unit_cost: z.number().optional(), uom: z.string().optional() })).min(1),
});
const ApproveBody = z.object({ approve: z.boolean().default(true), reason: z.string().optional() });
const CancelBody = z.object({ reason: z.string().min(1) });
const SupplierStatusBody = z.object({ approval_status: z.enum(['approved', 'pending', 'blocked']).optional(), blocklisted: z.boolean().optional(), reason: z.string().optional() });
const ScorecardBody = z.object({ period: z.string().min(1) });
// T2-D: Supplier price-list versioning — create/version a purchase price; list active; history.
const SupplierPriceBody = z.object({
  vendor_id: z.number().int().positive(),
  item_id: z.string().min(1),
  item_description: z.string().optional(),
  uom: z.string().optional(),
  currency: z.string().optional(),
  unit_price: z.number().positive(),
  min_qty: z.number().positive().optional(),
  effective_from: z.string().min(1), // YYYY-MM-DD
  effective_to: z.string().optional(),
  notes: z.string().optional(),
});

@Controller('api/procurement')
export class ProcurementController {
  constructor(private readonly svc: ProcurementService) {}

  @Post('prs') @Permissions('procurement', 'planner')
  createPr(@Body(new ZodValidationPipe(PrBody)) b: CreatePrDto, @CurrentUser() u: JwtUser) { return this.svc.createPr(b, u); }

  @Patch('prs/:prNo/approve') @Permissions('procurement')
  approvePr(@Param('prNo') prNo: string, @Body(new ZodValidationPipe(ApproveBody)) b: { approve: boolean }, @CurrentUser() u: JwtUser) {
    return this.svc.approvePr(prNo, b.approve, u);
  }

  // ── supplier screening (Phase 16) ── vendor-master duty = md_vendor (segregated from AP payment).
  // Legacy 'masterdata' holders still pass (it implies md_vendor/md_item/md_config).
  @Patch('suppliers/:id/status') @Permissions('md_vendor')
  setSupplierStatus(@Param('id') id: string, @Body(new ZodValidationPipe(SupplierStatusBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.setSupplierStatus(+id, b, u); }
  @Post('suppliers/:id/scorecard') @Permissions('procurement')
  scorecard(@Param('id') id: string, @Body(new ZodValidationPipe(ScorecardBody)) b: { period: string }, @CurrentUser() u: JwtUser) { return this.svc.recomputeScorecard(+id, b.period, u); }

  // Supplier-performance register — scorecards ranked by score (with ?period; default = latest per vendor).
  @Get('scorecards') @Permissions('procurement', 'exec')
  scorecards(@CurrentUser() u: JwtUser, @Query('period') period?: string, @Query('limit') limit?: string) {
    return this.svc.listScorecards({ period, limit: limit ? Math.min(Number(limit) || 200, 500) : 200 }, u);
  }

  // T2-D: Supplier price-list versioning. md_vendor creates/versions prices; procurement/planner/exec view.
  // SoD: price maintenance (md_vendor) is segregated from buying (procurement) and paying (creditors).
  @Post('supplier-prices') @Permissions('md_vendor', 'procurement')
  upsertSupplierPrice(@Body(new ZodValidationPipe(SupplierPriceBody)) b: UpsertSupplierPriceDto, @CurrentUser() u: JwtUser) {
    return this.svc.upsertSupplierPrice(b, u);
  }
  @Get('supplier-prices') @Permissions('procurement', 'planner', 'exec')
  listSupplierPrices(@CurrentUser() u: JwtUser, @Query('vendor_id') vendorId?: string, @Query('item_id') itemId?: string) {
    return this.svc.listSupplierPrices({ vendor_id: vendorId ? Number(vendorId) : undefined, item_id: itemId }, u);
  }
  @Get('supplier-prices/history') @Permissions('procurement', 'planner')
  supplierPriceHistory(@CurrentUser() u: JwtUser, @Query('vendor_id') vendorId: string, @Query('item_id') itemId: string) {
    return this.svc.supplierPriceHistory(Number(vendorId), itemId, u);
  }

  @Post('pos') @Permissions('procurement')
  createPo(@Body(new ZodValidationPipe(PoBody)) b: CreatePoDto, @CurrentUser() u: JwtUser) { return this.svc.createPo(b, u); }

  @Patch('pos/:poNo/approve') @Permissions('procurement')
  approvePo(@Param('poNo') poNo: string, @Body(new ZodValidationPipe(ApproveBody)) b: { approve: boolean; reason?: string }, @CurrentUser() u: JwtUser) {
    return this.svc.approvePo(poNo, b.approve, b.reason, u);
  }

  @Patch('pos/:poNo/cancel') @Permissions('procurement')
  cancelPo(@Param('poNo') poNo: string, @Body(new ZodValidationPipe(CancelBody)) b: { reason: string }, @CurrentUser() u: JwtUser) {
    return this.svc.cancelPo(poNo, b.reason, u);
  }

  @Post('grs') @Permissions('procurement', 'warehouse')
  createGr(@Body(new ZodValidationPipe(GrBody)) b: CreateGrDto, @CurrentUser() u: JwtUser) { return this.svc.createGr(b, u); }
}
