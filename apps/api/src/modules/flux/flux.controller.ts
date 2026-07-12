import { Body, Controller, Get, Param, Post, Put, HttpCode, ParseIntPipe } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { FluxService } from './flux.service';

const GenerateBody = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM'),
  basis: z.enum(['PL', 'BS']).optional(),
  comparative: z.enum(['prior_period', 'prior_year', 'budget']).optional(),
  threshold_abs: z.number().nonnegative().optional(),
  threshold_pct: z.number().nonnegative().optional(),
});
type GenerateBodyT = z.infer<typeof GenerateBody>;

const ExplainBody = z.object({ explanation: z.string().min(1) });
type ExplainBodyT = z.infer<typeof ExplainBody>;

// Review has no required fields — tolerate an empty POST body (Fastify yields undefined / '').
const ReviewBody = z.preprocess((v) => (v == null || v === '' ? {} : v), z.object({ note: z.string().optional() }));
type ReviewBodyT = z.infer<typeof ReviewBody>;

// CLS-01 (GL-25) — Flux / variance analysis with forced explanation + sign-off. A management-review control
// over the period close. Reads are open to close/GL/finance-report duties; generating and explaining use the
// same finance duties (preparer); review/sign-off is maker-checker in-app (reviewer ≠ preparer). Posts
// NOTHING to the GL.
@Controller('api/close/flux')
export class FluxController {
  constructor(private readonly svc: FluxService) {}

  @Get()
  @Permissions('gl_close', 'gl_post', 'fin_report', 'exec')
  list() {
    return this.svc.list();
  }

  @Get(':id')
  @Permissions('gl_close', 'gl_post', 'fin_report', 'exec')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.svc.get(id);
  }

  // Build the analysis lines from gl_period_balances vs the comparative + thresholds.
  @Post('generate')
  @HttpCode(201)
  @Permissions('gl_close', 'fin_report', 'exec')
  generate(@Body(new ZodValidationPipe(GenerateBody)) b: GenerateBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.generate(b, u);
  }

  // Preparer records the mandatory explanation for a threshold-breaching line.
  @Put(':id/lines/:lineId/explain')
  @HttpCode(200)
  @Permissions('gl_close', 'fin_report', 'exec')
  explain(@Param('id', ParseIntPipe) id: number, @Param('lineId', ParseIntPipe) lineId: number, @Body(new ZodValidationPipe(ExplainBody)) b: ExplainBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.explain(id, lineId, b, u);
  }

  // Independent reviewer signs off: every breached line must be explained (else UNEXPLAINED_LINES) and the
  // reviewer must differ from the preparer (else SOD_SELF_APPROVAL).
  @Post(':id/review')
  @HttpCode(200)
  @Permissions('gl_close', 'exec')
  review(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(ReviewBody)) b: ReviewBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.review(id, b, u);
  }
}
