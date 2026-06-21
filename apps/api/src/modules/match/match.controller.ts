import { Controller, Get, Post, Put, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ThreeWayMatchService } from './three-way-match.service';

const MatchRunBody = z.object({
  txn_no: z.string().min(1), po_no: z.string().optional(),
  lines: z.array(z.object({ item_id: z.string().min(1), qty: z.number(), unit_price: z.number().nonnegative() })).optional(),
});
const ToleranceBody = z.object({ qty_pct: z.number().min(0).optional(), price_pct: z.number().min(0).optional(), amount_pct: z.number().min(0).optional(), amount_abs: z.number().min(0).optional() });
const OverrideBody = z.object({ reason: z.string().min(1) });

@Controller('api/procurement/match')
export class MatchController {
  constructor(private readonly svc: ThreeWayMatchService) {}

  @Post('run') @Permissions('procurement', 'creditors')
  run(@Body(new ZodValidationPipe(MatchRunBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.match(b.txn_no, b.po_no, b.lines, u); }

  @Get('tolerance') @Permissions('procurement', 'creditors')
  getTolerance() { return this.svc.getTolerance(); }
  @Put('tolerance') @Permissions('creditors')
  setTolerance(@Body(new ZodValidationPipe(ToleranceBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.setTolerance(b, u); }

  @Get(':txnNo') @Permissions('procurement', 'creditors')
  getMatch(@Param('txnNo') txnNo: string) { return this.svc.getMatch(txnNo); }
  @Post(':txnNo/override') @Permissions('creditors')
  override(@Param('txnNo') txnNo: string, @Body(new ZodValidationPipe(OverrideBody)) b: { reason: string }, @CurrentUser() u: JwtUser) { return this.svc.override(txnNo, b.reason, u); }
}
