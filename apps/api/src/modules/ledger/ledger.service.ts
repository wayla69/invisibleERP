import { Inject, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import type { JwtUser } from '../../common/decorators';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { accounts, journalEntries, ledgers, tenantAccounts } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';

import { assertTemplatesSubsetOf, isIndustryKey, COA_TEMPLATES, type IndustryKey, type CoaTemplateRow } from './coa-templates';
import { assertPostingEventDefaults } from './posting-events';
import { resolvePostingOverrides, resolvePostingAccountSet, resolvePostingOverridesMany } from './posting-overrides-cache';

import { LEADING, LEDGERS, COA } from './ledger-constants';
import { LedgerCashflowService } from './ledger-cashflow.service';
import { LedgerRecurringService } from './ledger-recurring.service';
import { LedgerAllocationService } from './ledger-allocation.service';
import { LedgerPostingService } from './ledger-posting.service';
import { LedgerReportingService, type DimensionFilter } from './ledger-reporting.service';
import { LedgerPeriodsService, resolveTenantId } from './ledger-periods.service';

export interface JournalLineDto { account_code: string; debit?: number; credit?: number; memo?: string; cost_center?: string | null; branch_id?: number | null; project_id?: number | null; dept_id?: number | null }

// FIN-7a — the dimension filter moved with the reports (docs/46 Phase 4e cut 1); re-exported so existing
// `import { DimensionFilter } from './ledger.service'` sites keep working.
export type { DimensionFilter } from './ledger-reporting.service';
export interface PostEntryDto {
  date?: string;
  source: string;
  sourceRef?: string;
  tenantId?: number | null;
  currency?: string;
  memo?: string;
  lines: JournalLineDto[];
  createdBy: string;
  ledgerCode?: string | null; // NULL/undefined = shared (all ledgers); a code = adjustment to that ledger only
  allowClosedPeriod?: boolean; // only the year-end CLOSE may post into the period it is closing
  pendingApproval?: boolean; // GL-05: post as DRAFT (excluded from balances) until a different user approves
  viaSubledger?: boolean; // WS1.1: set true by AR/AP/INV/FA service methods to allow posting to control accounts
  _reversalOf?: number | null; // GL-17 internal: set by reverseEntry so the contra entry records its origin
}

export interface RecurringJournalDto {
  name: string;
  frequency: string; // 'daily' | 'weekly' | 'monthly'
  memo?: string;
  ledgerCode?: string | null;
  currency?: string;
  tenantId?: number | null;
  startDate?: string; // first run date (YYYY-MM-DD); defaults to today
  // GL-08/GL-17 (docs/50 Wave 1 B2): auto-reverse the posted accrual in the next business month.
  // Monthly-frequency templates only (AUTO_REVERSE_MONTHLY_ONLY at create).
  autoReverse?: boolean;
  lines: JournalLineDto[];
}

export interface PrepaidDto {
  name: string;
  totalAmount: number;
  months: number;
  expenseAccount?: string;
  prepaidAccount?: string;
  tenantId?: number | null;
  startDate?: string;
  capitalize?: boolean; // also post Dr prepaid / Cr cash for the up-front payment
}

// FIN-7b — GL allocation engine (GL-23). A periodic cost-allocation cycle distributes a source pool by
// fixed ratio / measured driver / statistical key to a set of targets, posted as balanced DRAFT JEs on the
// recurring rail (maker-checker, GL-05). See LedgerAllocationService.
export interface AllocationTargetDto {
  target_account?: string | null; // NULL/omitted = the cycle's source_account (pure cost-center reallocation)
  cost_center?: string | null;
  basis: number; // weight (ratio method) / driver value / statistical-key value
  memo?: string;
}
export interface AllocationCycleDto {
  name: string;
  method: string; // 'ratio' | 'driver' | 'statistical'
  frequency: string; // 'daily' | 'weekly' | 'monthly'
  poolAmount: number;
  sourceAccount: string;
  sourceCostCenter?: string | null;
  ledgerCode?: string | null;
  currency?: string;
  memo?: string;
  tenantId?: number | null;
  startDate?: string; // first run date (YYYY-MM-DD); defaults to today
  targets: AllocationTargetDto[];
}

@Injectable()
export class LedgerService implements OnModuleInit {
  private readonly cashflow: LedgerCashflowService;
  private readonly recurring: LedgerRecurringService;
  private readonly allocation: LedgerAllocationService;
  private readonly posting: LedgerPostingService;
  private readonly reporting: LedgerReportingService;
  private readonly periods: LedgerPeriodsService;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {
    // docs/38 ledger PR-1: built in the ctor BODY (not DI) — harnesses construct this facade positionally
    // with (db, docNo), so sub-services must come from the injected deps. Shared read helpers arrive as
    // callback ports; the canonical aggregateByType/ledgerCond now live on the reporting sub-service.
    this.reporting = new LedgerReportingService(db, { assertLedger: (code) => this.assertLedger(code) });
    this.cashflow = new LedgerCashflowService(db, (d, from, to, cc, lc, tid, ex) => this.reporting.aggregateByType(d, from, to, cc, lc, tid, ex), (code) => this.reporting.ledgerCond(code));
    this.posting = new LedgerPostingService(db, docNo);
    this.recurring = new LedgerRecurringService(db, docNo, (dto) => this.postEntry(dto), (ev, tid) => this.postingOverrides(ev, tid));
    this.allocation = new LedgerAllocationService(db, docNo, (dto) => this.postEntry(dto));
    this.periods = new LedgerPeriodsService(db, {
      postEntry: (dto, outerTx) => this.postEntry(dto, outerTx),
      alreadyPosted: (source, sourceRef, tenantId) => this.alreadyPosted(source, sourceRef, tenantId),
      postingOverrides: (ev, tid) => this.postingOverrides(ev, tid),
      aggregateByType: (d, from, to, cc, lc, tid) => this.reporting.aggregateByType(d, from, to, cc, lc, tid),
    });
  }

  // Boot parity for EVERY embedding of the app module (prod main.ts and the ~120 injected harnesses):
  // postEntry's account-universe guard (GL-21, docs/42 step 1) needs the canonical chart present, so seed
  // it at module init. Best-effort like main.ts's seed loop — a not-yet-migrated DB skips silently and
  // the runner's own explicit seed (or main.ts's) covers it later. Idempotent (onConflictDoNothing).
  async onModuleInit() {
    try { await this.seedChartOfAccounts(); } catch { /* DB not ready — explicit seed runs later */ }
  }

  // ── docs/46 Phase 4e cut 3: GL-24 posting-rule override resolution + its hot-path cache live beside the
  // cache in posting-overrides-cache.ts (docs/42 step 4 / docs/43 PR-1); thin delegators keep the public
  // API here (callers resolve overrides through the ledger facade, PostingService owns the governance). ──
  async postingOverrides(eventType: string, tenantId?: number | null): Promise<Record<string, string>> { return resolvePostingOverrides(this.db, eventType, tenantId); }
  /** docs/43 PR-7: a reconciliation that reads a WIDENED role must sum the account SET
   *  {registry default} ∪ {approved tenant override} — so overriding the role never breaks the tie-out. */
  async postingAccountSet(eventType: string, role: string, tenantId?: number | null): Promise<string[]> { return resolvePostingAccountSet(this.db, eventType, role, tenantId); }
  async postingOverridesMany(eventTypes: string[], tenantId?: number | null): Promise<Record<string, Record<string, string>>> { return resolvePostingOverridesMany(this.db, eventTypes, tenantId); }

  // ───────────────────── Chart of Accounts ─────────────────────
  // idempotent seed — onConflictDoNothing บน accounts.code (unique)
  async seedChartOfAccounts() {
    // Fail fast at boot if any industry CoA template drifts from the canonical universe (unknown/dup code).
    assertTemplatesSubsetOf(COA.map((a) => a.code));
    // docs/43 PR-1: same fail-fast for the posting-event registry — every role default must be a real
    // canonical account, so a registry typo can never become a silent mis-posting fallback.
    assertPostingEventDefaults(COA.map((a) => a.code));
    const db = this.db;
    await db.insert(accounts).values(COA).onConflictDoNothing({ target: accounts.code });
    return { seeded: COA.length };
  }

  // Materialise an industry CoA template into a tenant's overlay (GL-10). 'general'/unknown ⇒ the full
  // canonical chart with canonical names. Idempotent + additive (never deletes) so it is safe to re-run
  // — adopting a richer pack later only adds the missing accounts. Canonical codes/types are authoritative;
  // the overlay only curates which accounts are visible and how they are named/grouped per tenant.
  async provisionTenantCoA(tenantId: number, industry?: string | null) {
    const db = this.db;
    const key: IndustryKey = isIndustryKey(industry) ? industry : 'general';
    // Canonical accounts are read from the DB (the authoritative universe — includes any account a
    // migration inserts beyond the COA constant), so 'general' mirrors the live chart exactly.
    const canon: any[] = await db.select().from(accounts).orderBy(accounts.code);
    const typeOf = new Map<string, string>(canon.map((a) => [a.code, a.type] as const));
    const rows: CoaTemplateRow[] =
      key === 'general' ? canon.map((a) => ({ code: a.code, name: a.name, nameTh: '' })) : COA_TEMPLATES[key];
    const values = rows.map((r, i) => ({
      tenantId,
      accountCode: r.code,
      displayName: r.name,
      displayNameTh: r.nameTh || null,
      groupLabel: typeOf.get(r.code) ?? null,
      active: true,
      sortOrder: i,
    }));
    if (values.length) {
      await db.insert(tenantAccounts).values(values).onConflictDoNothing({ target: [tenantAccounts.tenantId, tenantAccounts.accountCode] });
    }
    return { tenant_id: tenantId, industry: key, accounts: values.length };
  }

  // Tenant-aware Chart of Accounts. Default = the tenant's curated industry chart (active overlay rows,
  // industry names/order). `all=true` (or a tenant with no overlay, e.g. legacy/HQ) ⇒ the full canonical
  // universe (so a user can still post to any account outside their template). NEVER used to gate postings.
  async listAccounts(opts?: { all?: boolean; tenantId?: number | null; includeInactive?: boolean }) {
    const db = this.db;
    const tid = resolveTenantId(opts?.tenantId ?? null);
    const canon = await db.select().from(accounts).orderBy(accounts.code);
    if (opts?.all || tid == null) return { accounts: canon, count: canon.length, source: 'canonical' };
    const overlay = await db.select().from(tenantAccounts).where(eq(tenantAccounts.tenantId, tid));
    if (!overlay.length) return { accounts: canon, count: canon.length, source: 'canonical' };
    const byCode = new Map<string, any>(canon.map((a: any) => [a.code, a]));
    // The default read hides curated-off rows (presentation); `includeInactive` keeps them so a gl_coa
    // manager can see and re-activate an account they previously toggled off (GL-11 curation UI).
    const merged = overlay
      .filter((o: any) => opts?.includeInactive || o.active !== false)
      .map((o: any) => {
        const a = byCode.get(o.accountCode);
        return {
          code: o.accountCode,
          name: o.displayName || a?.name || o.accountCode,
          name_th: o.displayNameTh ?? null,
          type: a?.type ?? null,
          parentCode: a?.parentCode ?? null,
          group_label: o.groupLabel ?? a?.type ?? null,
          currency: a?.currency ?? 'THB',
          active: o.active !== false,
          sort_order: Number(o.sortOrder ?? 0),
        };
      })
      .sort((x: any, y: any) => x.sort_order - y.sort_order || x.code.localeCompare(y.code));
    return { accounts: merged, count: merged.length, source: 'overlay', industry_scoped: true };
  }

  // ───────────────────── Ledgers (multi-GAAP) ─────────────────────
  // idempotent seed of the parallel ledgers (TFRS leading + TAX + IFRS).
  async seedLedgers() {
    const db = this.db;
    await db.insert(ledgers).values(LEDGERS).onConflictDoNothing({ target: ledgers.code });
    return { seeded: LEDGERS.length };
  }

  async listLedgers() {
    const db = this.db;
    const rows = await db.select().from(ledgers).orderBy(desc(ledgers.isLeading), ledgers.code);
    return { ledgers: rows.map((l: any) => ({ code: l.code, name: l.name, gaap: l.gaap, is_leading: !!l.isLeading, currency: l.currency, description: l.description, active: l.active })), count: rows.length, leading: LEADING };
  }

  // assert a ledger exists + is a real (non-shared) ledger for adjustment postings
  private async assertLedger(code: string) {
    const db = this.db;
    const [l] = await db.select().from(ledgers).where(eq(ledgers.code, code)).limit(1);
    if (!l) throw new NotFoundException({ code: 'LEDGER_NOT_FOUND', message: `Ledger ${code} not found`, messageTh: `ไม่พบสมุดบัญชี ${code}` });
    return l;
  }

  // ── docs/38 ledger PR-3: posting core (GL-05 balanced-by-construction + period gates + snapshot bump) lives in LedgerPostingService. ──
  async postEntry(dto: PostEntryDto, outerTx?: any) { return this.posting.postEntry(dto, outerTx); }

  // ── docs/38 ledger PR-2: recurring (GL-08) + prepaid (GL-09) live in LedgerRecurringService; thin delegators. ──
  async createRecurring(dto: RecurringJournalDto, user: JwtUser) { return this.recurring.createRecurring(dto, user); }
  async listRecurring(tenantId?: number) { return this.recurring.listRecurring(tenantId); }
  async setRecurringActive(id: number, active: boolean) { return this.recurring.setRecurringActive(id, active); }
  async runDueRecurring(user: JwtUser) { return this.recurring.runDueRecurring(user); }
  async createPrepaid(dto: PrepaidDto, user: JwtUser) { return this.recurring.createPrepaid(dto, user); }
  async listPrepaid(tenantId?: number) { return this.recurring.listPrepaid(tenantId); }
  async runDuePrepaid(user: JwtUser) { return this.recurring.runDuePrepaid(user); }

  // ── FIN-7b: GL allocation engine (GL-23) lives in LedgerAllocationService; thin delegators. ──
  async createAllocationCycle(dto: AllocationCycleDto, user: JwtUser) { return this.allocation.createCycle(dto, user); }
  async listAllocationCycles(tenantId?: number) { return this.allocation.listCycles(tenantId); }
  async setAllocationCycleActive(id: number, active: boolean) { return this.allocation.setCycleActive(id, active); }
  async runDueAllocations(user: JwtUser) { return this.allocation.runDueAllocations(user); }

  // ── docs/38 ledger PR-3: journal listings, GL-05 approve/reject, GL-17 reversal/immutability/audit — LedgerPostingService delegators. ──
  async listJournal(limit: number) { return this.posting.listJournal(limit); }
  async pendingJournal(limit: number) { return this.posting.pendingJournal(limit); }
  async approveEntry(entryNo: string, approver: JwtUser, selfApprovalReason?: string | null) { return this.posting.approveEntry(entryNo, approver, selfApprovalReason); }
  async rejectEntry(entryNo: string, approver: JwtUser, reason?: string) { return this.posting.rejectEntry(entryNo, approver, reason); }
  async reverseEntry(dto: { entryId: number; reversedBy: string; reason?: string; date?: string; requireDistinctApprover?: boolean }, user: JwtUser, selfApprovalReason?: string | null) { return this.posting.reverseEntry(dto, user, selfApprovalReason); }
  async attemptVoidPosted(entryId: number, actor: string) { return this.posting.attemptVoidPosted(entryId, actor); }
  async listGlAudit(entryId?: number, limit = 100) { return this.posting.listGlAudit(entryId, limit); }

  // ── docs/46 Phase 4e cut 1: GL reporting reads (TB / GL-detail / dimensions / IS / BS / per-account FS net)
  // live in LedgerReportingService (which also owns the canonical aggregateByType engine); thin delegators. ──
  async trialBalance(period?: string, costCenter?: string | null, ledgerCode?: string | null, dims?: DimensionFilter) { return this.reporting.trialBalance(period, costCenter, ledgerCode, dims); }
  async accountLedger(accountCode: string, from?: string | null, to?: string | null, ledgerCode?: string | null, dims?: DimensionFilter) { return this.reporting.accountLedger(accountCode, from, to, ledgerCode, dims); }
  async listDimensions() { return this.reporting.listDimensions(); }
  async incomeStatement(from: string, to: string, costCenter?: string | null, ledgerCode?: string | null, excludeSources?: string[], dims?: DimensionFilter) { return this.reporting.incomeStatement(from, to, costCenter, ledgerCode, excludeSources, dims); }
  async incomeStatementByBranch(opts: { from: string; to: string }) { return this.reporting.incomeStatementByBranch(opts); }
  async balanceSheet(asOf: string, ledgerCode?: string | null) { return this.reporting.balanceSheet(asOf, ledgerCode); }
  async perAccountNet(to: string, from?: string | null, ledgerCode?: string | null, excludeSources?: string[]) { return this.reporting.perAccountNet(to, from, ledgerCode, excludeSources); }

  // ── docs/38 ledger PR-1: cash-flow statements/forecast (GL-07) live in LedgerCashflowService; thin delegators. ──
  async cashFlowStatement(from: string, to: string, ledgerCode?: string | null) { return this.cashflow.cashFlowStatement(from, to, ledgerCode); }
  async cashFlowDirect(from: string, to: string, ledgerCode?: string | null) { return this.cashflow.cashFlowDirect(from, to, ledgerCode); }
  async cashFlowForecast(weeks = 8, ledgerCode?: string | null) { return this.cashflow.cashFlowForecast(weeks, ledgerCode); }

  // ───────────────────── GAAP adjustment posting ─────────────────────
  // Post a balanced entry to ONE ledger only (e.g. a tax-depreciation delta, an IFRS lease adjustment).
  // The shared books are untouched; only this ledger's reports pick it up.
  async postAdjustment(ledgerCode: string, dto: Omit<PostEntryDto, 'ledgerCode'>) {
    await this.assertLedger(ledgerCode);
    return this.postEntry({ ...dto, ledgerCode, source: dto.source ?? 'GAAP-ADJ' });
  }

  // Book-tax difference (ผลต่างทางบัญชี-ภาษี) — LedgerReportingService delegator (docs/46 Phase 4e cut 1).
  async gaapComparison(from: string, to: string, base = LEADING, compare = 'TAX') { return this.reporting.gaapComparison(from, to, base, compare); }

  // ───────────────────── Idempotency + Fiscal periods ─────────────────────
  // has a GL entry already been posted for this source+ref? (used by AR/AP hooks + closeYear)
  // tenantId scopes the check so two tenants can share a ref (e.g. 'FY2026') without colliding.
  async alreadyPosted(source: string, sourceRef: string, tenantId?: number | null, outerTx?: any): Promise<boolean> {
    const db = (outerTx ?? this.db) as any;
    const conds = [eq(journalEntries.source, source), eq(journalEntries.sourceRef, sourceRef)];
    if (tenantId !== undefined && tenantId !== null) conds.push(eq(journalEntries.tenantId, tenantId));
    const [r] = await db.select({ id: journalEntries.id }).from(journalEntries).where(and(...conds)).limit(1);
    return !!r;
  }

  // ── docs/46 Phase 4e cut 2: fiscal periods + close lifecycle (per-tenant calendar, period/year close,
  // opening-balance cutover, TFRS-15 loyalty accrual) live in LedgerPeriodsService; thin delegators. ──
  async ensurePeriod(period: string, tenantId?: number | null) { return this.periods.ensurePeriod(period, tenantId); }
  async listPeriods(tenantId?: number | null) { return this.periods.listPeriods(tenantId); }
  async setPeriodStatus(period: string, status: 'Open' | 'Closed', tenantId?: number | null) { return this.periods.setPeriodStatus(period, status, tenantId); }
  async accrueLiability(ctx: { tenantId: number; createdBy: string; asOfDate?: string }) { return this.periods.accrueLiability(ctx); }
  async closePeriod(period: string, tenantId?: number | null, opts?: { accrue?: boolean }) { return this.periods.closePeriod(period, tenantId, opts); }
  async openPeriod(period: string, tenantId?: number | null) { return this.periods.openPeriod(period, tenantId); }
  async provisionFiscalYear(year: number, tenantId: number) { return this.periods.provisionFiscalYear(year, tenantId); }
  async postOpeningBalances(rows: { account_code: string; debit?: number; credit?: number }[], batchRef: string | undefined, createdBy: string, tenantId?: number | null) { return this.periods.postOpeningBalances(rows, batchRef, createdBy, tenantId); }
  async closeYear(fiscalYear: number, createdBy: string, ledgerCode: string = LEADING, tenantId?: number | null) { return this.periods.closeYear(fiscalYear, createdBy, ledgerCode, tenantId); }
}
