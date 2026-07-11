import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CycleCountService } from './cycle-count.service';
import { qint } from '../../common/query';

const GenerateBody = z.object({
  item_ids: z.array(z.string().min(1)).optional(),
  location: z.string().optional(),
  counted_by: z.string().optional(),
});
const CountBody = z.object({
  lines: z.array(z.object({ item_id: z.string().min(1), physical_qty: z.number() })).min(1),
});
type GenerateBodyT = z.infer<typeof GenerateBody>;
type CountBodyT = z.infer<typeof CountBody>;

// INV-3 / INV-17 — Cycle-count program with ABC classification + blind counts.
// SoD R11 (INV-04): COUNTING (wh_count) is separated from POSTING the variance (wh_adjust). Recomputing ABC
// and tuning cadence is a controller action (wh_adjust); generating/entering a blind count is a counter action
// (wh_count). Posting reuses the EXISTING /api/stocktake/:stNo/post (wh_adjust, counter ≠ poster).
@Controller('api/stock-ops')
@Permissions('wh_count', 'warehouse')
export class CycleCountController {
  constructor(private readonly svc: CycleCountService) {}

  // ── ABC classification ──
  @Post('abc/recompute')
  @Permissions('wh_adjust', 'warehouse')
  recompute(@CurrentUser() u: JwtUser) { return this.svc.recomputeAbc(u); }

  @Get('abc')
  @Permissions('wh_count', 'warehouse', 'dashboard')
  abc(@CurrentUser() u: JwtUser) { return this.svc.listAbc(u); }

  // ── Cycle-count worklist + blind tasks ──
  @Get('cycle-counts/due')
  due(@CurrentUser() u: JwtUser) { return this.svc.dueWorklist(u); }

  @Get('cycle-counts')
  list(@Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listTasks(u, qint('limit', limit, 100)); }

  @Post('cycle-counts')
  generate(@Body(new ZodValidationPipe(GenerateBody)) b: GenerateBodyT, @CurrentUser() u: JwtUser) { return this.svc.generateTask(b, u); }

  @Post('cycle-counts/:taskNo/count')
  count(@Param('taskNo') no: string, @Body(new ZodValidationPipe(CountBody)) b: CountBodyT, @CurrentUser() u: JwtUser) { return this.svc.submitCount(no, b, u); }
}
