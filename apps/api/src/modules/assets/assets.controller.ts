import { Controller, Get, Post, Patch, Param, Query, Body, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AssetsService } from './assets.service';
import { CreateCategoryBody, AcquireAssetBody, RunDepreciationBody, DisposeAssetBody, type CreateCategoryDto, type AcquireAssetDto, type DisposeAssetDto } from './dto';
import { qint, qintOpt } from '../../common/query';

const ScanUpdateBody = z.object({ code: z.string().min(1), location: z.string().optional(), assigned_to: z.string().optional(), note: z.string().optional() });
type ScanUpdateBodyT = z.infer<typeof ScanUpdateBody>;
const RevalueBody = z.object({ new_value: z.number().nonnegative(), reason: z.string().optional(), reval_date: z.string().optional() });
const RevalRejectBody = z.object({ reason: z.string().optional() });

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

  @Post('categories') createCategory(@Body(new ZodValidationPipe(CreateCategoryBody)) b: CreateCategoryDto, @CurrentUser() u: JwtUser) { return this.svc.createCategory(b, u); }
  @Get('categories') listCategories(@CurrentUser() u: JwtUser) { return this.svc.listCategories(u); }

  @Post() acquire(@Body(new ZodValidationPipe(AcquireAssetBody)) b: AcquireAssetDto, @CurrentUser() u: JwtUser) { return this.svc.acquire(b, u); }
  @Get() register(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.assetRegister(u, status); }
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
