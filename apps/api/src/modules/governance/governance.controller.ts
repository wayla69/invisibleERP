import { Controller, Get, Post, Patch, Body, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { GovernanceService } from './governance.service';

const AckBody = z.object({ policy_version: z.string().min(1) });
const CaseBody = z.object({ allegation: z.string().min(1), category: z.string().optional(), anonymous: z.boolean().optional() });
const CaseUpdateBody = z.object({ status: z.enum(['received', 'investigating', 'resolved', 'dismissed']), resolution_note: z.string().optional() });
const DoaBody = z.object({ authority_area: z.string().min(1), role: z.string().min(1), approval_limit: z.number().nullable().optional(), currency: z.string().optional(), notes: z.string().optional(), effective_from: z.string().optional() });
const RiskBody = z.object({ area: z.string().min(1), description: z.string().min(1), likelihood: z.enum(['low', 'medium', 'high']).optional(), impact: z.enum(['low', 'medium', 'high']).optional(), mitigating_controls: z.string().optional(), owner: z.string().optional() });
const RiskReviewBody = z.object({ status: z.enum(['open', 'mitigated', 'accepted', 'closed']), mitigating_controls: z.string().optional(), owner: z.string().optional() });
const OversightBody = z.object({ meeting_date: z.string().min(1), kind: z.string().optional(), topics: z.string().optional(), icfr_reviewed: z.boolean().optional(), findings_reviewed: z.string().optional(), attendees: z.string().optional(), minutes_ref: z.string().optional(), signed_off_by: z.string().optional() });

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

  // ELC-03 — Delegation-of-Authority matrix (compliance/admin).
  @Post('doa') @Permissions('users')
  setAuthority(@Body(new ZodValidationPipe(DoaBody)) b: z.infer<typeof DoaBody>, @CurrentUser() u: JwtUser) { return this.svc.setAuthority(u, b); }
  @Get('doa') @Permissions('users')
  listAuthority() { return this.svc.listAuthority(); }

  // ELC-05 — Fraud-risk register (compliance/risk owner).
  @Post('fraud-risks') @Permissions('users')
  fileFraudRisk(@Body(new ZodValidationPipe(RiskBody)) b: z.infer<typeof RiskBody>, @CurrentUser() u: JwtUser) { return this.svc.fileFraudRisk(u, b); }
  @Get('fraud-risks') @Permissions('users')
  fraudRisks(@Query('status') status?: string) { return this.svc.listFraudRisks(status); }
  @Patch('fraud-risks/:ref') @Permissions('users')
  reviewFraudRisk(@Param('ref') ref: string, @Body(new ZodValidationPipe(RiskReviewBody)) b: z.infer<typeof RiskReviewBody>, @CurrentUser() u: JwtUser) { return this.svc.reviewFraudRisk(ref, b, u); }

  // ELC-02 — Audit-committee / governance oversight log.
  @Post('oversight') @Permissions('users')
  recordOversight(@Body(new ZodValidationPipe(OversightBody)) b: z.infer<typeof OversightBody>, @CurrentUser() u: JwtUser) { return this.svc.recordOversight(u, b); }
  @Get('oversight') @Permissions('users')
  oversight() { return this.svc.listOversight(); }
}
