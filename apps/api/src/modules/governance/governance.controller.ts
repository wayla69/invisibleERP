import { Controller, Get, Post, Patch, Body, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { GovernanceService } from './governance.service';

const AckBody = z.object({ policy_version: z.string().min(1) });
const CaseBody = z.object({ allegation: z.string().min(1), category: z.string().optional(), anonymous: z.boolean().optional() });
const CaseUpdateBody = z.object({ status: z.enum(['received', 'investigating', 'resolved', 'dismissed']), resolution_note: z.string().optional() });

// Entity-level governance (ELC-01 ethics acknowledgement, ELC-04 whistleblower hotline). Self-service
// endpoints (acknowledge / file a report) are open to any authenticated staff (owner-scoped, no @Permissions);
// the register + case-log + case-management views are gated to the compliance/admin function (`users`).
@Controller('api/governance')
export class GovernanceController {
  constructor(private readonly svc: GovernanceService) {}

  // ELC-01 — any authenticated staff acknowledges the current code-of-conduct version (idempotent).
  @Post('ethics/acknowledge')
  acknowledge(@Body(new ZodValidationPipe(AckBody)) b: z.infer<typeof AckBody>, @CurrentUser() u: JwtUser) {
    return this.svc.acknowledgeEthics(u, b.policy_version);
  }

  // ELC-01 — compliance/admin views the acknowledgement register.
  @Get('ethics/register') @Permissions('users')
  register(@Query('policy_version') pv?: string) {
    return this.svc.ethicsRegister(pv);
  }

  // ELC-04 — any authenticated staff files an (optionally anonymous) whistleblower report.
  @Post('hotline/cases')
  fileCase(@Body(new ZodValidationPipe(CaseBody)) b: z.infer<typeof CaseBody>, @CurrentUser() u: JwtUser) {
    return this.svc.fileCase(u, b);
  }

  // ELC-04 — audit committee / compliance reviews the case log.
  @Get('hotline/cases') @Permissions('users')
  cases(@Query('status') status?: string) {
    return this.svc.listCases(status);
  }

  // ELC-04 — advance a case (status + resolution note).
  @Patch('hotline/cases/:ref') @Permissions('users')
  updateCase(@Param('ref') ref: string, @Body(new ZodValidationPipe(CaseUpdateBody)) b: z.infer<typeof CaseUpdateBody>, @CurrentUser() u: JwtUser) {
    return this.svc.updateCase(ref, b, u);
  }
}
