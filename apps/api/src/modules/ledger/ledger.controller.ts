import { Controller, Get, Post, Query, Body, Param } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { qint } from '../../common/query';
import { LedgerService } from './ledger.service';

// Only HQ/Admin may target ANOTHER tenant's books via an explicit tenant_id. Everyone else is pinned to
// their own request context (RLS also enforces this at the DB — this is defence-in-depth at the app layer
// so a stray tenant_id from a non-Admin can never even reach the service). Returns undefined → the service
// falls back to the caller's tenant context.
function hqTenant(u: JwtUser, requested?: number | null): number | undefined {
  if (requested == null) return undefined;
  return u.role === 'Admin' ? requested : undefined;
}

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

const OpeningBalancesBody = z.object({
  batch_ref: z.string().optional(),
  // account_code intentionally not .min(1): the service reports bad rows per-row (CSV resilience)
  // rather than rejecting the whole batch.
  rows: z.array(z.object({
    account_code: z.string(),
    debit: z.number().optional(),
    credit: z.number().optional(),
  })).min(1),
});
type OpeningBalancesBody = z.infer<typeof OpeningBalancesBody>;

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
  @Permissions('gl_post', 'creditors', 'ar')
  adjustment(@Param('code') code: string, @Body(new ZodValidationPipe(JournalBody)) b: JournalBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.postAdjustment(code, { date: b.date, source: b.source ?? 'GAAP-ADJ', sourceRef: b.source_ref, tenantId: hqTenant(u, b.tenant_id) ?? null, currency: b.currency, memo: b.memo, lines: b.lines, createdBy: u.username });
  }

  // book-tax difference report (TFRS vs TAX → deferred-tax / ภ.ง.ด.50 basis)
  @Get('gaap-comparison')
  gaapComparison(@Query('from') from: string, @Query('to') to: string, @Query('base') base?: string, @Query('compare') compare?: string) {
    return this.svc.gaapComparison(from, to, base || undefined, compare || undefined);
  }

  @Get('trial-balance')
  trialBalance(@Query('period') period?: string, @Query('cost_center') costCenter?: string, @Query('ledger') ledger?: string) { return this.svc.trialBalance(period, costCenter, ledger || undefined); }

  @Get('journal')
  journal(@Query('limit') limit?: string) { return this.svc.listJournal(qint('limit', limit, 50)); }

  @Post('journal')
  @Permissions('gl_post', 'creditors', 'ar')
  postJournal(@Body(new ZodValidationPipe(JournalBody)) b: JournalBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.postEntry({
      date: b.date,
      source: b.source ?? 'Manual',
      sourceRef: b.source_ref,
      tenantId: hqTenant(u, b.tenant_id) ?? null,
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

  // Fiscal-period close/open and year-end close are the 'gl_close' duty — segregated from journal POSTING
  // ('gl_post', above). A JE preparer cannot also close the books (resolves SoD rule R05). Legacy 'exec'
  // holders still pass (exec implies gl_close); a single-duty GL Accountant (gl_post only) does not.
  @Post('periods/:period/close')
  @Permissions('gl_close')
  closePeriod(@Param('period') period: string, @Query('tenant_id') tenantId: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.closePeriod(period, hqTenant(u, tenantId ? Number(tenantId) : undefined)); }

  @Post('periods/:period/open')
  @Permissions('gl_close')
  openPeriod(@Param('period') period: string, @Query('tenant_id') tenantId: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.openPeriod(period, hqTenant(u, tenantId ? Number(tenantId) : undefined)); }

  @Post('close-year')
  @Permissions('gl_close')
  closeYear(@Query('fiscal_year') fy: string, @Query('ledger') ledger: string | undefined, @Query('tenant_id') tenantId: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.closeYear(parseInt(fy, 10), u.username, ledger || undefined, hqTenant(u, tenantId ? Number(tenantId) : undefined)); }

  // ── Opening balances (cutover from a prior system) → one balanced JE, idempotent on batch_ref ──
  @Post('opening-balances')
  @Permissions('gl_post', 'creditors', 'ar')
  openingBalances(@Body(new ZodValidationPipe(OpeningBalancesBody)) b: OpeningBalancesBody, @Query('tenant_id') tenantId: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.postOpeningBalances(b.rows, b.batch_ref, u.username, hqTenant(u, tenantId ? Number(tenantId) : undefined));
  }
}
