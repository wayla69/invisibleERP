import { Controller, Get, Post, Body, Param, Query, ParseIntPipe, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { CapaService } from './capa.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

// QMS-2 — CAPA lifecycle + QC-02 effectiveness sign-off. Endpoints under /api/quality/capa.
//   Reads   → quality | quality_approve | exec
//   Create / own / actions / submit → quality | exec (the CAPA-owner duty)
//   Verify / reject → quality_approve | exec (the INDEPENDENT verifier duty)
// The requester≠verifier rule (QC-02) is enforced in the service (verified_by ≠ owner/created_by), so the
// control binds regardless of the permission held.
const CreateBody = z.object({
  title: z.string().min(1),
  problem_statement: z.string().optional(),
  root_cause: z.string().optional(),
  action_type: z.enum(['corrective', 'preventive', 'both']).optional(),
  owner: z.string().optional(),
  target_date: z.string().optional(),
  source_type: z.enum(['ncr', 'gr_claim', 'complaint', 'audit', 'manual']).optional(),
  source_ref: z.string().optional(),
});
const ActionBody = z.object({ description: z.string().min(1), owner: z.string().optional(), due_date: z.string().optional() });
const VerifyBody = z.object({ result: z.enum(['effective', 'ineffective']), note: z.string().optional(), self_approval_reason: z.string().max(500).optional() });
// reason is validated in the service (REASON_REQUIRED with a Thai message) rather than at the Zod layer, so
// the documented QC-02 error code surfaces on an empty/whitespace reason.
const ReasonBody = z.object({ reason: z.string().optional(), self_approval_reason: z.string().max(500).optional() });
const CancelBody = z.object({ reason: z.string().optional() });

@Controller('api/quality/capa')
export class CapaController {
  constructor(private readonly svc: CapaService) {}

  @Get()
  @Permissions('quality', 'quality_approve', 'exec')
  list(@Query('status') status: string | undefined, @CurrentUser() user: JwtUser) { return this.svc.listCapas(user, status); }

  // Detective read — declared BEFORE the parametric /:id route.
  @Get('overdue')
  @Permissions('quality', 'quality_approve', 'exec')
  overdue(@Query('days') days: string | undefined, @CurrentUser() user: JwtUser) { return this.svc.overdue(Number(days ?? 0), user); }

  @Get(':id')
  @Permissions('quality', 'quality_approve', 'exec')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.getCapa(id, user); }

  @Post()
  @Permissions('quality', 'exec')
  create(@Body(new ZodValidationPipe(CreateBody)) dto: z.infer<typeof CreateBody>, @CurrentUser() user: JwtUser) { return this.svc.createCapa(dto, user); }

  @Post(':id/actions')
  @Permissions('quality', 'exec')
  addAction(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(ActionBody)) dto: z.infer<typeof ActionBody>, @CurrentUser() user: JwtUser) { return this.svc.addAction(id, dto, user); }

  @Post(':id/actions/:actionId/complete')
  @Permissions('quality', 'exec')
  @HttpCode(200)
  completeAction(@Param('id', ParseIntPipe) id: number, @Param('actionId', ParseIntPipe) actionId: number, @CurrentUser() user: JwtUser) { return this.svc.completeAction(id, actionId, user); }

  @Post(':id/submit')
  @Permissions('quality', 'exec')
  @HttpCode(200)
  submit(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.submit(id, user); }

  @Post(':id/verify')
  @Permissions('quality_approve', 'exec')
  @HttpCode(200)
  verify(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(VerifyBody)) dto: z.infer<typeof VerifyBody>, @CurrentUser() user: JwtUser) { return this.svc.verify(id, dto, user); }

  @Post(':id/reject')
  @Permissions('quality_approve', 'exec')
  @HttpCode(200)
  reject(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(ReasonBody)) dto: z.infer<typeof ReasonBody>, @CurrentUser() user: JwtUser) { return this.svc.reject(id, dto, user); }

  @Post(':id/cancel')
  @Permissions('quality', 'exec')
  @HttpCode(200)
  cancel(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(CancelBody)) dto: z.infer<typeof CancelBody>, @CurrentUser() user: JwtUser) { return this.svc.cancel(id, dto, user); }
}
