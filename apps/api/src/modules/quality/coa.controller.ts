import { Controller, Get, Post, Body, Param, Query, ParseIntPipe, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { CoaService } from './coa.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

// QMS-3 — Certificate of Analysis capture + out-of-spec release approval (QC-03). Reads gate quality/exec;
// recording (specs, CoA, results, evaluate) gates quality/exec; the out-of-spec release/reject gates
// quality_approve/exec. The QC-03 maker-checker (released_by ≠ created_by, deviation_reason required) is
// enforced in-app regardless of the permission held.
const SpecBody = z.object({
  item_id: z.string().min(1),
  characteristic: z.string().min(1),
  uom: z.string().optional(),
  min_value: z.number().optional(),
  max_value: z.number().optional(),
  target_value: z.number().optional(),
  active: z.boolean().optional(),
});
const CoaBody = z.object({
  lot_no: z.string().min(1),
  item_id: z.string().min(1),
  source: z.enum(['incoming', 'production']).optional(),
});
const ResultsBody = z.object({
  results: z.array(z.object({
    characteristic: z.string().min(1),
    uom: z.string().optional(),
    spec_min: z.number().optional(),
    spec_max: z.number().optional(),
    actual_value: z.number(),
  })).min(1),
});
const ReleaseBody = z.object({ deviation_reason: z.string().optional() });
const RejectBody = z.object({ reason: z.string().optional() });

@Controller('api/quality')
export class CoaController {
  constructor(private readonly svc: CoaService) {}

  // ── Specs ──
  @Get('specs')
  @Permissions('quality', 'exec')
  listSpecs(@Query('item_id') itemId: string | undefined, @CurrentUser() user: JwtUser) {
    return this.svc.listSpecs(user, itemId);
  }

  @Post('specs')
  @Permissions('quality', 'exec')
  createSpec(@Body(new ZodValidationPipe(SpecBody)) dto: z.infer<typeof SpecBody>, @CurrentUser() user: JwtUser) {
    return this.svc.createSpec(dto, user);
  }

  // ── CoA ──
  @Get('coa')
  @Permissions('quality', 'exec')
  listCoa(@Query('release_status') releaseStatus: string | undefined, @Query('overall_result') overallResult: string | undefined, @CurrentUser() user: JwtUser) {
    return this.svc.listCoa(user, { release_status: releaseStatus, overall_result: overallResult });
  }

  // Detective — the deviation register (out-of-spec lots that were released). Declared before :id.
  @Get('coa/out-of-spec')
  @Permissions('quality', 'quality_approve', 'exec')
  outOfSpec(@CurrentUser() user: JwtUser) {
    return this.svc.outOfSpecRegister(user);
  }

  @Get('coa/:id')
  @Permissions('quality', 'exec')
  getCoa(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.svc.getCoa(id, user);
  }

  @Post('coa')
  @Permissions('quality', 'exec')
  createCoa(@Body(new ZodValidationPipe(CoaBody)) dto: z.infer<typeof CoaBody>, @CurrentUser() user: JwtUser) {
    return this.svc.createCoa(dto, user);
  }

  @Post('coa/:id/results')
  @Permissions('quality', 'exec')
  addResults(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(ResultsBody)) dto: z.infer<typeof ResultsBody>, @CurrentUser() user: JwtUser) {
    return this.svc.addResults(id, dto, user);
  }

  @Post('coa/:id/evaluate')
  @Permissions('quality', 'exec')
  @HttpCode(200)
  evaluate(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.svc.evaluate(id, user);
  }

  // Release: a PASS CoA may be released by the recorder (quality); a FAIL (out-of-spec) release is the
  // deviation approval (QC-03) — the service additionally requires the quality_approve/exec approver duty,
  // a different user than the recorder, and a deviation_reason. Endpoint admits both duties; service gates.
  @Post('coa/:id/release')
  @Permissions('quality', 'quality_approve', 'exec')
  @HttpCode(200)
  release(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(ReleaseBody)) dto: z.infer<typeof ReleaseBody>, @CurrentUser() user: JwtUser) {
    return this.svc.release(id, dto, user);
  }

  @Post('coa/:id/reject')
  @Permissions('quality_approve', 'exec')
  @HttpCode(200)
  reject(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(RejectBody)) dto: z.infer<typeof RejectBody>, @CurrentUser() user: JwtUser) {
    return this.svc.reject(id, dto, user);
  }
}
