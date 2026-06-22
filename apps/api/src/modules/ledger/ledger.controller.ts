import { Controller, Get, Post, Query, Body, Param } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { LedgerService } from './ledger.service';

const JournalBody = z.object({
  date: z.string().optional(),
  source: z.string().optional(),
  source_ref: z.string().optional(),
  tenant_id: z.number().optional(),
  currency: z.string().optional(),
  memo: z.string().optional(),
  lines: z.array(z.object({
    account_code: z.string().min(1),
    debit: z.number().nonnegative().optional(),
    credit: z.number().nonnegative().optional(),
    memo: z.string().optional(),
    cost_center: z.string().optional(),
  })).min(1),
});
type JournalBodyT = z.infer<typeof JournalBody>;

@Controller('api/ledger')
@Permissions('exec', 'creditors', 'ar')
export class LedgerController {
  constructor(private readonly svc: LedgerService) {}

  @Get('accounts')
  accounts() { return this.svc.listAccounts(); }

  // ── multi-ledger / multi-GAAP ──
  @Get('ledgers')
  ledgers() { return this.svc.listLedgers(); }

  // post a GAAP-divergent adjustment to ONE ledger (e.g. tax-depreciation delta)
  @Post('ledgers/:code/adjustment')
  adjustment(@Param('code') code: string, @Body(new ZodValidationPipe(JournalBody)) b: JournalBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.postAdjustment(code, { date: b.date, source: b.source ?? 'GAAP-ADJ', sourceRef: b.source_ref, tenantId: b.tenant_id ?? null, currency: b.currency, memo: b.memo, lines: b.lines, createdBy: u.username });
  }

  // book-tax difference report (TFRS vs TAX → deferred-tax / ภ.ง.ด.50 basis)
  @Get('gaap-comparison')
  gaapComparison(@Query('from') from: string, @Query('to') to: string, @Query('base') base?: string, @Query('compare') compare?: string) {
    return this.svc.gaapComparison(from, to, base || undefined, compare || undefined);
  }

  @Get('trial-balance')
  trialBalance(@Query('period') period?: string, @Query('cost_center') costCenter?: string, @Query('ledger') ledger?: string) { return this.svc.trialBalance(period, costCenter, ledger || undefined); }

  @Get('journal')
  journal(@Query('limit') limit?: string) { return this.svc.listJournal(limit ? +limit : 50); }

  @Post('journal')
  postJournal(@Body(new ZodValidationPipe(JournalBody)) b: JournalBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.postEntry({
      date: b.date,
      source: b.source ?? 'Manual',
      sourceRef: b.source_ref,
      tenantId: b.tenant_id ?? null,
      currency: b.currency,
      memo: b.memo,
      lines: b.lines,
      createdBy: u.username,
    });
  }

  @Get('income-statement')
  incomeStatement(@Query('from') from: string, @Query('to') to: string, @Query('cost_center') costCenter?: string, @Query('ledger') ledger?: string) { return this.svc.incomeStatement(from, to, costCenter, ledger || undefined); }

  @Get('balance-sheet')
  balanceSheet(@Query('as_of') asOf: string, @Query('ledger') ledger?: string) { return this.svc.balanceSheet(asOf, ledger || undefined); }

  // ── fiscal periods + year-end close ──
  // Periods are per-tenant (0043). Operations default to the caller's own tenant; HQ/Admin may target a
  // specific shop with ?tenant_id= (used when one operator manages several tenants' books).
  @Get('periods')
  periods(@Query('tenant_id') tenantId?: string) { return this.svc.listPeriods(tenantId ? Number(tenantId) : undefined); }

  @Post('periods/:period/close')
  closePeriod(@Param('period') period: string, @Query('tenant_id') tenantId?: string) { return this.svc.closePeriod(period, tenantId ? Number(tenantId) : undefined); }

  @Post('periods/:period/open')
  openPeriod(@Param('period') period: string, @Query('tenant_id') tenantId?: string) { return this.svc.openPeriod(period, tenantId ? Number(tenantId) : undefined); }

  @Post('close-year')
  closeYear(@Query('fiscal_year') fy: string, @Query('ledger') ledger: string | undefined, @Query('tenant_id') tenantId: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.closeYear(parseInt(fy, 10), u.username, ledger || undefined, tenantId ? Number(tenantId) : undefined); }
}
