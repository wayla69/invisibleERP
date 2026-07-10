import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { WasteService, type LogWasteDto, type VoidFireDto } from './waste.service';

const REASONS = ['damage', 'expiry', 'spoilage', 'overproduction', 'prep_error', 'void_fire', 'other'] as const;
const DISPOSITIONS = ['discard', 'compost', 'donate', 'staff_meal', 'rework', 'return_supplier'] as const;

const WasteBody = z.object({
  item_id: z.string().min(1),
  qty: z.number().positive(),
  reason_code: z.enum(REASONS),
  disposition: z.enum(DISPOSITIONS).optional(),
  unit_cost: z.number().nonnegative().optional(),
  uom: z.string().max(20).optional(),
  branch_id: z.number().int().optional(),
  ref_doc: z.string().max(60).optional(),
  notes: z.string().max(500).optional(),
});

const VoidFireBody = z.object({
  sku: z.string().min(1),
  qty: z.number().positive(),
  reason_code: z.enum(REASONS).optional(),
  disposition: z.enum(DISPOSITIONS).optional(),
  branch_id: z.number().int().optional(),
  ref_doc: z.string().max(60).optional(),
  notes: z.string().max(500).optional(),
});

// W1 / POS-5a — Waste / spoilage ledger (kitchen + warehouse), control INV-10/INV-15. Logging reduces the
// ingredient stock and, when costed, books Dr 5810 / Cr 1200. A reason + disposition taxonomy, void-fired-item
// capture (recipe explosion) and a theoretical-vs-actual usage-variance report are the food-cost levers.
@Controller('api/inventory/waste')
@Permissions('warehouse', 'pos', 'order_mgt')
export class WasteController {
  constructor(private readonly svc: WasteService) {}

  @Post()
  log(@Body(new ZodValidationPipe(WasteBody)) b: LogWasteDto, @CurrentUser() u: JwtUser) {
    return this.svc.logWaste(b, u);
  }

  // POS-5a — a cancelled/voided fired KDS ticket line: explode the recipe to ingredient waste.
  @Post('void-fire')
  voidFire(@Body(new ZodValidationPipe(VoidFireBody)) b: VoidFireDto, @CurrentUser() u: JwtUser) {
    return this.svc.voidFire(b, u);
  }

  @Get()
  list(@Query('from') from: string | undefined, @Query('to') to: string | undefined, @Query('reason') reason: string | undefined, @Query('disposition') disposition: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.list({ from, to, reason, disposition }, u);
  }

  // POS-5a — theoretical-vs-actual usage variance (recipe COGS deduction vs actual depletion incl. waste).
  @Get('variance')
  variance(@Query('from') from: string | undefined, @Query('to') to: string | undefined, @Query('branch_id') branchId: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.usageVariance({ from, to, branch_id: branchId != null ? Number(branchId) : undefined }, u);
  }
}
