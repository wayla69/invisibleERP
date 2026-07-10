import { Controller, Get, Put, Query, Body, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CommitmentsService } from '../commitments/commitments.service';
import { ymd } from '../../database/queries';

const ControlSettingsBody = z.object({
  policy: z.enum(['off', 'advise', 'warn', 'block']).optional(),
  default_expense_account: z.string().min(1).optional(),
});

// FIN-3 (BUD-02) — budgetary control / encumbrance surface. The gate itself runs inside the PR/PO approval
// path (procurement module → CommitmentsService.glGate); this controller is the read/config surface:
// availability (for the approval-screen chip + the budget screen), the commitment audit list (override
// evidence), and the per-tenant policy settings (change restricted to exec/gl_close — mirrors the
// receiving-settings/EXP-04 change-control pattern: approvers can read the gate, not loosen it).
@Controller('api/budget')
export class BudgetControlController {
  constructor(private readonly commitments: CommitmentsService) {}

  // Availability for a budget key (account+period[, cost_center]) OR a document (doc_type+doc_no — the
  // PR/PO approval chip: evaluates the doc's lines exactly as the gate will).
  @Get('availability') @Permissions('exec', 'planner', 'procurement', 'approvals', 'fin_report', 'gl_close')
  async availability(
    @Query('account') account?: string, @Query('period') period?: string, @Query('cost_center') costCenter?: string,
    @Query('doc_type') docType?: string, @Query('doc_no') docNo?: string, @CurrentUser() u?: JwtUser,
  ) {
    const tenantId = u?.tenantId ?? null;
    if (docType && docNo) {
      if (docType !== 'PR' && docType !== 'PO') throw new BadRequestException({ code: 'BAD_DOC_TYPE', message: 'doc_type must be PR or PO', messageTh: 'doc_type ต้องเป็น PR หรือ PO' });
      return this.commitments.glDocPreview(docType, docNo.toUpperCase(), tenantId);
    }
    if (!account) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'account (or doc_type+doc_no) is required', messageTh: 'ต้องระบุ account หรือ doc_type+doc_no' });
    const p = period && /^\d{4}-\d{2}$/.test(period) ? period : ymd().slice(0, 7); // business month (Asia/Bangkok)
    return this.commitments.glAvailability(tenantId, account, costCenter?.trim() || null, p);
  }

  // Commitment audit list (override evidence: over_budget + override_by/override_reason on each row).
  @Get('commitments') @Permissions('exec', 'planner', 'procurement', 'approvals', 'fin_report', 'gl_close')
  listCommitments(@Query('account') account?: string, @Query('period') period?: string, @Query('doc_no') docNo?: string, @Query('status') status?: string, @CurrentUser() u?: JwtUser) {
    return this.commitments.glListCommitments(u?.tenantId ?? null, { account, period, source_doc_no: docNo, status });
  }

  @Get('control-settings') @Permissions('exec', 'planner', 'procurement', 'approvals', 'gl_close')
  getSettings(@CurrentUser() u: JwtUser) { return this.commitments.glControlSettings(u.tenantId ?? null); }

  @Put('control-settings') @Permissions('exec', 'gl_close')
  putSettings(@Body(new ZodValidationPipe(ControlSettingsBody)) b: z.infer<typeof ControlSettingsBody>, @CurrentUser() u: JwtUser) {
    return this.commitments.glUpdateControlSettings(b, u);
  }
}
