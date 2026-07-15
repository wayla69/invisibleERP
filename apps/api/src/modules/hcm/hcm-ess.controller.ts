import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { RequiresSuite } from '../billing/requires-suite.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { HcmEssService, type ProfileChangeDto, type DocumentDto } from './hcm-ess.service';

const ProfileChangeBody = z.object({
  field: z.enum(['name', 'national_id', 'bank_account', 'tax_id', 'phone', 'address', 'emergency_contact']),
  new_value: z.string().min(1),
  reason: z.string().optional(),
});
const DocumentBody = z.object({
  doc_type: z.enum(['contract', 'id_card', 'certificate', 'tax_form', 'other']),
  title: z.string().min(1),
  file_ref: z.string().optional(),
  visibility: z.enum(['private', 'hr']).optional(),
  emp_code: z.string().optional(), // HR-only: upload on behalf of an employee
});
const RejectBody = z.object({ reason: z.string().optional() });

// HR-8 (docs/42, Wave 3) — Employee Self-Service (ESS) depth. An employee (`ess`) creates profile-change
// requests and reads/uploads their OWN documents (own-scoped by emp_code in the service). Sensitive-field
// changes are parked pending; hr/hr_admin approve (control HR-08 maker-checker — SOD_SELF_APPROVAL blocks a
// self-approval). Reads gate ess/hr/hr_admin/exec; approvals gate hr/hr_admin.
@Controller('api/hcm/ess')
@RequiresSuite('hcm')
export class HcmEssController {
  constructor(private readonly svc: HcmEssService) {}

  // ── Profile-change requests (HR-08) ──
  @Get('profile-requests')
  @Permissions('ess', 'hr', 'hr_admin', 'exec')
  listRequests(@Query('status') status: string | undefined, @Query('emp_code') emp: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.listRequests(status, emp, u);
  }

  @Post('profile-requests')
  @Permissions('ess', 'hr', 'hr_admin')
  createRequest(@Body(new ZodValidationPipe(ProfileChangeBody)) b: ProfileChangeDto, @CurrentUser() u: JwtUser) {
    return this.svc.createRequest(b, u);
  }

  // HR-08 — the approver must differ from the requester (SOD_SELF_APPROVAL).
  // (an 'sme' tenant may self-approve WITH self_approval_reason — docs/49, SME-01.)
  @Post('profile-requests/:id/approve')
  @Permissions('hr', 'hr_admin')
  approveRequest(@Param('id') id: string, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) {
    return this.svc.approveRequest(Number(id), u, b?.self_approval_reason);
  }

  @Post('profile-requests/:id/reject')
  @Permissions('hr', 'hr_admin')
  rejectRequest(@Param('id') id: string, @Body(new ZodValidationPipe(RejectBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) {
    return this.svc.rejectRequest(Number(id), b.reason, u);
  }

  // ── Personal documents (own-scoped) ──
  @Get('documents')
  @Permissions('ess', 'hr', 'hr_admin', 'exec')
  listDocuments(@Query('emp_code') emp: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.listDocuments(emp, u);
  }

  @Post('documents')
  @Permissions('ess', 'hr', 'hr_admin')
  uploadDocument(@Body(new ZodValidationPipe(DocumentBody)) b: DocumentDto, @CurrentUser() u: JwtUser) {
    return this.svc.uploadDocument(b, u);
  }

  // ── Team directory (derived read) ──
  @Get('team')
  @Permissions('ess', 'hr', 'hr_admin', 'exec')
  teamDirectory(@CurrentUser() u: JwtUser) {
    return this.svc.teamDirectory(u);
  }
}
