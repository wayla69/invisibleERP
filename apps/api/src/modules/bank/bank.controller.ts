import { Controller, Get, Post, Param, Query, Body, HttpCode } from '@nestjs/common';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { z } from 'zod';
import { BankService } from './bank.service';
import { CreateBankAccountBody, ImportStatementBody, ImportStatementFileBody, ManualMatchBody, AdjustmentBody, type CreateBankAccountDto, type ImportStatementDto, type ImportStatementFileDto, type AdjustmentDto } from './dto';

const RejectBody = z.object({ reason: z.string().optional() });
const CreateDepositBody = z.object({ bank_account_id: z.number().int(), movement_nos: z.array(z.string()).optional(), deposit_date: z.string().optional() });

// กระทบยอดธนาคาร — house-bank accounts, statement import, auto-match to GL cash, fee/interest adjustment.
@Controller('api/bank')
@Permissions('exec', 'ar')
export class BankController {
  constructor(private readonly svc: BankService) {}

  // REC-05 — cash banking: batch till safe-drops into a bank deposit (Dr bank / Cr 1000) + reconcile.
  @Get('deposits/undeposited-drops') undepositedDrops(@CurrentUser() u: JwtUser) { return this.svc.undepositedDrops(u); }
  @Get('deposits') listDeposits(@CurrentUser() u: JwtUser) { return this.svc.listDeposits(u); }
  @Post('deposits') createDeposit(@Body(new ZodValidationPipe(CreateDepositBody)) b: z.infer<typeof CreateDepositBody>, @CurrentUser() u: JwtUser) { return this.svc.createDeposit(b, u); }
  @Post('deposits/:id/reconcile') @HttpCode(200) reconcileDeposit(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.reconcileDeposit(+id, u); }

  @Post('accounts') createAccount(@Body(new ZodValidationPipe(CreateBankAccountBody)) b: CreateBankAccountDto, @CurrentUser() u: JwtUser) { return this.svc.createBankAccount(b, u); }
  // Read widened to the AP payment-run actors (EXP-13): the `creditors` proposer picks the source
  // house-bank for the bulk-transfer file; `approvals`/`gl_close` review it. Read-only master list.
  @Get('accounts') @Permissions('exec', 'ar', 'creditors', 'approvals', 'gl_close') listAccounts(@CurrentUser() u: JwtUser) { return this.svc.listBankAccounts(u); }
  // G9 maker-checker: a new bank account is created PendingApproval; a DIFFERENT approver activates it
  // (approver ≠ requester → 403 SOD_VIOLATION) before it can bank cash.
  @Get('accounts/pending') @Permissions('approvals', 'exec') pendingAccounts(@CurrentUser() u: JwtUser) { return this.svc.listPendingBankAccounts(u); }
  @Post('accounts/:id/approve') @HttpCode(200) @Permissions('approvals', 'exec') approveAccount(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.approveBankAccount(+id, u); }
  @Post('accounts/:id/reject') @HttpCode(200) @Permissions('approvals', 'exec') rejectAccount(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.rejectBankAccount(+id, u); }

  @Post('accounts/:id/statements') importStatement(@Param('id') id: string, @Body(new ZodValidationPipe(ImportStatementBody)) b: ImportStatementDto, @CurrentUser() u: JwtUser) { return this.svc.importStatement(+id, b, u); }
  // File import — the bank's own CSV/XLSX export (Thai/English headers, BE dates); same pipeline as above.
  @Post('accounts/:id/statements/import-file') importStatementFile(@Param('id') id: string, @Body(new ZodValidationPipe(ImportStatementFileBody)) b: ImportStatementFileDto, @CurrentUser() u: JwtUser) { return this.svc.importStatementFile(+id, b, u); }
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
