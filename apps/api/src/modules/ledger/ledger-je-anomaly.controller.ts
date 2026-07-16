import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { LedgerJeAnomalyService } from './ledger-je-anomaly.service';

const DismissBody = z.object({ reason: z.string().min(1).max(500) });
type DismissDto = z.infer<typeof DismissBody>;

// B5 (docs/50 Wave 5, GL-28) — the JE-exception review surface. Scan/list for the close/controls duties;
// dismissal (the review disposition) is gated to gl_close/exec and always audit-logged with the reason.
@Controller('api/ledger/je-exceptions')
export class LedgerJeAnomalyController {
  constructor(private readonly svc: LedgerJeAnomalyService) {}

  @Post('scan') @Permissions('gl_close', 'approvals', 'exec')
  scan(@Query('days') days: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.scan(u, { days: days != null ? Number(days) : undefined });
  }

  @Get() @Permissions('gl_close', 'approvals', 'exec', 'fin_report')
  list(@Query('status') status: string | undefined, @Query('rule') rule: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.list({ status, rule }, u);
  }

  @Post(':id/dismiss') @Permissions('gl_close', 'exec')
  dismiss(@Param('id') id: string, @Body(new ZodValidationPipe(DismissBody)) b: DismissDto, @CurrentUser() u: JwtUser) {
    return this.svc.dismiss(Number(id), b, u);
  }
}
