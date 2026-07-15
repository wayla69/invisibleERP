import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SmeReviewService } from './sme-review.service';

const SignoffBody = z.object({ period: z.string().max(7).optional(), note: z.string().max(500).optional() });

// SME-02 (docs/49) — the independent-review attestation surface for the SME single-user edition. A user
// holding the `sme_review` duty (the external accountant) signs as 'accountant'; a platform owner acting-as
// the tenant signs as 'platform' (leg derived from the principal in the service, never from the body).
// Reads/writes are gated to `sme_review` (plus the compliance/exec functions that already oversee SME-01).
@Controller('api/sme-review')
export class SmeReviewController {
  constructor(private readonly svc: SmeReviewService) {}

  // Attest that this period's self-approvals were reviewed (idempotent per reviewer leg).
  @Post('signoff') @Permissions('sme_review', 'exec', 'users')
  signoff(@Body(new ZodValidationPipe(SignoffBody)) b: z.infer<typeof SignoffBody>, @CurrentUser() u: JwtUser) {
    return this.svc.signoff(u, b);
  }

  // Per-period status: reviewed count + which legs signed + which are outstanding.
  @Get('status') @Permissions('sme_review', 'exec', 'users')
  status(@Query('period') period: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.status(u, period);
  }

  // The self-approvals in a period (the evidence the reviewer signs off).
  @Get('items') @Permissions('sme_review', 'exec', 'users')
  items(@Query('period') period: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.items(u, period);
  }

  // Recent attestations (audit browse).
  @Get('signoffs') @Permissions('sme_review', 'exec', 'users')
  list(@Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.list(u, Number(limit) || 100);
  }
}
