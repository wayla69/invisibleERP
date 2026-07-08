import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { PdpaService } from './pdpa.service';

const CreateDsarBody = z.object({
  subject_type: z.enum(['member', 'customer', 'employee', 'user']),
  subject_ref: z.string().min(1),
  request_type: z.enum(['access', 'rectification', 'erasure', 'portability', 'objection']),
  details: z.string().optional(),
});
const RejectBody = z.object({ reason: z.string().optional() });
const strArr = z.array(z.string()).optional();
const RopaBody = z.object({
  name: z.string().min(1),
  purpose: z.string().min(1),
  legal_basis: z.enum(['consent', 'contract', 'legal_obligation', 'legitimate_interest', 'vital_interest', 'public_task']),
  data_categories: strArr, data_subjects: strArr, recipients: strArr, sub_processors: strArr,
  retention_period: z.string().nullable().optional(), cross_border: z.string().nullable().optional(), security_measures: z.string().nullable().optional(),
});
const RopaPatchBody = RopaBody.partial().extend({ active: z.boolean().optional() });

// PDPA (Thailand) data-protection-officer console. Gated by `users` — the same access-administration /
// audit-review duty that owns the access review and audit viewer (a DPO/AccessAdmin function), so no new
// permission or SoD-matrix change is introduced. Tenant-scoped by RLS.
@Controller('api/pdpa')
@Permissions('users')
export class PdpaController {
  constructor(private readonly pdpa: PdpaService) {}

  @Post('dsar')
  create(@Body(new ZodValidationPipe(CreateDsarBody)) b: z.infer<typeof CreateDsarBody>, @CurrentUser() u: JwtUser) {
    return this.pdpa.createDsar(b, u);
  }

  @Get('dsar')
  list(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.pdpa.listDsar(status, u); }

  @Get('dsar/:id')
  get(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.pdpa.getDsar(+id, u); }

  // Access / portability — assemble + return the subject's data bundle and close the request.
  @Post('dsar/:id/export')
  exportData(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.pdpa.exportSubject(+id, u); }

  // Erasure — redact PII + record the pseudonymisation ledger that masks the immutable audit trail.
  @Post('dsar/:id/erase')
  erase(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.pdpa.eraseSubject(+id, u); }

  @Post('dsar/:id/reject')
  reject(@Param('id') id: string, @Body(new ZodValidationPipe(RejectBody)) b: z.infer<typeof RejectBody>, @CurrentUser() u: JwtUser) {
    return this.pdpa.rejectDsar(+id, b.reason, u);
  }

  // ── RoPA — Records of Processing Activities (PDPA-03, มาตรา 39 / GDPR Art.30) ──
  @Get('ropa')
  listRopa(@Query('active') active: string | undefined, @CurrentUser() u: JwtUser) { return this.pdpa.listRopa(u, active === '1' || active === 'true'); }

  @Get('ropa/:id')
  getRopa(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.pdpa.getRopa(+id, u); }

  @Post('ropa')
  createRopa(@Body(new ZodValidationPipe(RopaBody)) b: z.infer<typeof RopaBody>, @CurrentUser() u: JwtUser) { return this.pdpa.createRopa(b, u); }

  @Post('ropa/:id')
  updateRopa(@Param('id') id: string, @Body(new ZodValidationPipe(RopaPatchBody)) b: z.infer<typeof RopaPatchBody>, @CurrentUser() u: JwtUser) { return this.pdpa.updateRopa(+id, b, u); }
}
