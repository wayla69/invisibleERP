import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { RequiresSuite } from '../billing/requires-suite.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  HcmRecruitingService,
  type RequisitionDto, type CandidateDto, type ApplicationDto, type StageDto, type OfferDto,
} from './hcm-recruiting.service';

const RequisitionBody = z.object({
  req_no: z.string().optional(), position_code: z.string().optional(), dept_id: z.number().int().positive().optional(),
  headcount: z.number().int().positive().optional(), justification: z.string().optional(),
});
const CandidateBody = z.object({
  cand_no: z.string().optional(), name: z.string().min(1), email: z.string().optional(), phone: z.string().optional(),
  source: z.string().optional(), resume_url: z.string().optional(),
});
const ApplicationBody = z.object({
  req_no: z.string().min(1), cand_no: z.string().min(1),
  stage: z.enum(['applied', 'screen', 'interview', 'offer', 'hired', 'rejected']).optional(),
  rating: z.number().optional(), notes: z.string().optional(),
});
const StageBody = z.object({
  stage: z.enum(['applied', 'screen', 'interview', 'offer', 'hired', 'rejected']),
  rating: z.number().optional(), notes: z.string().optional(),
});
const OfferBody = z.object({
  application_id: z.number().int().positive(), offered_salary: z.number().nonnegative().optional(),
  offered_grade: z.string().optional(), start_date: z.string().optional(),
});

// HR-4 (docs/42, Wave 2) — Recruiting / ATS. Reads gate hr/hr_admin/exec; writes hr/hr_admin; approvals
// (requisition + offer) hr_admin/exec. Control HR-04 (maker-checker requisition approval + offer authorization
// + headcount-bound hiring) is enforced in the service.
@Controller('api/hcm/recruiting')
@Permissions('hr', 'hr_admin', 'exec')
@RequiresSuite('hcm')
export class HcmRecruitingController {
  constructor(private readonly svc: HcmRecruitingService) {}

  // ── Requisitions ──
  @Get('requisitions')
  listRequisitions(@CurrentUser() u: JwtUser) { return this.svc.listRequisitions(u); }

  @Post('requisitions')
  @Permissions('hr', 'hr_admin')
  createRequisition(@Body(new ZodValidationPipe(RequisitionBody)) b: RequisitionDto, @CurrentUser() u: JwtUser) { return this.svc.createRequisition(b, u); }

  // HR-04 — the approver must differ from the requester (SOD_SELF_APPROVAL).
  @Post('requisitions/:reqNo/approve')
  @Permissions('hr_admin', 'exec')
  approveRequisition(@Param('reqNo') reqNo: string, @CurrentUser() u: JwtUser) { return this.svc.approveRequisition(reqNo, u); }

  @Post('requisitions/:reqNo/reject')
  @Permissions('hr_admin', 'exec')
  rejectRequisition(@Param('reqNo') reqNo: string, @CurrentUser() u: JwtUser) { return this.svc.rejectRequisition(reqNo, u); }

  // ── Candidates ──
  @Get('candidates')
  listCandidates(@CurrentUser() u: JwtUser) { return this.svc.listCandidates(u); }

  @Post('candidates')
  @Permissions('hr', 'hr_admin')
  createCandidate(@Body(new ZodValidationPipe(CandidateBody)) b: CandidateDto, @CurrentUser() u: JwtUser) { return this.svc.createCandidate(b, u); }

  // ── Applications (pipeline) ──
  @Get('applications')
  listApplications(@Query('req_no') reqNo: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listApplications(reqNo, u); }

  @Post('applications')
  @Permissions('hr', 'hr_admin')
  createApplication(@Body(new ZodValidationPipe(ApplicationBody)) b: ApplicationDto, @CurrentUser() u: JwtUser) { return this.svc.createApplication(b, u); }

  // HR-04 — advancing to offer/hired requires an approved requisition (REQUISITION_NOT_APPROVED); a hire is
  // headcount-bound (HEADCOUNT_EXCEEDED).
  @Patch('applications/:id/stage')
  @Permissions('hr', 'hr_admin')
  advanceStage(@Param('id') id: string, @Body(new ZodValidationPipe(StageBody)) b: StageDto, @CurrentUser() u: JwtUser) { return this.svc.advanceStage(Number(id), b, u); }

  // ── Offers (HR-04 offer authorization) ──
  @Get('offers')
  listOffers(@CurrentUser() u: JwtUser) { return this.svc.listOffers(u); }

  @Post('offers')
  @Permissions('hr', 'hr_admin')
  createOffer(@Body(new ZodValidationPipe(OfferBody)) b: OfferDto, @CurrentUser() u: JwtUser) { return this.svc.createOffer(b, u); }

  // HR-04 — the approver must differ from the offer creator (SOD_SELF_APPROVAL).
  @Post('offers/:id/approve')
  @Permissions('hr_admin', 'exec')
  approveOffer(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.approveOffer(Number(id), u); }

  // HR-04 — an approved offer converts into a payroll.employees row (OFFER_NOT_APPROVED / HEADCOUNT_EXCEEDED gates).
  @Post('offers/:id/convert')
  @Permissions('hr_admin', 'exec')
  convertOffer(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.convertOffer(Number(id), u); }
}
