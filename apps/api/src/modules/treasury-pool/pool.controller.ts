import { Controller, Get, Post, Body, Param, Query, HttpCode, ParseIntPipe } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { PoolService } from './pool.service';

const ymdRe = /^\d{4}-\d{2}-\d{2}$/;
const acctRe = /^\d{3,10}$/;

const PoolBody = z.object({
  name: z.string().min(1),
  pool_type: z.enum(['notional', 'physical']).optional(),
  header_account: z.string().regex(acctRe),
  currency: z.string().length(3).optional(),
  members: z.array(z.object({
    member_account: z.string().regex(acctRe),
    member_tenant_id: z.number().int().positive().optional(),
    cap: z.number().min(0).optional(),
  })).optional(),
  tenant_id: z.number().int().positive().optional(),
});
const SweepBody = z.object({
  member_account: z.string().regex(acctRe),
  amount: z.number().positive(),
  date: z.string().regex(ymdRe).optional(),
});
const AllocateBody = z.object({
  allocations: z.array(z.object({ member_account: z.string().regex(acctRe).optional(), amount: z.number() })).min(1),
  date: z.string().regex(ymdRe).optional(),
});
const IcLoanBody = z.object({
  creditor_tenant_id: z.number().int().positive(),
  debtor_tenant_id: z.number().int().positive(),
  principal: z.number().positive(),
  eir_pct: z.number().min(0).max(100).optional(),
  start_date: z.string().regex(ymdRe).optional(),
  currency: z.string().length(3).optional(),
});
const AccrueBody = z.object({ as_of: z.string().regex(ymdRe).optional() });

type PoolBodyT = z.infer<typeof PoolBody>;
type SweepBodyT = z.infer<typeof SweepBody>;
type AllocateBodyT = z.infer<typeof AllocateBody>;
type IcLoanBodyT = z.infer<typeof IcLoanBody>;
type AccrueBodyT = z.infer<typeof AccrueBody>;

// Cash pooling / in-house bank / intercompany-loan register (Track C Wave 4) — TRE-05. Maker endpoints (define a
// pool, register an IC loan) gate `treasury OR exec`; sweeps/allocations/accruals + the checker approve gate
// `treasury_approve OR exec` (a treasury-manager action); reads open to either + `fin_report`. The IC-loan
// creator ≠ approver block is the SoD control (403 SOD_SELF_APPROVAL); the notional allocation MUST sum to zero
// (ALLOCATION_NOT_ZERO); and on consolidation the 1155/2155 pair + the 4700/5900 IC interest ELIMINATE (the
// control core, proven by the harness). Routes sit under /api/treasury alongside the Wave-1/2/3 registers.
@Controller('api/treasury')
export class PoolController {
  constructor(private readonly svc: PoolService) {}

  // ── Reads ──
  @Get('pools')
  @Permissions('treasury', 'treasury_approve', 'fin_report', 'exec')
  listPools() { return this.svc.listPools(); }

  @Get('pools/:id/position')
  @Permissions('treasury', 'treasury_approve', 'fin_report', 'exec')
  position(@Param('id', ParseIntPipe) id: number, @Query('as_of') asOf: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.poolPosition(id, u, asOf);
  }

  @Get('ic-loans')
  @Permissions('treasury', 'treasury_approve', 'fin_report', 'exec')
  listLoans() { return this.svc.listLoans(); }

  // ── Maker (treasury) ──
  @Post('pools')
  @HttpCode(200)
  @Permissions('treasury', 'exec')
  definePool(@Body(new ZodValidationPipe(PoolBody)) b: PoolBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.definePool({
      name: b.name, poolType: b.pool_type, headerAccount: b.header_account, currency: b.currency,
      members: (b.members ?? []).map((m) => ({ memberAccount: m.member_account, memberTenantId: m.member_tenant_id ?? null, cap: m.cap })),
      tenantId: b.tenant_id ?? null,
    }, u);
  }

  @Post('ic-loans')
  @HttpCode(200)
  @Permissions('treasury', 'exec')
  registerLoan(@Body(new ZodValidationPipe(IcLoanBody)) b: IcLoanBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.registerLoan({
      creditorTenantId: b.creditor_tenant_id, debtorTenantId: b.debtor_tenant_id, principal: b.principal,
      eirPct: b.eir_pct, startDate: b.start_date, currency: b.currency,
    }, u);
  }

  // ── Checker / treasury-manager (treasury_approve) ──
  @Post('ic-loans/:id/approve')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  approveLoan(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) { return this.svc.approveLoan(id, u); }

  @Post('ic-loans/:id/reject')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  rejectLoan(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) { return this.svc.rejectLoan(id, u); }

  @Post('ic-loans/:id/accrue')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  accrue(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(AccrueBody)) b: AccrueBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.accrue(id, u, b.as_of);
  }

  @Post('pools/:id/sweep')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  sweep(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(SweepBody)) b: SweepBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.sweep(id, { memberAccount: b.member_account, amount: b.amount, date: b.date }, u);
  }

  @Post('pools/:id/allocate-interest')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  allocate(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(AllocateBody)) b: AllocateBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.allocateInterest(id, { allocations: b.allocations.map((a) => ({ memberAccount: a.member_account, amount: a.amount })), date: b.date }, u);
  }
}
