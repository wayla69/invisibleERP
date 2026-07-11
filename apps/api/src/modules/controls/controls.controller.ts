import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ControlsService } from './controls.service';

const ReviewBody = z.object({ status: z.enum(['reviewed', 'dismissed']) });
// GOV-02 disposition: set an accountable owner + due date + root cause; a closing disposition
// (remediated/accepted/false_positive) tracks the exception to closure with who/when.
const DispositionBody = z.object({
  disposition: z.enum(['open', 'investigating', 'remediated', 'accepted', 'false_positive']),
  owner: z.string().max(120).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  root_cause: z.string().max(2000).optional(),
});

// Continuous controls monitoring (Phase 19 — B5; GRC-4 disposition + KCI, GOV-02). Read-only detective
// controls + a managed exception-disposition workflow and KCI roll-up; never posts to the GL.
@Controller('api/controls')
export class ControlsController {
  constructor(private readonly svc: ControlsService) {}

  @Get('catalog') @Permissions('exec', 'users', 'creditors')
  catalog() { return this.svc.catalog(); }

  @Post('scan') @Permissions('exec', 'users', 'creditors')
  scan(@CurrentUser() u: JwtUser) { return this.svc.scan(u); }

  @Get('findings') @Permissions('exec', 'users', 'creditors')
  findings(@Query('status') status: string | undefined, @Query('disposition') disposition: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.listFindings(u, { status: status || undefined, disposition: disposition || undefined });
  }

  @Post('findings/:id/review') @Permissions('exec', 'users', 'creditors')
  review(@Param('id') id: string, @Body(new ZodValidationPipe(ReviewBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.review(+id, b.status, u); }

  @Post('findings/:id/disposition') @Permissions('exec', 'users', 'creditors')
  disposition(@Param('id') id: string, @Body(new ZodValidationPipe(DispositionBody)) b: any, @CurrentUser() u: JwtUser) {
    return this.svc.disposition(+id, b, u);
  }

  @Get('kci') @Permissions('exec', 'users', 'creditors')
  kci(@CurrentUser() u: JwtUser) { return this.svc.kci(u); }
}
