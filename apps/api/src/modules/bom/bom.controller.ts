import { Controller, Get, Post, Patch, Delete, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  BomService, type BomMasterDto, type PushDto, type PortalBomDto, type ProductionRunDto,
} from './bom.service';

const LineSchema = z.object({
  item_id: z.string().min(1),
  item_description: z.string().optional(),
  buy_uom: z.string().optional(),
  use_uom: z.string().optional(),
  conv_factor: z.number().optional(),
  qty_use_uom: z.number().optional(),
  unit_cost: z.number().optional(),
  notes: z.string().optional(),
});
const MasterBody = z.object({
  bom_code: z.string().min(1),
  product_name: z.string().optional(),
  yield_qty: z.number().optional(),
  yield_uom: z.string().optional(),
  labor_cost: z.number().optional(),
  overhead_cost: z.number().optional(),
  other_cost: z.number().optional(),
  selling_price: z.number().optional(),
  notes: z.string().optional(),
  lines: z.array(LineSchema).optional(),
});
const PushBody = z.object({
  bom_codes: z.array(z.string()).min(1),
  tenant_codes: z.array(z.string()).min(1),
});
const PortalBomBody = MasterBody.extend({ product_item_id: z.string().optional() });
const RunBody = z.object({ batch_qty: z.number().positive().optional(), run_date: z.string().optional() });

// ───────────────────── HQ — BOM Master Library ─────────────────────
@Controller('api/bom')
export class BomController {
  constructor(private readonly svc: BomService) {}

  @Get('master') @Permissions('bom_master')
  list(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.svc.listMaster(limit ? +limit : 50, offset ? +offset : 0);
  }

  @Get('master/:bomCode') @Permissions('bom_master')
  get(@Param('bomCode') bomCode: string) { return this.svc.getMaster(bomCode); }

  @Post('master') @Permissions('bom_master')
  create(@Body(new ZodValidationPipe(MasterBody)) b: BomMasterDto, @CurrentUser() u: JwtUser) {
    return this.svc.upsertMaster(b, u);
  }

  @Patch('master/:bomCode') @Permissions('bom_master')
  update(@Param('bomCode') bomCode: string, @Body(new ZodValidationPipe(MasterBody)) b: BomMasterDto, @CurrentUser() u: JwtUser) {
    return this.svc.upsertMaster({ ...b, bom_code: bomCode }, u);
  }

  @Delete('master/:bomCode') @Permissions('bom_master')
  remove(@Param('bomCode') bomCode: string, @CurrentUser() u: JwtUser) { return this.svc.deleteMaster(bomCode, u); }

  @Post('master/push') @Permissions('bom_master')
  push(@Body(new ZodValidationPipe(PushBody)) b: PushDto, @CurrentUser() u: JwtUser) { return this.svc.pushMaster(b, u); }

  @Get('submissions') @Permissions('bom_master')
  submissions(@Query('status') status?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.svc.listSubmissions(status, limit ? +limit : 50, offset ? +offset : 0);
  }

  @Patch('submissions/:id/approve') @Permissions('bom_master')
  approve(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.approveSubmission(parseInt(id, 10), u); }
}

// ───────────────────── PORTAL — tenant BOM ─────────────────────
@Controller('api/portal/bom')
export class PortalBomController {
  constructor(private readonly svc: BomService) {}

  @Get() @Permissions('cust_bom')
  list(@CurrentUser() u: JwtUser) { return this.svc.listPortalBom(u); }

  @Post() @Permissions('cust_bom')
  create(@Body(new ZodValidationPipe(PortalBomBody)) b: PortalBomDto, @CurrentUser() u: JwtUser) {
    return this.svc.createPortalBom(b, u);
  }

  @Post(':code/production-runs') @Permissions('cust_bom')
  run(@Param('code') code: string, @Body(new ZodValidationPipe(RunBody)) b: ProductionRunDto, @CurrentUser() u: JwtUser) {
    return this.svc.createProductionRun(code, b, u);
  }
}
