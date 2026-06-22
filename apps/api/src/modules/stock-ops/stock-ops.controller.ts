import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { StockOpsService } from './stock-ops.service';

const Line = z.object({ item_id: z.string().min(1), item_description: z.string().optional(), uom: z.string().optional() });
const StocktakeBody = z.object({
  counted_by: z.string().optional(),
  remarks: z.string().optional(),
  lines: z.array(Line.extend({ system_qty: z.number().optional(), physical_qty: z.number() })).min(1),
});
const IssueBody = z.object({
  ref_doc: z.string().optional(),
  from_location: z.string().optional(),
  remarks: z.string().optional(),
  lines: z.array(Line.extend({ qty: z.number().positive() })).min(1),
});
const TransferBody = z.object({
  ref_doc: z.string().optional(),
  from_location: z.string().min(1),
  to_location: z.string().min(1),
  remarks: z.string().optional(),
  lines: z.array(Line.extend({ qty: z.number().positive() })).min(1),
});
type StocktakeBodyT = z.infer<typeof StocktakeBody>;
type IssueBodyT = z.infer<typeof IssueBody>;
type TransferBodyT = z.infer<typeof TransferBody>;

// Stocktake / cycle-count documents. SoD R11: COUNTING (wh_count) is separated from POSTING the variance
// adjustment (wh_adjust) — a counter records the count; an inventory controller approves/posts the
// adjustment. Legacy 'warehouse' holders still pass (it implies wh_count + wh_adjust).
@Controller('api/stocktake')
@Permissions('wh_count', 'mobile')
export class StocktakeController {
  constructor(private readonly svc: StockOpsService) {}

  @Post() create(@Body(new ZodValidationPipe(StocktakeBody)) b: StocktakeBodyT, @CurrentUser() u: JwtUser) { return this.svc.createStocktake(b, u); }
  @Get() list(@Query('limit') limit?: string) { return this.svc.listStocktakes(limit ? +limit : 50); }
  @Get(':stNo') detail(@Param('stNo') no: string) { return this.svc.getStocktake(no); }
  @Post(':stNo/post')
  @Permissions('wh_adjust')
  post(@Param('stNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.postStocktake(no, u); }
}

// Manual goods issue / inter-location transfer + movement history (custody movement: wh_custody).
@Controller('api/inventory')
@Permissions('wh_custody', 'mobile')
export class StockMovementController {
  constructor(private readonly svc: StockOpsService) {}

  @Post('issue') issue(@Body(new ZodValidationPipe(IssueBody)) b: IssueBodyT, @CurrentUser() u: JwtUser) { return this.svc.goodsIssue(b, u); }
  @Post('transfer') transfer(@Body(new ZodValidationPipe(TransferBody)) b: TransferBodyT, @CurrentUser() u: JwtUser) { return this.svc.transfer(b, u); }

  @Get('movements')
  @Permissions('wh_custody', 'dashboard')
  movements(@Query('move_type') moveType?: string, @Query('limit') limit?: string) {
    return this.svc.listMovements({ move_type: moveType, limit: limit ? +limit : 100 });
  }
}
