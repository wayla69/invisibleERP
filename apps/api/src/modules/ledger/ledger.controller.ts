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

  @Get('trial-balance')
  trialBalance(@Query('period') period?: string, @Query('cost_center') costCenter?: string) { return this.svc.trialBalance(period, costCenter); }

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
  incomeStatement(@Query('from') from: string, @Query('to') to: string, @Query('cost_center') costCenter?: string) { return this.svc.incomeStatement(from, to, costCenter); }

  @Get('balance-sheet')
  balanceSheet(@Query('as_of') asOf: string) { return this.svc.balanceSheet(asOf); }

  // ── fiscal periods + year-end close ──
  @Get('periods')
  periods() { return this.svc.listPeriods(); }

  @Post('periods/:period/close')
  closePeriod(@Param('period') period: string) { return this.svc.closePeriod(period); }

  @Post('periods/:period/open')
  openPeriod(@Param('period') period: string) { return this.svc.openPeriod(period); }

  @Post('close-year')
  closeYear(@Query('fiscal_year') fy: string, @CurrentUser() u: JwtUser) { return this.svc.closeYear(parseInt(fy, 10), u.username); }
}
