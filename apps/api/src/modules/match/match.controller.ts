import { Controller, Get, Post, Put, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ThreeWayMatchService } from './three-way-match.service';
import { qint } from '../../common/query';

const MatchRunBody = z.object({
  txn_no: z.string().min(1), po_no: z.string().optional(),
  lines: z.array(z.object({ item_id: z.string().min(1), qty: z.number(), unit_price: z.number().nonnegative() })).optional(),
});
const ToleranceBody = z.object({ qty_pct: z.number().min(0).optional(), price_pct: z.number().min(0).optional(), amount_pct: z.number().min(0).optional(), amount_abs: z.number().min(0).optional() });
const OverrideBody = z.object({ reason: z.string().min(1), self_approval_reason: z.string().max(500).optional() });

@Controller('api/procurement/match')
export class MatchController {
  constructor(private readonly svc: ThreeWayMatchService) {}

  @Post('run') @Permissions('procurement', 'creditors')
  run(@Body(new ZodValidationPipe(MatchRunBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.match(b.txn_no, b.po_no, b.lines, u); }

  @Get('tolerance') @Permissions('procurement', 'creditors')
  getTolerance() { return this.svc.getTolerance(); }
  @Put('tolerance') @Permissions('creditors')
  setTolerance(@Body(new ZodValidationPipe(ToleranceBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.setTolerance(b, u); }

  // Match-results register / blocked-invoice worklist (use ?blocked=true for held-from-payment only).
  @Get() @Permissions('procurement', 'creditors')
  list(@CurrentUser() u: JwtUser, @Query('status') status?: string, @Query('blocked') blocked?: string, @Query('search') search?: string, @Query('limit') limit?: string) {
    return this.svc.listResults({ status, blocked: blocked === 'true' || blocked === '1', search, limit: qint('limit', limit, 100) }, u);
  }

  @Get(':txnNo') @Permissions('procurement', 'creditors')
  getMatch(@Param('txnNo') txnNo: string) { return this.svc.getMatch(txnNo); }
  // EXP-01 override is maker-checked in the service (overrider ≠ matcher, binds Admin). Allow approval-authority
  // roles (controller/approvals) as well as creditors — an override is a checker action, not a clerk's.
  @Post(':txnNo/override') @Permissions('creditors', 'approvals', 'gl_close')
  override(@Param('txnNo') txnNo: string, @Body(new ZodValidationPipe(OverrideBody)) b: { reason: string; self_approval_reason?: string }, @CurrentUser() u: JwtUser) { return this.svc.override(txnNo, b.reason, u, b.self_approval_reason); }
}
