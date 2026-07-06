import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { RetentionService } from './retention.service';

const TrancheBody = z.object({
  tranche_no: z.number().int().positive().optional(),
  due_basis: z.enum(['date', 'practical_completion', 'dlp_end']).optional(),
  pct: z.number().nonnegative().optional(),
  amount: z.number().nonnegative().optional(),
  due_date: z.string().optional(),
});
const WithholdBody = z.object({
  party_type: z.enum(['customer', 'subcontractor']),
  project_code: z.string().optional(),
  party_ref: z.string().optional(),
  source_doc_type: z.enum(['CLAIM', 'SUBVAL', 'MANUAL']).optional(),
  source_doc_no: z.string().min(1),
  amount: z.number().positive(),
  schedule: z.array(TrancheBody).optional(),
});
const ReleaseBody = z.object({
  amount: z.number().positive().optional(),
  tranche_id: z.number().int().positive().optional(),
}).refine((b) => b.amount != null || b.tranche_id != null, { message: 'amount or tranche_id is required' });

// Shared retention sub-ledger surface (docs/35 Phase 0). The read/worklist endpoints are the treasury/
// controller surface; withhold/release are also invoked at the SERVICE layer by Track A (progress billing)
// and Track B (subcontract valuations) inside their certifying transactions (which post the matching GL). The
// ledger tracks balances only — releasing here does not post GL on its own (A/B post the composite journal).
@Controller('api/retention')
export class RetentionController {
  constructor(private readonly svc: RetentionService) {}

  // Record a retention withholding (customer 1170 / subcontractor 2440), optionally with a release schedule.
  @Post('withhold')
  @Permissions('gl_close', 'exec', 'ar', 'creditors')
  async withhold(@Body(new ZodValidationPipe(WithholdBody)) b: z.infer<typeof WithholdBody>, @CurrentUser() u: JwtUser) {
    const { projectId, tenantId } = await this.svc.resolveProjectRef(b.project_code, u.tenantId ?? null);
    return this.svc.withhold({
      partyType: b.party_type, projectId, tenantId, partyRef: b.party_ref,
      sourceDocType: b.source_doc_type ?? 'MANUAL', sourceDocNo: b.source_doc_no, amount: b.amount,
      createdBy: u.username, schedule: b.schedule,
    });
  }

  // Release retention — a partial amount or a specific scheduled tranche (treasury/controller act).
  @Post(':id/release')
  @Permissions('gl_close', 'exec')
  release(@Param('id') id: string, @Body(new ZodValidationPipe(ReleaseBody)) b: z.infer<typeof ReleaseBody>, @CurrentUser() u: JwtUser) {
    return this.svc.releaseStandalone({ retentionId: Number(id), amount: b.amount, trancheId: b.tranche_id, releasedBy: u.username });
  }

  // Retention releases due for action (pending date-based tranches whose due date has passed).
  @Get('due')
  @Permissions('gl_close', 'exec')
  due(@Query('as_of') asOf?: string) {
    return this.svc.due(asOf);
  }

  // Per-project retention read model (receivable/payable split + rows + schedules).
  @Get('project/:code')
  @Permissions('exec', 'ar', 'creditors', 'gl_close')
  forProject(@Param('code') code: string) {
    return this.svc.listForProjectCode(code);
  }
}
