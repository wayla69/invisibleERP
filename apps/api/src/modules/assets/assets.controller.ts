import { Controller, Get, Post, Patch, Param, Query, Body, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AssetsService } from './assets.service';
import { CreateCategoryBody, AcquireAssetBody, RunDepreciationBody, DisposeAssetBody, RegisterFromGrBody, type CreateCategoryDto, type AcquireAssetDto, type DisposeAssetDto, type RegisterFromGrDto } from './dto';
import { qint, qintOpt } from '../../common/query';

const ScanUpdateBody = z.object({ code: z.string().min(1), location: z.string().optional(), assigned_to: z.string().optional(), note: z.string().optional() });
type ScanUpdateBodyT = z.infer<typeof ScanUpdateBody>;
const RevalueBody = z.object({ new_value: z.number().nonnegative(), reason: z.string().optional(), reval_date: z.string().optional() });
const RevalRejectBody = z.object({ reason: z.string().optional() });
const AuditOpenBody = z.object({ location: z.string().optional() });
const AuditScanBody = z.object({ code: z.string().min(1), client_uuid: z.string().optional() });

@Controller('api/assets')
@Permissions('exec', 'creditors')
export class AssetsController {
  constructor(private readonly svc: AssetsService) {}

  // ── QR asset tags ──────────────────────────────────────────────
  @Get(':assetNo/qr') qr(@Param('assetNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.assetQr(no, u); }

  @Get('qr/labels')
  async labels(@Query('status') status: string | undefined, @Query('cols') cols: string | undefined, @Query('rows') rows: string | undefined, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const { pdf, html } = await this.svc.assetLabels(u, { status, cols: qintOpt('cols', cols), rows: qintOpt('rows', rows) });
    if (pdf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', 'attachment; filename="asset_tags.pdf"').header('Content-Length', pdf.length).send(pdf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  }

  @Post('scan-update') scanUpdate(@Body(new ZodValidationPipe(ScanUpdateBody)) b: ScanUpdateBodyT, @CurrentUser() u: JwtUser) { return this.svc.scanUpdate(b, u); }

  // ── FA-11 custody-change maker-checker (a scanned move needs a DIFFERENT user's approval) ──
  @Get('custody') listCustody(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listCustodyRequests(status, u); }
  @Post('custody/:reqNo/approve') approveCustody(@Param('reqNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.approveCustody(no, u); }
  @Post('custody/:reqNo/reject') rejectCustody(@Param('reqNo') no: string, @Body(new ZodValidationPipe(RevalRejectBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) { return this.svc.rejectCustody(no, u, b?.reason); }

  // ── Asset audit (physical count by scan) → reconcile against the register ──
  @Post('audits') openAudit(@Body(new ZodValidationPipe(AuditOpenBody)) b: z.infer<typeof AuditOpenBody>, @CurrentUser() u: JwtUser) { return this.svc.openAudit(b, u); }
  @Get('audits') listAudits(@Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listAudits(u, qint('limit', limit, 50)); }
  @Get('audit-report') auditReport(@Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.auditReport(u, { limit: qintOpt('limit', limit) }); }
  @Get('unverified') unverified(@Query('days') days: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.unverifiedAssets(u, { days: qintOpt('days', days) }); }
  @Get('audits/:auditNo') getAudit(@Param('auditNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.getAudit(no, u); }
  @Post('audits/:auditNo/scan') scanAudit(@Param('auditNo') no: string, @Body(new ZodValidationPipe(AuditScanBody)) b: z.infer<typeof AuditScanBody>, @CurrentUser() u: JwtUser) { return this.svc.scanAudit(no, b, u); }
  @Post('audits/:auditNo/close') closeAudit(@Param('auditNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.closeAudit(no, u); }

  @Post('categories') createCategory(@Body(new ZodValidationPipe(CreateCategoryBody)) b: CreateCategoryDto, @CurrentUser() u: JwtUser) { return this.svc.createCategory(b, u); }
  @Get('categories') listCategories(@CurrentUser() u: JwtUser) { return this.svc.listCategories(u); }

  @Post() acquire(@Body(new ZodValidationPipe(AcquireAssetBody)) b: AcquireAssetDto, @CurrentUser() u: JwtUser) { return this.svc.acquire(b, u); }
  @Get() register(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.assetRegister(u, status); }

  // ── Procure-to-Capitalize (FA-10): register a fixed asset from a capital goods-receipt line (maker-checker).
  // List capital GR lines awaiting capitalisation; raise a registration (preparer); a DIFFERENT user approves.
  @Get('registrations/eligible') eligibleFromGr(@Query('gr_no') grNo: string, @CurrentUser() u: JwtUser) { return this.svc.eligibleFromGr(grNo, u); }
  @Get('registrations') listRegistrations(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listRegistrations(status, u); }
  @Post('registrations') registerFromGr(@Body(new ZodValidationPipe(RegisterFromGrBody)) b: RegisterFromGrDto, @CurrentUser() u: JwtUser) { return this.svc.registerFromGr(b, u); }
  @Post('registrations/:regNo/approve') approveReg(@Param('regNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.approveRegistration(no, u); }
  @Post('registrations/:regNo/reject') rejectReg(@Param('regNo') no: string, @Body(new ZodValidationPipe(RevalRejectBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) { return this.svc.rejectRegistration(no, u, b?.reason); }
  @Get(':assetNo/schedule') schedule(@Param('assetNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.depreciationSchedule(u, no); }
  // Disposal (FA-03) + FA-09 maker-checker: a dispose request posts a Draft JE + flags disposal_pending; a DIFFERENT user must approve before it is effective.
  @Patch(':assetNo/dispose') dispose(@Param('assetNo') no: string, @Body(new ZodValidationPipe(DisposeAssetBody)) b: DisposeAssetDto, @CurrentUser() u: JwtUser) { return this.svc.dispose(no, b, u); }
  @Post(':assetNo/dispose/approve') approveDispose(@Param('assetNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.approveDisposal(no, u); }
  @Post(':assetNo/dispose/reject') rejectDispose(@Param('assetNo') no: string, @Body(new ZodValidationPipe(RevalRejectBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) { return this.svc.rejectDisposal(no, u, b?.reason); }

  // Revaluation / impairment (FA-07 valuation): adjust carrying amount; upward → revaluation surplus, downward → impairment loss.
  // FA-08 maker-checker: a revalue request posts a Draft JE + 'PendingApproval'; a DIFFERENT user must approve before it is effective.
  @Post(':assetNo/revalue') revalue(@Param('assetNo') no: string, @Body(new ZodValidationPipe(RevalueBody)) b: z.infer<typeof RevalueBody>, @CurrentUser() u: JwtUser) { return this.svc.revalue(no, b, u); }
  @Post(':assetNo/revalue/approve') approveReval(@Param('assetNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.approveRevaluation(no, u); }
  @Post(':assetNo/revalue/reject') rejectReval(@Param('assetNo') no: string, @Body(new ZodValidationPipe(RevalRejectBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) { return this.svc.rejectRevaluation(no, u, b?.reason); }
  @Get(':assetNo/revaluations') revaluations(@Param('assetNo') no: string) { return this.svc.listRevaluations(no); }

  @Post('depreciation/run') runDep(@Body(new ZodValidationPipe(RunDepreciationBody)) b: { period: string }, @CurrentUser() u: JwtUser) { return this.svc.runDepreciation(b.period, u); }
  @Get('depreciation/runs') runs(@Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listRuns(u, qint('limit', limit, 50)); }
}
