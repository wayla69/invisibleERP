import { Controller, Get, Post, Put, Param, Query, Body, HttpCode } from '@nestjs/common';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { z } from 'zod';
import { PromptPayReconService } from './promptpay-recon.service';

const SettlementBody = z.object({ bank_account_id: z.number().int() });
const ReconBody = z.object({ recon_date: z.string(), bank_account_id: z.number().int().optional() });
const ClearBody = z.object({ note: z.string().optional() });

// POS-8 / control POS-08 — PromptPay store-level auto-reconciliation. Match the store's PromptPay tenders to
// its bank-statement inflows (reusing the bank auto-match engine) and surface unmatched tenders as a till
// exception. Gated to the reconciliation / store-close duties (recon_prep / pos_close / exec).
@Controller('api/pos/promptpay-recon')
@Permissions('recon_prep', 'pos_close', 'exec')
export class PromptPayReconController {
  constructor(private readonly svc: PromptPayReconService) {}

  // Store settlement-account map — which house-bank account the store's PromptPay collections settle into.
  @Get('settlement-account') getSettlement(@CurrentUser() u: JwtUser) { return this.svc.getSettlementAccount(u); }
  @Put('settlement-account') @Permissions('exec', 'recon_prep') setSettlement(@Body(new ZodValidationPipe(SettlementBody)) b: z.infer<typeof SettlementBody>, @CurrentUser() u: JwtUser) { return this.svc.setSettlementAccount(b, u); }

  // Run the day's reconciliation: auto-match tenders ↔ inflows, open exceptions for the unmatched.
  @Post('run') @HttpCode(200) run(@Body(new ZodValidationPipe(ReconBody)) b: z.infer<typeof ReconBody>, @CurrentUser() u: JwtUser) { return this.svc.reconcile(b, u); }

  // Exception surface (mirrors the till-variance exception surface).
  @Get('exceptions') listExceptions(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listExceptions(status, u); }
  @Post('exceptions/:id/clear') @HttpCode(200) @Permissions('pos_close', 'exec', 'approvals') clear(@Param('id') id: string, @Body(new ZodValidationPipe(ClearBody)) b: z.infer<typeof ClearBody>, @CurrentUser() u: JwtUser) { return this.svc.clearException(+id, u, b.note); }
}
