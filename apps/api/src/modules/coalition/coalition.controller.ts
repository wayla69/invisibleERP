import { Controller, Get, Post, Delete, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, NoTx, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CoalitionService } from './coalition.service';

const CreateCoalitionBody = z.object({ code: z.string().min(1).max(20), name: z.string().min(1) });
const AddMemberBody = z.object({ tenant_id: z.number().int().positive() });
const EarnBody = z.object({ member_id: z.number().int().positive(), net_spend: z.number().positive().max(10_000_000), ref_doc: z.string().max(60).optional() });
const RedeemBody = z.object({ member_id: z.number().int().positive(), points: z.number().int().positive(), ref_doc: z.string().max(60).optional() });

// W2 (docs/27) — coalition network (LYL-19). Config is HQ-only (users/exec + the Admin-role guard in the
// service); the till-facing resolve/earn/redeem routes are staff-permission gated and run @NoTx: the
// service opens its OWN validated bypass transaction (runInTenantContext) for the cross-shop work — a
// nested per-request tx would leak the bypass GUC into the rest of the request.
@Controller('api/coalition')
export class CoalitionController {
  constructor(private readonly svc: CoalitionService) {}

  // ── HQ configuration ──
  @Get() @Permissions('users', 'exec', 'loyalty')
  list(@CurrentUser() u: JwtUser) { return this.svc.list(u); }
  @Post() @Permissions('users', 'exec')
  create(@Body(new ZodValidationPipe(CreateCoalitionBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.createCoalition(b, u); }
  @Post(':id/members') @Permissions('users', 'exec')
  addMember(@Param('id') id: string, @Body(new ZodValidationPipe(AddMemberBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.addMember(+id, b, u); }
  @Delete(':id/members/:tenantId') @Permissions('users', 'exec')
  removeMember(@Param('id') id: string, @Param('tenantId') tenantId: string, @CurrentUser() u: JwtUser) { return this.svc.removeMember(+id, +tenantId, u); }

  // ── Partner till (shop staff) ──
  @Get('resolve') @NoTx() @Permissions('loyalty', 'pos')
  resolve(@Query('phone') phone: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.resolve(u, phone ?? ''); }
  @Post('earn') @NoTx() @Permissions('loyalty', 'pos')
  earn(@Body(new ZodValidationPipe(EarnBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.earn(u, b); }
  @Post('redeem') @NoTx() @Permissions('loyalty', 'pos')
  redeem(@Body(new ZodValidationPipe(RedeemBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.redeem(u, b); }
}
