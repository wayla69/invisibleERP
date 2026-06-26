import { Controller, Get, Post, Query, Body, Param, HttpCode, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
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

const RejectBody = z.object({ reason: z.string().optional() });

// GL-17: reverse a posted JE with an optional reason and an optional reversal date (defaults to today).
const ReverseBody = z.object({ reason: z.string().optional(), date: z.string().optional() });

const RecurringBody = z.object({
  name: z.string().min(1),
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  memo: z.string().optional(),
  ledger_code: z.string().optional(),
  currency: z.string().optional(),
  tenant_id: z.number().optional(),
  start_date: z.string().optional(),
  lines: z.array(z.object({
    account_code: z.string().min(1),
    debit: z.number().nonnegative().optional(),
    credit: z.number().nonnegative().optional(),
    memo: z.string().optional(),
    cost_center: z.string().optional(),
  })).min(1),
});
type RecurringBodyT = z.infer<typeof RecurringBody>;

const ActiveBody = z.object({ active: z.boolean() });

const PrepaidBody = z.object({
  name: z.string().min(1),
  total_amount: z.number().positive(),
  months: z.number().int().positive(),
  expense_account: z.string().optional(),
  prepaid_account: z.string().optional(),
  tenant_id: z.number().optional(),
  start_date: z.string().optional(),
  capitalize: z.boolean().optional(),
});
type PrepaidBodyT = z.infer<typeof PrepaidBody>;

@Controller('api/ledger')
@Permissions('exec', 'creditors', 'ar')
export class LedgerController {
  constructor(private readonly svc: LedgerService) {}

  // Tenant's curated industry chart by default; `?all=true` returns the full canonical universe.
  @Get('accounts')
  accounts(@Query('all') all?: string) { return this.svc.listAccounts({ all: all === 'true' || all === '1' }); }

  // ── multi-ledger / multi-GAAP ──
  @Get('ledgers')
  ledgers() { return this.svc.listLedgers(); }

  // post a GAAP-divergent adjustment to ONE ledger (e.g. tax-depreciation delta)
  @Post('ledgers/:code/adjustment')
  @Permissions('gl_post', 'creditors', 'ar')
  adjustment(@Param('code') code: string, @Body(new ZodValidationPipe(JournalBody)) b: JournalBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.postAdjustment(code, { date: b.date, source: b.source ?? 'GAAP-ADJ', sourceRef: b.source_ref, tenantId: hqTenant(u, b.tenant_id) ?? null, currency: b.currency, memo: b.memo, lines: b.lines, createdBy: u.username, pendingApproval: true });
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

  // GL-05: a manual JE posts as DRAFT (pending) and does not affect balances until a DIFFERENT user
  // approves it (maker-checker). Posting is the 'gl_post' duty; approval is 'gl_close'/'approvals'.
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
      pendingApproval: true,
    });
  }

  // JEs awaiting maker-checker approval (Draft).
  @Get('journal/pending')
  @Permissions('gl_post', 'gl_close', 'approvals')
  pendingJournal(@Query('limit') limit?: string) { return this.svc.pendingJournal(qint('limit', limit, 50)); }

  // Approve / reject a pending JE — approver must differ from preparer (enforced in the service).
  @Post('journal/:entryNo/approve')
  @HttpCode(200)
  @Permissions('gl_close', 'approvals')
  approveJournal(@Param('entryNo') entryNo: string, @CurrentUser() u: JwtUser) { return this.svc.approveEntry(entryNo, u); }

  @Post('journal/:entryNo/reject')
  @HttpCode(200)
  @Permissions('gl_close', 'approvals')
  rejectJournal(@Param('entryNo') entryNo: string, @Body(new ZodValidationPipe(RejectBody)) b: z.infer<typeof RejectBody>, @CurrentUser() u: JwtUser) { return this.svc.rejectEntry(entryNo, u, b.reason); }

  // ── GL immutability + reversal (WS2.2, GL-17) ──
  // A Posted JE is immutable; corrections happen only via a contra reversal (a new, immediately-Posted entry
  // with every line's Dr/Cr swapped). :id is the numeric journal_entries.id.
  @Post('journal/:id/reverse')
  @HttpCode(200)
  @Permissions('gl_post')
  reverseJournal(@Param('id') id: string, @Body(new ZodValidationPipe(ReverseBody)) b: z.infer<typeof ReverseBody>, @CurrentUser() u: JwtUser) {
    return this.svc.reverseEntry({ entryId: parseInt(id, 10), reversedBy: u.username, reason: b.reason, date: b.date });
  }

  // Demonstrates the GL-17 immutability guard (for ops/tests): attempting to void/delete a posted entry is
  // refused with GL_IMMUTABLE and logged as MUTATE_BLOCKED. Posted entries are never editable/deletable.
  // The service returns a discriminated result so the MUTATE_BLOCKED audit row commits with the request tx
  // (a thrown exception would roll it back); we then render the block as HTTP 400 on the same committed reply.
  @Post('journal/:id/attempt-void')
  @Permissions('gl_post')
  async attemptVoid(@Param('id') id: string, @CurrentUser() u: JwtUser, @Res({ passthrough: true }) reply: FastifyReply) {
    const res = await this.svc.attemptVoidPosted(parseInt(id, 10), u.username);
    if (res.blocked) reply.code(400);
    return res.blocked ? { error: { code: res.code, message: res.message, messageTh: res.messageTh } } : res;
  }

  // The GL audit trail (POST/APPROVE/REVERSE/MUTATE_BLOCKED), optionally filtered to one entry.
  @Get('audit')
  @Permissions('gl_post', 'gl_close', 'exec')
  glAudit(@Query('entryId') entryId?: string, @Query('limit') limit?: string) {
    return this.svc.listGlAudit(entryId ? parseInt(entryId, 10) : undefined, qint('limit', limit, 100));
  }

  @Get('income-statement')
  incomeStatement(@Query('from') from: string, @Query('to') to: string, @Query('cost_center') costCenter?: string, @Query('ledger') ledger?: string) { return this.svc.incomeStatement(from, to, costCenter, ledger || undefined); }

  @Get('income-statement/by-branch')
  @Permissions('exec', 'fin_report', 'creditors', 'ar')
  incomeStatementByBranch(@Query('from') from: string, @Query('to') to: string) {
    return this.svc.incomeStatementByBranch({ from, to });
  }

  @Get('balance-sheet')
  balanceSheet(@Query('as_of') asOf: string, @Query('ledger') ledger?: string) { return this.svc.balanceSheet(asOf, ledger || undefined); }

  // Statement of Cash Flows (indirect method) over [from,to] — the third primary statement, reconstructed
  // from the GL/trial-balance data (no separate cash-flow ledger). Reconciles to the change in cash.
  @Get('cash-flow')
  cashFlow(@Query('from') from: string, @Query('to') to: string, @Query('ledger') ledger?: string) { return this.svc.cashFlowStatement(from, to, ledger || undefined); }

  // Statement of Cash Flows — DIRECT method (receipts/payments by nature). Also reconciles to Δcash.
  @Get('cash-flow-direct')
  cashFlowDirect(@Query('from') from: string, @Query('to') to: string, @Query('ledger') ledger?: string) { return this.svc.cashFlowDirect(from, to, ledger || undefined); }

  // Forward cash-flow forecast: project cash N weeks out from open AR (inflows) and AP (outflows) by due date.
  @Get('cash-flow-forecast')
  cashFlowForecast(@Query('weeks') weeks?: string, @Query('ledger') ledger?: string) { return this.svc.cashFlowForecast(weeks ? Math.max(1, Math.min(52, parseInt(weeks, 10) || 8)) : 8, ledger || undefined); }

  // ── Recurring / template journal entries (GL-08) ──
  // A balanced template + a cadence; the scheduler posts each due template as a DRAFT JE (maker-checker).
  @Post('recurring')
  @Permissions('gl_post', 'exec')
  createRecurring(@Body(new ZodValidationPipe(RecurringBody)) b: RecurringBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.createRecurring({ name: b.name, frequency: b.frequency, memo: b.memo, ledgerCode: b.ledger_code ?? null, currency: b.currency, tenantId: hqTenant(u, b.tenant_id) ?? null, startDate: b.start_date, lines: b.lines }, u);
  }

  @Get('recurring')
  @Permissions('gl_post', 'gl_close', 'exec')
  listRecurring(@Query('tenant_id') tenantId: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listRecurring(hqTenant(u, tenantId ? Number(tenantId) : undefined)); }

  // Activate / pause a template without deleting it (keeps the audit + history).
  @Post('recurring/:id/active')
  @HttpCode(200)
  @Permissions('gl_post', 'exec')
  setRecurringActive(@Param('id') id: string, @Body(new ZodValidationPipe(ActiveBody)) b: z.infer<typeof ActiveBody>) { return this.svc.setRecurringActive(parseInt(id, 10), b.active); }

  // Post every due template now (cron-callable; also rides the scheduler as `gl_recurring_journals`).
  @Post('recurring/run')
  @HttpCode(200)
  @Permissions('gl_post', 'exec')
  runRecurring(@CurrentUser() u: JwtUser) { return this.svc.runDueRecurring(u); }

  // ── Prepaid amortization schedules (GL-09) ──
  @Post('prepaid')
  @Permissions('gl_post', 'exec')
  createPrepaid(@Body(new ZodValidationPipe(PrepaidBody)) b: PrepaidBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.createPrepaid({ name: b.name, totalAmount: b.total_amount, months: b.months, expenseAccount: b.expense_account, prepaidAccount: b.prepaid_account, tenantId: hqTenant(u, b.tenant_id) ?? null, startDate: b.start_date, capitalize: b.capitalize }, u);
  }

  @Get('prepaid')
  @Permissions('gl_post', 'gl_close', 'exec')
  listPrepaid(@Query('tenant_id') tenantId: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listPrepaid(hqTenant(u, tenantId ? Number(tenantId) : undefined)); }

  @Post('prepaid/run')
  @HttpCode(200)
  @Permissions('gl_post', 'exec')
  runPrepaid(@CurrentUser() u: JwtUser) { return this.svc.runDuePrepaid(u); }

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
