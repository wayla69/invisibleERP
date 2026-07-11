import { Controller, Get, Put, Post, Param, Query, Body, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CostingService } from './costing.service';
import { AtpService } from './atp.service';
import { StdCostService } from './std-cost.service';

const ConfigBody = z.object({ item_id: z.string().nullable().optional(), method: z.enum(['FIFO', 'AVG', 'STD']), standard_cost: z.number().nonnegative().nullable().optional() });
const ReviseBody = z.object({ reason: z.string().optional(), lines: z.array(z.object({ item_id: z.string().min(1), new_std: z.number().nonnegative() })).min(1) });
const CheckBody = z.object({ item_id: z.string().min(1), qty: z.number().positive(), date: z.string().min(1) });
const AllocBody = z.object({ item_id: z.string().min(1), qty: z.number().positive(), ref_doc: z.string().min(1), need_by: z.string().optional() });

@Controller('api/costing')
export class CostingController {
  constructor(private readonly costing: CostingService, private readonly atp: AtpService, private readonly stdCost: StdCostService) {}

  // ── INV-4 (COST-02) — standard-cost roll / inventory revaluation (maker-checker) ──
  // Preparer proposes a new standard per STD-costed item (snapshots on-hand); a DISTINCT approver (≠ preparer)
  // approves → rolls the stored standard + posts the balanced revaluation JE (Dr/Cr 1200 ↔ 5500).
  @Post('std-cost/revise') @Permissions('masterdata')
  revise(@Body(new ZodValidationPipe(ReviseBody)) b: any, @CurrentUser() u: JwtUser) { return this.stdCost.revise(u.tenantId as number, b, u); }
  @Get('std-cost') @Permissions('masterdata', 'exec', 'planner')
  listStd(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.stdCost.list(u.tenantId as number, status); }
  @Get('std-cost/:no') @Permissions('masterdata', 'exec', 'planner')
  stdDetail(@Param('no') no: string, @CurrentUser() u: JwtUser) { return this.stdCost.detail(u.tenantId as number, no); }
  @Post('std-cost/:no/approve') @HttpCode(200) @Permissions('exec')
  approveStd(@Param('no') no: string, @CurrentUser() u: JwtUser) { return this.stdCost.approve(u.tenantId as number, no, u); }

  @Put('config') @Permissions('masterdata')
  setMethod(@Body(new ZodValidationPipe(ConfigBody)) b: any, @CurrentUser() u: JwtUser) { return this.costing.setMethod(u.tenantId as number, b.item_id ?? null, b.method, b.standard_cost ?? null, u); }
  @Get('config') @Permissions('planner', 'procurement', 'masterdata')
  listConfig(@CurrentUser() u: JwtUser) { return this.costing.listConfig(u); }
  @Get('valuation') @Permissions('exec', 'planner')
  valuation(@CurrentUser() u: JwtUser) { return this.costing.valuation(u.tenantId as number); }

  @Get('atp') @Permissions('cust_inventory', 'planner', 'pos', 'procurement')
  atpGet(@Query('item_id') itemId: string, @Query('need_by') needBy: string, @CurrentUser() u: JwtUser) { return this.atp.atp(u.tenantId as number, itemId, needBy); }
  @Post('atp/check') @Permissions('cust_pos', 'order_cust', 'planner', 'pos')
  check(@Body(new ZodValidationPipe(CheckBody)) b: any, @CurrentUser() u: JwtUser) { return this.atp.canPromise(u.tenantId as number, b.item_id, b.qty, b.date); }
  @Post('allocate') @Permissions('cust_pos', 'planner', 'pos')
  allocate(@Body(new ZodValidationPipe(AllocBody)) b: any, @CurrentUser() u: JwtUser) { return this.atp.allocate(u.tenantId as number, b.item_id, b.qty, b.ref_doc, b.need_by, u); }
  // Reservation lifecycle (INV-09): release (order cancelled) / fulfill (goods shipped) / register.
  @Post('allocations/:refDoc/release') @HttpCode(200) @Permissions('cust_pos', 'planner', 'pos')
  release(@Param('refDoc') refDoc: string, @CurrentUser() u: JwtUser) { return this.atp.releaseAllocation(u.tenantId as number, refDoc, u); }
  @Post('allocations/:refDoc/fulfill') @HttpCode(200) @Permissions('cust_pos', 'planner', 'pos', 'warehouse')
  fulfill(@Param('refDoc') refDoc: string, @CurrentUser() u: JwtUser) { return this.atp.fulfillAllocation(u.tenantId as number, refDoc, u); }
  @Get('allocations') @Permissions('cust_inventory', 'planner', 'pos', 'procurement')
  allocations(@Query('item_id') itemId: string | undefined, @Query('status') status: string | undefined, @Query('ref_doc') refDoc: string | undefined, @CurrentUser() u: JwtUser) { return this.atp.listAllocations(u.tenantId as number, { item_id: itemId, status, ref_doc: refDoc }); }
}
