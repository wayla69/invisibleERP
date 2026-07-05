import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ProgressBillingService, type CreateClaimDto } from './progress-billing.service';

const CreateBody = z.object({
  project_code: z.string().min(1),
  period: z.string().optional(),
  retention_pct: z.number().min(0).max(100).optional(),
  lines: z.array(z.object({
    boq_line_id: z.number().int().positive(),
    pct_complete_to_date: z.number().min(0).max(100),
  })).min(1),
});

// Progress billing / งวดงาน (docs/35 P1, PROJ-15). A preparer (proj_billing) raises a progress claim valuing
// work by BoQ line; an independent certifier (proj_billing_certify, ≠ preparer) certifies it — which posts the
// billing JE (AR net + retention receivable + revenue; WIP→COGS) and withholds retention into the shared
// sub-ledger. Maker-checker is enforced in the service (SOD_SELF_APPROVAL).
@Controller('api/progress-billing')
export class ProgressBillingController {
  constructor(private readonly svc: ProgressBillingService) {}

  // Raise a draft progress claim (preparer duty).
  @Post()
  @Permissions('proj_billing', 'ar', 'exec')
  create(@Body(new ZodValidationPipe(CreateBody)) b: CreateClaimDto, @CurrentUser() u: JwtUser) {
    return this.svc.createClaim(b, u);
  }

  // Certify a draft claim (certifier duty; ≠ preparer). Static segment — never collides with :claimNo below.
  @Post(':claimNo/certify')
  @Permissions('proj_billing_certify', 'gl_close', 'exec')
  certify(@Param('claimNo') claimNo: string, @CurrentUser() u: JwtUser) {
    return this.svc.certifyClaim(claimNo, u);
  }

  @Get('project/:code')
  @Permissions('proj_billing', 'proj_billing_certify', 'ar', 'exec', 'gl_close')
  listForProject(@Param('code') code: string) {
    return this.svc.listForProject(code);
  }

  @Get(':claimNo')
  @Permissions('proj_billing', 'proj_billing_certify', 'ar', 'exec', 'gl_close')
  get(@Param('claimNo') claimNo: string) {
    return this.svc.get(claimNo);
  }
}
