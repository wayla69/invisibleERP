import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { WasteService, type LogWasteDto } from './waste.service';

const WasteBody = z.object({
  item_id: z.string().min(1),
  qty: z.number().positive(),
  reason_code: z.enum(['damage', 'expiry', 'spoilage', 'overproduction', 'prep_error', 'other']),
  unit_cost: z.number().nonnegative().optional(),
  uom: z.string().max(20).optional(),
  branch_id: z.number().int().optional(),
  notes: z.string().max(500).optional(),
});

// W1 — Waste / spoilage logging (kitchen + warehouse). Logging reduces the ingredient stock and, when
// costed, books Dr 5810 / Cr 1200; the food-cost lever lives in the by-reason analytics.
@Controller('api/inventory/waste')
@Permissions('warehouse', 'pos', 'order_mgt')
export class WasteController {
  constructor(private readonly svc: WasteService) {}

  @Post()
  log(@Body(new ZodValidationPipe(WasteBody)) b: LogWasteDto, @CurrentUser() u: JwtUser) {
    return this.svc.logWaste(b, u);
  }

  @Get()
  list(@Query('from') from: string | undefined, @Query('to') to: string | undefined, @Query('reason') reason: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.list({ from, to, reason }, u);
  }
}
