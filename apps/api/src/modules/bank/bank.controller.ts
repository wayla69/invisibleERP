import { Controller, Get, Post, Param, Query, Body, HttpCode } from '@nestjs/common';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { z } from 'zod';
import { BankService } from './bank.service';
import { CreateBankAccountBody, ImportStatementBody, ManualMatchBody, AdjustmentBody, type CreateBankAccountDto, type ImportStatementDto, type AdjustmentDto } from './dto';

const RejectBody = z.object({ reason: z.string().optional() });

// กระทบยอดธนาคาร — house-bank accounts, statement import, auto-match to GL cash, fee/interest adjustment.
@Controller('api/bank')
@Permissions('exec', 'ar')
export class BankController {
  constructor(private readonly svc: BankService) {}

  @Post('accounts') createAccount(@Body(new ZodValidationPipe(CreateBankAccountBody)) b: CreateBankAccountDto, @CurrentUser() u: JwtUser) { return this.svc.createBankAccount(b, u); }
  @Get('accounts') listAccounts(@CurrentUser() u: JwtUser) { return this.svc.listBankAccounts(u); }

  @Post('accounts/:id/statements') importStatement(@Param('id') id: string, @Body(new ZodValidationPipe(ImportStatementBody)) b: ImportStatementDto, @CurrentUser() u: JwtUser) { return this.svc.importStatement(+id, b, u); }
  @Post('accounts/:id/auto-match') autoMatch(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.autoMatch(+id, u); }
  @Get('accounts/:id/reconciliation') reconciliation(@Param('id') id: string, @Query('as_of') asOf: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.reconciliation(+id, asOf, u); }

  @Post('lines/:lineId/match') match(@Param('lineId') lineId: string, @Body(new ZodValidationPipe(ManualMatchBody)) b: { journal_line_id: number }, @CurrentUser() u: JwtUser) { return this.svc.manualMatch(+lineId, b.journal_line_id, u); }
  @Post('lines/:lineId/unmatch') unmatch(@Param('lineId') lineId: string, @CurrentUser() u: JwtUser) { return this.svc.unmatch(+lineId, u); }
  // BANK-02 maker-checker. MAKER requests a fee/interest adjustment (Draft JE, no balance effect); a DIFFERENT
  // user with approval authority approves it (approver ≠ requester enforced in the service, even for Admin).
  @Post('lines/:lineId/adjustment') requestAdjustment(@Param('lineId') lineId: string, @Body(new ZodValidationPipe(AdjustmentBody)) b: AdjustmentDto, @CurrentUser() u: JwtUser) { return this.svc.requestAdjustment(+lineId, b, u); }

  @Get('adjustments/pending') @Permissions('approvals', 'gl_close', 'exec') pendingAdjustments(@CurrentUser() u: JwtUser) { return this.svc.listPendingAdjustments(u); }
  @Post('lines/:lineId/adjustment/approve') @HttpCode(200) @Permissions('approvals', 'gl_close') approveAdjustment(@Param('lineId') lineId: string, @CurrentUser() u: JwtUser) { return this.svc.approveAdjustment(+lineId, u); }
  @Post('lines/:lineId/adjustment/reject') @HttpCode(200) @Permissions('approvals', 'gl_close') rejectAdjustment(@Param('lineId') lineId: string, @Body(new ZodValidationPipe(RejectBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) { return this.svc.rejectAdjustment(+lineId, u, b.reason); }
}
