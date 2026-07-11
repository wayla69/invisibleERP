import { Inject, Injectable, BadRequestException, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { sql, eq, and, desc, notInArray, gt, lte, inArray, isNotNull } from 'drizzle-orm';
import type { JwtUser } from '../../common/decorators';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { accounts, journalEntries, journalLines, fiscalPeriods, ledgers, posMembers, posMemberLedger, loyaltyConfig, loyaltyPostingRuns, tenantAccounts, glPeriodBalances, branches, projects, departments, postingRules } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { currentTenantStore } from '../../common/tenant-context';
import { ymd, n } from '../../database/queries';
import { toMinor4, minorToNumber4 } from '../../common/money';
import { assertTemplatesSubsetOf, isIndustryKey, COA_TEMPLATES, type IndustryKey, type CoaTemplateRow } from './coa-templates';
import { assertPostingEventDefaults, postingDefault } from './posting-events';
import { postingOverridesCache, postingOverridesKey, POSTING_OVERRIDES_TTL_MS } from './posting-overrides-cache';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// Resolve the tenant a period/close operation belongs to: explicit arg wins, else the request's
// own tenant (the interceptor's ALS). null only when called outside any request (bootstrap/seed).
function resolveTenantId(explicit?: number | null): number | null {
  if (explicit !== undefined && explicit !== null) return explicit;
  return currentTenantStore()?.tenantId ?? null;
}

import { LEADING, LEDGERS, COA } from './ledger-constants';
import { LedgerCashflowService } from './ledger-cashflow.service';
import { LedgerRecurringService } from './ledger-recurring.service';
import { LedgerAllocationService } from './ledger-allocation.service';
import { LedgerPostingService } from './ledger-posting.service';

export interface JournalLineDto { account_code: string; debit?: number; credit?: number; memo?: string; cost_center?: string | null; branch_id?: number | null; project_id?: number | null; dept_id?: number | null }

// FIN-7a — dimension filter for TB / account-ledger / income statement. All fields optional; when NONE
// is set the reports keep their original (snapshot / unfiltered) paths byte-identically.
export interface DimensionFilter { projectId?: number; deptId?: number; branchId?: number }
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

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {
    // docs/38 ledger PR-1: built in the ctor BODY (not DI) — harnesses construct this facade positionally
    // with (db, docNo), so sub-services must come from the injected deps. Shared read helpers stay here
    // and are passed as callback ports.
    this.cashflow = new LedgerCashflowService(db, (d, from, to, cc, lc, tid, ex) => this.aggregateByType(d, from, to, cc, lc, tid, ex), (code) => this.ledgerCond(code));
    this.posting = new LedgerPostingService(db, docNo);
    this.recurring = new LedgerRecurringService(db, docNo, (dto) => this.postEntry(dto), (ev, tid) => this.postingOverrides(ev, tid));
    this.allocation = new LedgerAllocationService(db, docNo, (dto) => this.postEntry(dto));
  }

  // Boot parity for EVERY embedding of the app module (prod main.ts and the ~120 injected harnesses):
  // postEntry's account-universe guard (GL-21, docs/42 step 1) needs the canonical chart present, so seed
  // it at module init. Best-effort like main.ts's seed loop — a not-yet-migrated DB skips silently and
  // the runner's own explicit seed (or main.ts's) covers it later. Idempotent (onConflictDoNothing).
  async onModuleInit() {
    try { await this.seedChartOfAccounts(); } catch { /* DB not ready — explicit seed runs later */ }
  }

  // ───────────────────── Posting-rule account overrides (docs/42 step 4) ─────────────────────
  // A tenant's ACTIVE posting_rules rows (event_type + role — maintained on /setup/posting-rules) re-map
  // where a recurring system posting lands, per company, WITHOUT a code change. Only TENANT-scoped rows
  // apply: the NULL-tenant rows seeded by 0158 are display defaults that pre-date the real posting paths
  // (some drift from the literals — e.g. PAYROLL.GROSS's seed credits AP 2000 while payroll actually pays
  // cash 1000), so they must never shadow the code. Callers keep their literal as the fallback: no
  // override ⇒ byte-identical behaviour (parity). A typo'd override account is caught fail-closed by
  // postEntry's account-universe guard (INVALID_POSTING_ACCOUNT), never posted.
  async postingOverrides(eventType: string, tenantId?: number | null): Promise<Record<string, string>> {
    const tid = tenantId ?? currentTenantStore()?.tenantId ?? null;
    if (tid == null) return {};
    // GL-24 + hot-path cache (docs/43 PR-1): only ACTIVE + APPROVED rules apply; the per-tenant 5s
    // TtlCache (bust-on-approve in PostingService) keeps POS-frequency callers off the DB.
    return postingOverridesCache.wrap(postingOverridesKey(tid, eventType), POSTING_OVERRIDES_TTL_MS, async () => {
      const rows = await this.db
        .select({ role: postingRules.role, accountCode: postingRules.accountCode })
        .from(postingRules)
        .where(and(
          eq(postingRules.eventType, eventType),
          eq(postingRules.tenantId, tid),
          eq(postingRules.active, true),
          eq(postingRules.status, 'Approved'),
        ));
      const out: Record<string, string> = {};
      for (const r of rows) if (r.accountCode) out[r.role] = r.accountCode;
      return out;
    });
  }

  // Batch resolve several events in one call (one query on cache miss) — a POS sale resolves its whole
  // SALE/POS event set with a single lookup instead of N sequential awaits (docs/43 PR-1).
  async postingOverridesMany(eventTypes: string[], tenantId?: number | null): Promise<Record<string, Record<string, string>>> {
    const tid = tenantId ?? currentTenantStore()?.tenantId ?? null;
    const out: Record<string, Record<string, string>> = {};
    for (const ev of eventTypes) out[ev] = {};
    if (tid == null || !eventTypes.length) return out;
    // serve whatever is cached; fetch the misses in ONE query
    const misses: string[] = [];
    for (const ev of eventTypes) {
      const hit = postingOverridesCache.get<Record<string, string>>(postingOverridesKey(tid, ev));
      if (hit !== undefined) out[ev] = hit; else misses.push(ev);
    }
    if (misses.length) {
      const rows = await this.db
        .select({ eventType: postingRules.eventType, role: postingRules.role, accountCode: postingRules.accountCode })
        .from(postingRules)
        .where(and(
          inArray(postingRules.eventType, misses),
          eq(postingRules.tenantId, tid),
          eq(postingRules.active, true),
          eq(postingRules.status, 'Approved'),
        ));
      for (const r of rows) if (r.accountCode) (out[r.eventType] ??= {})[r.role] = r.accountCode;
      for (const ev of misses) postingOverridesCache.set(postingOverridesKey(tid, ev), out[ev] ?? {}, POSTING_OVERRIDES_TTL_MS);
    }
    return out;
  }

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

  // SQL predicate selecting the rows that belong to ledger `code` = shared (NULL) OR that ledger's own
  // adjustments. Defaults to the LEADING book so existing (all-NULL) data + callers are unchanged.
  private ledgerCond(code?: string | null) {
    const c = code ?? LEADING;
    return sql`(${journalEntries.ledgerCode} IS NULL OR ${journalEntries.ledgerCode} = ${c})`;
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
  async approveEntry(entryNo: string, approver: JwtUser) { return this.posting.approveEntry(entryNo, approver); }
  async rejectEntry(entryNo: string, approver: JwtUser, reason?: string) { return this.posting.rejectEntry(entryNo, approver, reason); }
  async reverseEntry(dto: { entryId: number; reversedBy: string; reason?: string; date?: string; requireDistinctApprover?: boolean }) { return this.posting.reverseEntry(dto); }
  async attemptVoidPosted(entryId: number, actor: string) { return this.posting.attemptVoidPosted(entryId, actor); }
  async listGlAudit(entryId?: number, limit = 100) { return this.posting.listGlAudit(entryId, limit); }

  // FIN-7a: true when any project/dept/branch dimension filter is set (undefined/empty ⇒ legacy paths).
  private hasDims(dims?: DimensionFilter): boolean {
    return !!dims && (dims.projectId !== undefined || dims.deptId !== undefined || dims.branchId !== undefined);
  }

  // FIN-7a: typed-builder conditions for the journal_lines dimension columns (never raw sql — the ids come
  // straight from query params; eq() binds them, so there is no injection sink for CodeQL to flag).
  private dimConds(dims?: DimensionFilter): any[] {
    const conds: any[] = [];
    if (dims?.projectId !== undefined) conds.push(eq(journalLines.projectId, dims.projectId));
    if (dims?.deptId !== undefined) conds.push(eq(journalLines.departmentId, dims.deptId));
    if (dims?.branchId !== undefined) conds.push(eq(journalLines.branchId, dims.branchId));
    return conds;
  }

  // ───────────────────── Trial Balance ─────────────────────
  // group journal_lines by account_code (joined to accounts) — Σdebit, Σcredit, balance
  async trialBalance(period?: string, costCenter?: string | null, ledgerCode?: string | null, dims?: DimensionFilter) {
    const db = this.db;
    // FIN-7a: dimension-filtered TB (project/dept/branch) aggregates from the journal LINES — the
    // gl_period_balances snapshot is keyed by cost-center only and cannot answer a project/dept/branch
    // slice. Same semantics as the snapshot path: Posted-only, ledger NULL-or-code, per-period (entries
    // stamp `period` = entry_date 'YYYY-MM', identical to the snapshot key), per-cost-center; RLS scopes
    // the tenant. With no dimension filter the snapshot path below runs unchanged (byte-identical output).
    if (this.hasDims(dims)) {
      const lconds: any[] = [eq(journalEntries.status, 'Posted'), this.ledgerCond(ledgerCode), ...this.dimConds(dims)];
      if (period) lconds.push(eq(journalEntries.period, period));
      if (costCenter === '__UNASSIGNED__') lconds.push(sql`${journalLines.costCenterCode} IS NULL`);
      else if (costCenter) lconds.push(eq(journalLines.costCenterCode, costCenter));
      const lrows = await db
        .select({
          account_code: journalLines.accountCode,
          account_name: accounts.name,
          account_type: accounts.type,
          debit: sql<string>`coalesce(sum(${journalLines.debit}),0)`,
          credit: sql<string>`coalesce(sum(${journalLines.credit}),0)`,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
        .leftJoin(accounts, eq(journalLines.accountCode, accounts.code))
        .where(and(...lconds))
        .groupBy(journalLines.accountCode, accounts.name, accounts.type)
        .orderBy(journalLines.accountCode);
      const lout = lrows.map((r: any) => {
        const debit = round4(n(r.debit));
        const credit = round4(n(r.credit));
        return { account_code: r.account_code, account_name: r.account_name, account_type: r.account_type, debit, credit, balance: round4(debit - credit) };
      });
      const dM = lrows.reduce((a: bigint, r: any) => a + toMinor4(r.debit), 0n);
      const cM = lrows.reduce((a: bigint, r: any) => a + toMinor4(r.credit), 0n);
      return {
        period: period ?? null, cost_center: costCenter ?? null, ledger: ledgerCode ?? LEADING,
        project_id: dims?.projectId ?? null, dept_id: dims?.deptId ?? null, branch_id: dims?.branchId ?? null,
        rows: lout, totals: { debit: minorToNumber4(dM), credit: minorToNumber4(cM), balanced: dM === cM },
      };
    }
    // R1-2 (AUD-ARC-02): read the maintained gl_period_balances snapshot instead of aggregating the full
    // journal_lines table per request. Same filters/semantics: Posted-only (the snapshot holds nothing
    // else), ledger NULL-or-code ('' = NULL in the normalized key), per-period, per-cost-center; RLS
    // scopes tenants exactly as the raw scan did. GL-20 reconciles snapshot↔raw at every close.
    const conds: any[] = [inArray(glPeriodBalances.ledgerCode, ['', ledgerCode ?? LEADING])];
    if (period) conds.push(eq(glPeriodBalances.period, period));
    if (costCenter === '__UNASSIGNED__') conds.push(eq(glPeriodBalances.costCenterCode, ''));
    else if (costCenter) conds.push(eq(glPeriodBalances.costCenterCode, costCenter));
    const rows = await db
      .select({
        account_code: glPeriodBalances.accountCode,
        account_name: accounts.name,
        account_type: accounts.type,
        debit: sql<string>`coalesce(sum(${glPeriodBalances.debit}),0)`,
        credit: sql<string>`coalesce(sum(${glPeriodBalances.credit}),0)`,
      })
      .from(glPeriodBalances)
      .leftJoin(accounts, eq(glPeriodBalances.accountCode, accounts.code))
      .where(and(...conds))
      .groupBy(glPeriodBalances.accountCode, accounts.name, accounts.type)
      .orderBy(glPeriodBalances.accountCode);

    const out = rows.map((r: any) => {
      const debit = round4(n(r.debit));
      const credit = round4(n(r.credit));
      return { account_code: r.account_code, account_name: r.account_name, account_type: r.account_type, debit, credit, balance: round4(debit - credit) };
    });
    // Totals from the raw SQL numeric strings in bigint minor units — exact, order-independent (R1-4).
    const totalDebitM = rows.reduce((a: bigint, r: any) => a + toMinor4(r.debit), 0n);
    const totalCreditM = rows.reduce((a: bigint, r: any) => a + toMinor4(r.credit), 0n);
    return { period: period ?? null, cost_center: costCenter ?? null, ledger: ledgerCode ?? LEADING, rows: out, totals: { debit: minorToNumber4(totalDebitM), credit: minorToNumber4(totalCreditM), balanced: totalDebitM === totalCreditM } };
  }

  // ───────────────────── Account ledger (GL detail / บัญชีแยกประเภทรายบัญชี) ─────────────────────
  // Every POSTED journal line for ONE account over [from,to], in date order, with a running balance struck
  // from the opening balance (Σ debit−credit strictly before `from`). Debit-positive running balance — the
  // classic GL-detail drill-down behind the trial balance. Reads the raw ledger (RLS scopes the tenant).
  async accountLedger(accountCode: string, from?: string | null, to?: string | null, ledgerCode?: string | null, dims?: DimensionFilter) {
    const db = this.db;
    const [account] = await db.select({ code: accounts.code, name: accounts.name, type: accounts.type })
      .from(accounts).where(eq(accounts.code, accountCode)).limit(1);
    if (!account) throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND', message: `Account ${accountCode} not found`, messageTh: `ไม่พบบัญชี ${accountCode}` });

    // FIN-7a: the optional project/dept/branch filter narrows BOTH the opening balance and the lines to
    // the dimension slice (the running/closing balance is then the slice's own, tying to the filtered TB).
    const dconds = this.dimConds(dims);

    // Opening balance = Σ(debit − credit) of POSTED lines on this account strictly before `from`.
    let opening = 0;
    if (from) {
      const [o] = await db
        .select({ net: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}),0)` })
        .from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
        .where(and(eq(journalEntries.status, 'Posted'), eq(journalLines.accountCode, accountCode), this.ledgerCond(ledgerCode), sql`${journalEntries.entryDate} < ${from}`, ...dconds));
      opening = round4(n(o?.net));
    }

    const conds: any[] = [eq(journalEntries.status, 'Posted'), eq(journalLines.accountCode, accountCode), this.ledgerCond(ledgerCode), ...dconds];
    if (from) conds.push(sql`${journalEntries.entryDate} >= ${from}`);
    if (to) conds.push(sql`${journalEntries.entryDate} <= ${to}`);
    const rows = await db
      .select({
        line_id: journalLines.id,
        date: journalEntries.entryDate,
        entry_no: journalEntries.entryNo,
        source: journalEntries.source,
        source_ref: journalEntries.sourceRef,
        memo: sql<string>`coalesce(${journalLines.memo}, ${journalEntries.memo})`,
        cost_center: journalLines.costCenterCode,
        debit: journalLines.debit,
        credit: journalLines.credit,
      })
      .from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(...conds))
      .orderBy(journalEntries.entryDate, journalLines.id);

    let bal = opening, totalDebit = 0, totalCredit = 0;
    const lines = rows.map((r: any) => {
      const debit = round4(n(r.debit)), credit = round4(n(r.credit));
      bal = round4(bal + debit - credit);
      totalDebit = round4(totalDebit + debit);
      totalCredit = round4(totalCredit + credit);
      return { date: r.date, entry_no: r.entry_no, source: r.source, source_ref: r.source_ref, memo: r.memo, cost_center: r.cost_center, debit, credit, balance: bal };
    });
    return {
      account_code: account.code, account_name: account.name, account_type: account.type,
      from: from ?? null, to: to ?? null, ledger: ledgerCode ?? LEADING,
      // FIN-7a: echo the dimension filter ONLY when one was given — the unfiltered response shape stays
      // byte-identical to before (golden-master pinned).
      ...(this.hasDims(dims) ? { project_id: dims?.projectId ?? null, dept_id: dims?.deptId ?? null, branch_id: dims?.branchId ?? null } : {}),
      opening_balance: opening, total_debit: totalDebit, total_credit: totalCredit, closing_balance: bal,
      count: lines.length, lines,
    };
  }

  // ───────────────────── In-use reporting dimensions (FIN-7a) ─────────────────────
  // Distinct dimension values actually carried by journal LINES (RLS scopes the tenant), joined to their
  // masters for display labels — feeds the TB / GL-detail / P&L filter dropdowns. Read-only; a dimension
  // appears only once it has at least one posted/draft line, so the dropdowns never offer an empty slice.
  async listDimensions() {
    const db = this.db;
    const ccRows = await db
      .selectDistinct({ code: journalLines.costCenterCode })
      .from(journalLines)
      .where(isNotNull(journalLines.costCenterCode))
      .orderBy(journalLines.costCenterCode);
    const brRows = await db
      .selectDistinct({ id: journalLines.branchId, code: branches.code, name: branches.name })
      .from(journalLines)
      .leftJoin(branches, eq(journalLines.branchId, branches.id))
      .where(isNotNull(journalLines.branchId))
      .orderBy(journalLines.branchId);
    const pjRows = await db
      .selectDistinct({ id: journalLines.projectId, code: projects.projectCode, name: projects.name })
      .from(journalLines)
      .leftJoin(projects, eq(journalLines.projectId, projects.id))
      .where(isNotNull(journalLines.projectId))
      .orderBy(journalLines.projectId);
    const dpRows = await db
      .selectDistinct({ id: journalLines.departmentId, code: departments.code, name: departments.name })
      .from(journalLines)
      .leftJoin(departments, eq(journalLines.departmentId, departments.id))
      .where(isNotNull(journalLines.departmentId))
      .orderBy(journalLines.departmentId);
    const shape = (r: any) => ({ id: Number(r.id), code: r.code ?? null, name: r.name ?? null });
    return {
      cost_centers: ccRows.map((r: any) => r.code),
      branches: brRows.map(shape),
      projects: pjRows.map(shape),
      departments: dpRows.map(shape),
    };
  }

  // ───────────────────── Income Statement ─────────────────────
  // Revenue − Expense = net income, over [from,to] (entry_date inclusive)
  // excludeSources lets a trailing-twelve-month P&L (finance-metrics TTM basis) pass ['CLOSE'] so a window
  // that crosses a fiscal year-end is not understated by the close-out entries that zero P&L into 3100.
  async incomeStatement(from: string, to: string, costCenter?: string | null, ledgerCode?: string | null, excludeSources?: string[], dims?: DimensionFilter) {
    const db = this.db;
    const rows = await this.aggregateByType(db, from, to, costCenter, ledgerCode, undefined, excludeSources, dims);
    const revenue = round4(typeTotal(rows, 'Revenue', 'credit') - typeTotal(rows, 'Revenue', 'debit'));
    const expense = round4(typeTotal(rows, 'Expense', 'debit') - typeTotal(rows, 'Expense', 'credit'));
    const netIncome = round4(revenue - expense);
    return {
      from, to, cost_center: costCenter ?? null, ledger: ledgerCode ?? LEADING,
      // FIN-7a: dimension-filter echo only when a filter was given (default response unchanged).
      ...(this.hasDims(dims) ? { project_id: dims?.projectId ?? null, dept_id: dims?.deptId ?? null, branch_id: dims?.branchId ?? null } : {}),
      revenue, expense, net_income: netIncome,
      lines: rows.filter((r: any) => r.account_type === 'Revenue' || r.account_type === 'Expense'),
    };
  }

  async incomeStatementByBranch(opts: { from: string; to: string }) {
    const db = this.db;
    const { from, to } = opts;
    const tenantId = currentTenantStore()?.tenantId ?? null;

    const conds: any[] = [
      eq(journalEntries.status, 'Posted'),
      sql`${journalEntries.entryDate} >= ${from}`,
      sql`${journalEntries.entryDate} <= ${to}`,
      inArray(accounts.type, ['Revenue', 'Expense']),
    ];
    if (tenantId !== null) conds.push(eq(journalEntries.tenantId, tenantId));

    const rows = await db
      .select({
        branch_id: journalLines.branchId,
        account_code: journalLines.accountCode,
        type: accounts.type,
        name: accounts.name,
        net: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .leftJoin(accounts, eq(journalLines.accountCode, accounts.code))
      .where(and(...conds))
      .groupBy(journalLines.branchId, journalLines.accountCode, accounts.type, accounts.name)
      .orderBy(journalLines.accountCode);

    const byBranch: Record<string, { revenue: number; expense: number; net: number; lines: any[] }> = {};
    for (const r of rows) {
      const key = r.branch_id?.toString() ?? 'unassigned';
      if (!byBranch[key]) byBranch[key] = { revenue: 0, expense: 0, net: 0, lines: [] };
      const net = Number(r.net ?? 0);
      if (r.type === 'Revenue') byBranch[key].revenue += -net;
      else byBranch[key].expense += net;
      byBranch[key].lines.push({ account: r.account_code, name: r.name, type: r.type, net });
    }

    for (const b of Object.values(byBranch)) {
      b.net = b.revenue - b.expense;
    }

    return { period: { from, to }, branches: byBranch };
  }

  // ───────────────────── Balance Sheet ─────────────────────
  // Assets = Liabilities + Equity + retained net income (as of date, inclusive)
  async balanceSheet(asOf: string, ledgerCode?: string | null) {
    const db = this.db;
    const rows = await this.aggregateByType(db, null, asOf, undefined, ledgerCode);
    // Exact minor-unit arithmetic (docs/27 R1-4): the balanced flag compares bigints, not rounded floats.
    const assetsM = typeTotalM(rows, 'Asset', 'debit') - typeTotalM(rows, 'Asset', 'credit');
    const liabilitiesM = typeTotalM(rows, 'Liability', 'credit') - typeTotalM(rows, 'Liability', 'debit');
    // equity INCLUDES 3100 Retained Earnings (closed-year results carried here by closeYear)
    const equityM = typeTotalM(rows, 'Equity', 'credit') - typeTotalM(rows, 'Equity', 'debit');
    // current UNCLOSED-period P&L still sits in Revenue/Expense (closed years were zeroed into 3100)
    const netIncomeM =
      (typeTotalM(rows, 'Revenue', 'credit') - typeTotalM(rows, 'Revenue', 'debit')) -
      (typeTotalM(rows, 'Expense', 'debit') - typeTotalM(rows, 'Expense', 'credit'));
    // retained_earnings is a DISPLAY sub-total of equity (the 3100 balance) — not added again
    const retainedEarningsM = rows.filter((r: any) => r.account_code === '3100').reduce((a: bigint, r: any) => a + (toMinor4(r.credit) - toMinor4(r.debit)), 0n);
    const liabilitiesEquityM = liabilitiesM + equityM + netIncomeM;
    // Per-account section lines (additive — existing callers read only the totals). Signed by normal balance:
    // Assets are debit-positive; Liabilities/Equity are credit-positive. Current-period P&L stays out of the
    // lines (it is surfaced as the `net_income` sub-total, conventionally shown under equity by the client).
    const lines = rows
      .filter((r: any) => r.account_type === 'Asset' || r.account_type === 'Liability' || r.account_type === 'Equity')
      .map((r: any) => ({
        account_code: r.account_code,
        account_name: r.account_name,
        account_type: r.account_type,
        balance: round4(r.account_type === 'Asset' ? r.debit - r.credit : r.credit - r.debit),
      }))
      .filter((r: any) => Math.abs(r.balance) > 1e-9);
    return {
      as_of: asOf, ledger: ledgerCode ?? LEADING,
      assets: minorToNumber4(assetsM), liabilities: minorToNumber4(liabilitiesM), equity: minorToNumber4(equityM),
      retained_earnings: minorToNumber4(retainedEarningsM), net_income: minorToNumber4(netIncomeM),
      liabilities_plus_equity: minorToNumber4(liabilitiesEquityM),
      balanced: assetsM === liabilitiesEquityM,
      lines,
    };
  }

  // ───────────────────── Per-account signed net (FIN-4 statutory FS builder) ─────────────────────
  // Σ(debit − credit) per account, joined to type/name. `from == null` ⇒ cumulative to `to` (balance-sheet
  // basis); a `from` scopes it to [from,to] (P&L basis). Reuses the CANONICAL aggregateByType engine (Posted
  // only, ledger NULL-or-code, RLS-scoped) so the statutory FS pack never re-derives balances — it is a pure
  // presentation layer over the same numbers the primary statements read. `excludeSources` drops whole
  // entries by source (e.g. ['CLOSE'] for an in-year P&L window that must not include the year-end sweep).
  async perAccountNet(to: string, from?: string | null, ledgerCode?: string | null, excludeSources?: string[]): Promise<{ account_code: string; account_name: string | null; account_type: string | null; debit: number; credit: number; net: number }[]> {
    const rows = await this.aggregateByType(this.db, from ?? null, to, undefined, ledgerCode, undefined, excludeSources);
    return rows.map((r: any) => ({
      account_code: r.account_code,
      account_name: r.account_name,
      account_type: r.account_type,
      debit: round4(n(r.debit)),
      credit: round4(n(r.credit)),
      net: round4(n(r.debit) - n(r.credit)),
    }));
  }

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

  // ───────────────────── Book-tax difference (ผลต่างทางบัญชี-ภาษี) ─────────────────────
  // Compares two ledgers' P&L over a window — the temporary/permanent differences that feed deferred tax
  // (TAS 12) and the ภ.ง.ด.50 reconciliation. Since shared entries are identical in both books, the
  // difference comes entirely from each ledger's own adjustments.
  async gaapComparison(from: string, to: string, base = LEADING, compare = 'TAX') {
    await this.assertLedger(base);
    await this.assertLedger(compare);
    const b = await this.incomeStatement(from, to, undefined, base);
    const c = await this.incomeStatement(from, to, undefined, compare);
    const pnl = (l: any) => l.account_type === 'Revenue' ? round4(n(l.credit) - n(l.debit)) : round4(n(l.debit) - n(l.credit)); // revenue +, expense as cost +
    const map = new Map<string, any>();
    for (const l of b.lines) map.set(l.account_code, { account_code: l.account_code, account_name: l.account_name, account_type: l.account_type, base: pnl(l), compare: 0 });
    for (const l of c.lines) {
      const e = map.get(l.account_code) ?? { account_code: l.account_code, account_name: l.account_name, account_type: l.account_type, base: 0, compare: 0 };
      e.compare = pnl(l); map.set(l.account_code, e);
    }
    const lines = [...map.values()]
      .map((e) => ({ ...e, difference: round4(e.compare - e.base) }))
      .filter((e) => Math.abs(e.difference) > 1e-9)
      .sort((a, b2) => a.account_code.localeCompare(b2.account_code));
    return {
      from, to, base_ledger: base, compare_ledger: compare,
      base_net_income: b.net_income, compare_net_income: c.net_income,
      difference: round4(c.net_income - b.net_income),
      lines,
    };
  }

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

  private periodBounds(period: string) {
    const [y, m] = period.split('-').map(Number) as [number, number];
    const start = `${period}-01`;
    const endDate = m < 12 ? `${y}-${String(m + 1).padStart(2, '0')}-01` : `${y}-12-31`;
    return { start, endDate };
  }

  // All period ops are per-tenant (0043). tenantId defaults to the request's own tenant (ALS),
  // so the existing controller endpoints scope correctly with no signature change.
  async ensurePeriod(period: string, tenantId?: number | null) {
    const db = this.db;
    const tid = resolveTenantId(tenantId);
    const { start, endDate } = this.periodBounds(period);
    await db.insert(fiscalPeriods).values({ code: period, startDate: start, endDate, status: 'Open', tenantId: tid })
      .onConflictDoNothing({ target: [fiscalPeriods.tenantId, fiscalPeriods.code] });
  }

  async listPeriods(tenantId?: number | null) {
    const db = this.db;
    const tid = resolveTenantId(tenantId);
    const rows = await db.select().from(fiscalPeriods)
      .where(tid == null ? undefined : eq(fiscalPeriods.tenantId, tid))
      .orderBy(fiscalPeriods.code);
    return { periods: rows.map((p: any) => ({ code: p.code, status: p.status, start_date: p.startDate, end_date: p.endDate })), count: rows.length };
  }

  async setPeriodStatus(period: string, status: 'Open' | 'Closed', tenantId?: number | null) {
    const db = this.db;
    const tid = resolveTenantId(tenantId);
    await this.ensurePeriod(period, tid);
    await db.update(fiscalPeriods).set({ status })
      .where(tid == null ? eq(fiscalPeriods.code, period) : and(eq(fiscalPeriods.code, period), eq(fiscalPeriods.tenantId, tid)));
    return { period, status };
  }
  // Last calendar day of a 'YYYY-MM' period (period close dates the loyalty accrual inside the period).
  private periodEndDate(period: string): string {
    const [y, m] = period.split('-').map(Number) as [number, number];
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last day of this month
    return `${period}-${String(last).padStart(2, '0')}`;
  }

  // ── Loyalty points-liability accrual (TFRS 15) ─────────────────────────────
  // Reconciles GL control account 2250 to outstanding points × fair value by posting the delta since the
  // last run (provision model: net grant ⇒ Dr 5700 / Cr 2250; net redeem/forfeit/expiry ⇒ Dr 2250 / Cr 5700).
  // Watermarked on pos_member_ledger.id + idempotent (deterministic sourceRef + ux_je_idem + unique run).
  // Lives here (not in the loyalty module) so the GL period-close can call it without a module cycle; it
  // reads the loyalty sub-ledger tables directly and posts via this.postEntry.
  async accrueLiability(ctx: { tenantId: number; createdBy: string; asOfDate?: string }) {
    const db = this.db;
    const tenantId = ctx.tenantId;
    const [cfg] = await db.select().from(loyaltyConfig).limit(1);
    const fairValue = cfg ? n(cfg.bahtPerPoint) : 0;
    return await db.transaction(async (tx: any) => {
      const [last] = await tx.select({
        wm: sql`coalesce(max(${loyaltyPostingRuns.watermarkId}), 0)`,
        posted: sql`coalesce(sum(${loyaltyPostingRuns.liabilityDelta}), 0)`,
      }).from(loyaltyPostingRuns).where(eq(loyaltyPostingRuns.tenantId, tenantId));
      const lastWm = Number(last?.wm ?? 0);
      const priorLiability = round2(n(last?.posted));
      const [hi] = await tx.select({ hi: sql`coalesce(max(${posMemberLedger.id}), 0)` }).from(posMemberLedger).where(eq(posMemberLedger.tenantId, tenantId));
      const newHigh = Number(hi?.hi ?? 0);
      const [agg] = await tx.select({ pts: sql`coalesce(sum(${posMembers.balance}), 0)` }).from(posMembers).where(eq(posMembers.tenantId, tenantId));
      const outstanding = n(agg?.pts);
      const target = round2(outstanding * fairValue);
      if (newHigh <= lastWm) {
        return { posted: false, reason: 'up_to_date', watermark: lastWm, outstanding_points: outstanding, fair_value_per_point: fairValue, target_liability: target, posted_liability: priorLiability, liability_delta: 0 };
      }
      const [stat] = await tx.select({
        earn: sql`coalesce(sum(case when ${posMemberLedger.points} > 0 then ${posMemberLedger.points} else 0 end), 0)`,
        redeem: sql`coalesce(sum(case when ${posMemberLedger.points} < 0 then -${posMemberLedger.points} else 0 end), 0)`,
      }).from(posMemberLedger).where(and(eq(posMemberLedger.tenantId, tenantId), gt(posMemberLedger.id, lastWm), lte(posMemberLedger.id, newHigh)));
      const delta = round2(target - priorLiability);
      let journalNo: string | null = null;
      if (Math.abs(delta) >= 0.005) {
        // docs/43 PR-2: the expense leg follows the tenant posting-rule (LOYALTY.ACCRUE.loyalty_expense);
        // the 2250 points-liability control stays pinned (watermark tie).
        const loyAcct = (await this.postingOverrides('LOYALTY.ACCRUE', tenantId)).loyalty_expense ?? postingDefault('LOYALTY.ACCRUE', 'loyalty_expense');
        const lines = delta > 0
          ? [{ account_code: loyAcct, debit: delta }, { account_code: '2250', credit: delta }]
          : [{ account_code: '2250', debit: -delta }, { account_code: loyAcct, credit: -delta }];
        const je: any = await this.postEntry({
          ...(ctx.asOfDate ? { date: ctx.asOfDate } : {}),
          source: 'LOYALTY', sourceRef: `${tenantId}:upto-${newHigh}`, tenantId,
          memo: `Loyalty points liability accrual (tenant ${tenantId})`, createdBy: ctx.createdBy, lines,
        }, tx);
        journalNo = je?.entry_no ?? null;
        if (journalNo == null) {
          return { posted: false, reason: 'deduped', watermark: newHigh, outstanding_points: outstanding, fair_value_per_point: fairValue, target_liability: target, posted_liability: priorLiability, liability_delta: 0 };
        }
      }
      await tx.insert(loyaltyPostingRuns).values({
        tenantId, runNo: `LOY-${tenantId}-${newHigh}`, watermarkId: newHigh,
        outstandingPoints: String(outstanding), fairValuePerPoint: String(fairValue), targetLiability: String(target),
        priorLiability: String(priorLiability), liabilityDelta: String(delta),
        earnedPoints: String(n(stat?.earn)), redeemedPoints: String(n(stat?.redeem)), journalNo, createdBy: ctx.createdBy,
      }).onConflictDoNothing();
      return {
        posted: journalNo != null, reason: journalNo != null ? 'posted' : 'no_change', journal_no: journalNo,
        watermark: newHigh, outstanding_points: outstanding, fair_value_per_point: fairValue,
        target_liability: target, posted_liability: round2(priorLiability + delta), liability_delta: delta,
      };
    });
  }

  // Close a period. Before locking it, accrue the loyalty points liability to date (dated inside the period)
  // so the period's books carry the up-to-date liability — best-effort: a loyalty hiccup must not block the
  // financial close. `accrue:false` is passed by closeYear, which runs the accrual once before its P&L sweep.
  async closePeriod(period: string, tenantId?: number | null, opts?: { accrue?: boolean }) {
    const tid = resolveTenantId(tenantId);
    let loyaltyAccrual: any = null;
    if (opts?.accrue !== false && tid != null) {
      try { loyaltyAccrual = await this.accrueLiability({ tenantId: tid, createdBy: 'system:period-close', asOfDate: this.periodEndDate(period) }); }
      catch (e: any) { loyaltyAccrual = { posted: false, reason: 'error', error: String(e?.message ?? e) }; }
    }
    const res = await this.setPeriodStatus(period, 'Closed', tid);
    return { ...res, loyalty_accrual: loyaltyAccrual };
  }
  async openPeriod(period: string, tenantId?: number | null) { return this.setPeriodStatus(period, 'Open', tenantId); }

  // Provision all 12 (Open) periods of a fiscal year for a tenant — called at signup so a new tenant
  // can post immediately into the current year. Idempotent.
  async provisionFiscalYear(year: number, tenantId: number) {
    for (let m = 1; m <= 12; m++) await this.ensurePeriod(`${year}-${String(m).padStart(2, '0')}`, tenantId);
    return { year, tenant_id: tenantId, provisioned: 12 };
  }

  // Opening balances → ONE balanced journal entry for the tenant (cutover from a prior system).
  // rows: {account_code, debit?, credit?}. Any net imbalance posts to 3000 (Opening Balance Equity).
  // Idempotent on (tenant, OPENING, batchRef). Invalid rows are reported, not silently dropped.
  async postOpeningBalances(rows: { account_code: string; debit?: number; credit?: number }[], batchRef: string | undefined, createdBy: string, tenantId?: number | null) {
    const tid = resolveTenantId(tenantId);
    const ref = (batchRef?.trim()) || `OPENING-${ymd().slice(0, 7)}`;
    if (await this.alreadyPosted('OPENING', ref, tid)) return { already: true, batch_ref: ref };

    const lines: JournalLineDto[] = [];
    const rowErrors: { row: number; error: string }[] = [];
    let netDebit = 0;
    rows.forEach((r, i) => {
      const acct = String(r.account_code ?? '').trim();
      const d = n(r.debit), c = n(r.credit);
      if (!acct) { rowErrors.push({ row: i + 1, error: 'account_code required' }); return; }
      if (d === 0 && c === 0) { rowErrors.push({ row: i + 1, error: 'debit or credit required' }); return; }
      lines.push({ account_code: acct, debit: d || undefined, credit: c || undefined });
      netDebit += d - c;
    });
    if (!lines.length) throw new BadRequestException({ code: 'NO_VALID_ROWS', message: 'No valid opening-balance rows', messageTh: 'ไม่มีรายการยอดยกมาที่ถูกต้อง' });

    const bal = round4(netDebit); // balance against 3000 Equity (Opening Balance Equity)
    if (bal > 0) lines.push({ account_code: '3000', credit: bal });
    else if (bal < 0) lines.push({ account_code: '3000', debit: -bal });

    // GL-05 (audit G4): opening balances are among the most material, least-scrutinised postings at
    // go-live, so the batch posts as DRAFT — excluded from balances until a DIFFERENT user approves it via
    // POST /api/ledger/journal/:entryNo/approve (maker-checker; approver ≠ preparer).
    const je = await this.postEntry({ date: ymd(), source: 'OPENING', sourceRef: ref, tenantId: tid, memo: `Opening balances ${ref}`, createdBy, lines, pendingApproval: true });
    return { batch_ref: ref, entry_no: je.entry_no, balanced: true, lines_posted: lines.length, row_errors: rowErrors, status: 'Draft', pending: true };
  }

  // Year-end close: post a closing journal zeroing Revenue & Expense into 3100 Retained Earnings,
  // then close all 12 months. Idempotent (skips if FY already closed).
  async closeYear(fiscalYear: number, createdBy: string, ledgerCode: string = LEADING, tenantId?: number | null) {
    const db = this.db;
    const tid = resolveTenantId(tenantId);
    // per-ledger idempotency: the leading book keeps the legacy 'FY{y}' ref; non-leading books are suffixed.
    // Scoped to THIS tenant so each tenant closes its own FY independently (shared 'FY2026' ref is fine).
    const closeRef = ledgerCode === LEADING ? `FY${fiscalYear}` : `FY${fiscalYear}-${ledgerCode}`;
    if (await this.alreadyPosted('CLOSE', closeRef, tid)) {
      return { closed: true, fiscal_year: fiscalYear, ledger: ledgerCode, already: true };
    }
    const from = `${fiscalYear}-01-01`, to = `${fiscalYear}-12-31`;
    // Accrue the loyalty points liability up to year-end BEFORE the P&L sweep, so the 5700 expense it books
    // is zeroed into Retained Earnings by this close (the 2250 liability stays on the balance sheet). Once,
    // on the leading book only; best-effort so a loyalty hiccup never blocks the year-end close.
    if (ledgerCode === LEADING && tid != null) {
      try { await this.accrueLiability({ tenantId: tid, createdBy, asOfDate: to }); } catch { /* best-effort */ }
    }
    const rows = await this.aggregateByType(db, from, to, undefined, ledgerCode, tid);
    const lines: JournalLineDto[] = [];
    let revTotal = 0, expTotal = 0;
    for (const r of rows) {
      if (r.account_type === 'Revenue') {
        const bal = round4(n(r.credit) - n(r.debit)); // revenue normal credit balance
        if (bal !== 0) { lines.push({ account_code: r.account_code, debit: bal }); revTotal += bal; }
      } else if (r.account_type === 'Expense') {
        const bal = round4(n(r.debit) - n(r.credit)); // expense normal debit balance
        if (bal !== 0) { lines.push({ account_code: r.account_code, credit: bal }); expTotal += bal; }
      }
    }
    const netIncome = round4(revTotal - expTotal);
    if (netIncome > 0) lines.push({ account_code: '3100', credit: netIncome });
    else if (netIncome < 0) lines.push({ account_code: '3100', debit: -netIncome });
    if (!lines.length) return { closed: true, fiscal_year: fiscalYear, ledger: ledgerCode, net_income: 0, entry_no: null, note: 'no P&L activity' };

    await this.ensurePeriod(`${fiscalYear}-12`, tid);
    // tag the closing entry to its ledger + tenant so it zeroes only that book's P&L (each GAAP has its own result).
    const je = await this.postEntry({ date: to, source: 'CLOSE', sourceRef: closeRef, ledgerCode, tenantId: tid, allowClosedPeriod: true, memo: `Year-end close FY${fiscalYear} (${ledgerCode})`, createdBy, lines });
    // the tenant's fiscal calendar has no ledger dimension — only the LEADING close locks the months,
    // so non-leading ledgers can still post their own closing entry into December.
    if (ledgerCode === LEADING) for (let m = 1; m <= 12; m++) await this.closePeriod(`${fiscalYear}-${String(m).padStart(2, '0')}`, tid, { accrue: false });
    return { closed: true, fiscal_year: fiscalYear, ledger: ledgerCode, net_income: netIncome, entry_no: je.entry_no };
  }

  // group Posted journal_lines by account type within optional date window.
  // excludeSources drops whole entries by source (e.g. CLOSE) — used by the cash-flow statement so a
  // year-end closing reclassification doesn't masquerade as P&L/working-capital movement.
  private async aggregateByType(db: any, from: string | null, to: string, costCenter?: string | null, ledgerCode?: string | null, tenantId?: number | null, excludeSources?: string[], dims?: DimensionFilter) {
    const conds = [eq(journalEntries.status, 'Posted'), sql`${journalEntries.entryDate} <= ${to}`, this.ledgerCond(ledgerCode)];
    if (from) conds.push(sql`${journalEntries.entryDate} >= ${from}`);
    // Explicit tenant scope for writes like closeYear (which may run under HQ/bypass where RLS won't narrow).
    if (tenantId !== undefined && tenantId !== null) conds.push(eq(journalEntries.tenantId, tenantId));
    if (excludeSources && excludeSources.length) conds.push(notInArray(journalEntries.source, excludeSources));
    if (costCenter === '__UNASSIGNED__') conds.push(sql`${journalLines.costCenterCode} IS NULL`);
    else if (costCenter) conds.push(eq(journalLines.costCenterCode, costCenter));
    conds.push(...this.dimConds(dims)); // FIN-7a: project/dept/branch line-dimension filter (no-op when unset)
    const rows = await db
      .select({
        account_type: accounts.type,
        account_code: journalLines.accountCode,
        account_name: accounts.name,
        debit: sql<string>`coalesce(sum(${journalLines.debit}),0)`,
        credit: sql<string>`coalesce(sum(${journalLines.credit}),0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .leftJoin(accounts, eq(journalLines.accountCode, accounts.code))
      .where(and(...conds))
      .groupBy(accounts.type, journalLines.accountCode, accounts.name)
      .orderBy(journalLines.accountCode);
    return rows.map((r: any) => ({
      account_type: r.account_type, account_code: r.account_code, account_name: r.account_name,
      debit: round4(n(r.debit)), credit: round4(n(r.credit)),
    }));
  }
}

function round4(x: number): number { return Math.round(x * 10000) / 10000; }


function typeTotal(rows: any[], type: string, side: 'debit' | 'credit'): number {
  return rows.filter((r) => r.account_type === type).reduce((a, r) => a + n(r[side]), 0);
}
// Exact variant over the raw SQL numeric strings, in bigint minor units (docs/27 R1-4 / AUD-ARC-04).
function typeTotalM(rows: any[], type: string, side: 'debit' | 'credit'): bigint {
  return rows.filter((r) => r.account_type === type).reduce((a: bigint, r) => a + toMinor4(r[side]), 0n);
}
