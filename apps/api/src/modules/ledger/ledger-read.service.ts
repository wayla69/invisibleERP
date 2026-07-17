import { Inject, Injectable } from '@nestjs/common';
import { eq, and, sql, inArray, gte, lt, lte, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { journalEntries, journalLines, accounts } from '../../database/schema/ledger';
import { n } from '../../database/queries';
import { CASH_ACCOUNTS } from './ledger-constants';

// docs/46 Phase 3 — the NARROW ledger read API for other modules. Consumers that only need a posted GL
// balance or an entry-no lookup inject THIS (exported by LedgerModule) instead of joining
// journal_entries/journal_lines themselves — the check-import-boundaries ratchet blocks new direct reads.
// Deliberately tiny: balances and reference lookups only; statements/reporting stay on the LedgerService
// facade, and posting stays on LedgerService.postEntry (GL-05).
@Injectable()
export class LedgerReadService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Net Posted balance (Σ debit − Σ credit) across a set of accounts. tenantId null/undefined = no tenant
  // filter (the caller's RLS still scopes rows); asOf bounds by entry_date when given.
  async accountNet(accounts: string[], opts?: { tenantId?: number | null; asOf?: string | null }): Promise<number> {
    if (!accounts.length) return 0;
    const conds = [
      accounts.length === 1 ? eq(journalLines.accountCode, accounts[0]!) : inArray(journalLines.accountCode, accounts),
      eq(journalEntries.status, 'Posted'),
    ];
    if (opts?.asOf) conds.push(sql`${journalEntries.entryDate} <= ${opts.asOf}`);
    if (opts?.tenantId != null) conds.push(eq(journalEntries.tenantId, opts.tenantId));
    const rows = await this.db.select({ net: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}),0)` })
      .from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id)).where(and(...conds));
    return n(rows[0]?.net);
  }

  // Gross Posted debit/credit sums (plus the net) across a set of accounts — for sub-ledger↔GL tie-outs
  // that need both legs (a liability's accrued-vs-remitted, an inventory control's ins-vs-outs), where
  // accountNet's single number is not enough. Options mirror the tie-out queries the consumers ran
  // directly before docs/46 Phase 3: `tenantOn: 'line'` matches on journal_lines.tenant_id instead of the
  // entry header (per-line tenant attribution); `sources` bounds to the sub-ledger's own posting sources;
  // `from`/`toExcl` bound entry_date as [from, toExcl); `costCenter` filters the line's cost-center code.
  async accountGross(
    accounts: string[],
    opts?: { tenantId?: number | null; tenantOn?: 'entry' | 'line'; from?: string | null; toExcl?: string | null; sources?: string[]; costCenter?: string | null },
  ): Promise<{ debit: number; credit: number; net: number }> {
    if (!accounts.length) return { debit: 0, credit: 0, net: 0 };
    const conds = [
      accounts.length === 1 ? eq(journalLines.accountCode, accounts[0]!) : inArray(journalLines.accountCode, accounts),
      eq(journalEntries.status, 'Posted'),
    ];
    if (opts?.tenantId != null) conds.push(opts.tenantOn === 'line' ? eq(journalLines.tenantId, opts.tenantId) : eq(journalEntries.tenantId, opts.tenantId));
    if (opts?.from) conds.push(gte(journalEntries.entryDate, opts.from));
    if (opts?.toExcl) conds.push(lt(journalEntries.entryDate, opts.toExcl));
    if (opts?.sources?.length) conds.push(inArray(journalEntries.source, opts.sources));
    if (opts?.costCenter) conds.push(eq(journalLines.costCenterCode, opts.costCenter));
    const [r] = await this.db.select({
      debit: sql<string>`coalesce(sum(${journalLines.debit}),0)`,
      credit: sql<string>`coalesce(sum(${journalLines.credit}),0)`,
    }).from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id)).where(and(...conds));
    const debit = n(r?.debit), credit = n(r?.credit);
    return { debit, credit, net: debit - credit };
  }

  // Posted line-level activity for a SMALL set of control accounts — for consumers that reconstruct a
  // rollforward/movement schedule from the raw legs (e.g. the TFRS-15 contract-liability disclosure).
  // Returns the line columns as stored (debit/credit are the raw numeric strings) so consumers keep their
  // own n()/rounding conventions. Deliberately per-account-set, not a general journal browse.
  async accountActivity(accounts: string[], opts?: { tenantId?: number | null }): Promise<{ accountCode: string; debit: string | null; credit: string | null; entryDate: string; source: string | null }[]> {
    if (!accounts.length) return [];
    const conds = [
      eq(journalEntries.status, 'Posted'),
      accounts.length === 1 ? eq(journalLines.accountCode, accounts[0]!) : inArray(journalLines.accountCode, accounts),
    ];
    if (opts?.tenantId != null) conds.push(eq(journalEntries.tenantId, opts.tenantId));
    return this.db.select({
      accountCode: journalLines.accountCode, debit: journalLines.debit, credit: journalLines.credit,
      entryDate: journalEntries.entryDate, source: journalEntries.source,
    }).from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id)).where(and(...conds));
  }

  // Posted gross debit/credit GROUPED per account — the actuals side of budget-vs-actual style reports.
  // `period` matches the entry's fiscal PERIOD column; `from`/`to` bound entry_date INCLUSIVELY (a fiscal
  // year is [YYYY-01-01, YYYY-12-31]); `costCenter` filters the line's cost-center code.
  async accountGrossByAccount(opts?: { tenantId?: number | null; period?: string | null; from?: string | null; to?: string | null; costCenter?: string | null }): Promise<{ accountCode: string; debit: string; credit: string }[]> {
    const conds = [eq(journalEntries.status, 'Posted')];
    if (opts?.period) conds.push(sql`${journalEntries.period} = ${opts.period}`);
    if (opts?.from) conds.push(gte(journalEntries.entryDate, opts.from));
    if (opts?.to) conds.push(lte(journalEntries.entryDate, opts.to));
    if (opts?.costCenter) conds.push(eq(journalLines.costCenterCode, opts.costCenter));
    if (opts?.tenantId != null) conds.push(eq(journalEntries.tenantId, opts.tenantId));
    return this.db.select({
      accountCode: journalLines.accountCode,
      debit: sql<string>`coalesce(sum(${journalLines.debit}),0)`,
      credit: sql<string>`coalesce(sum(${journalLines.credit}),0)`,
    }).from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(...conds)).groupBy(journalLines.accountCode);
  }

  // Net Posted balance (Σ debit − Σ credit) per OWNING TENANT across a set of accounts — for HQ-side
  // cross-company eliminations (the intercompany 1150/2150 due-from/due-to picture). Credit-normal
  // consumers negate. Grouped on the entry header's tenant_id.
  async accountNetByTenant(accounts_: string[]): Promise<{ tenantId: number | null; net: number }[]> {
    if (!accounts_.length) return [];
    const rows = await this.db.select({ tenant: journalEntries.tenantId, bal: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}),0)` })
      .from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(
        accounts_.length === 1 ? eq(journalLines.accountCode, accounts_[0]!) : inArray(journalLines.accountCode, accounts_),
        eq(journalEntries.status, 'Posted'),
      )).groupBy(journalEntries.tenantId);
    return rows.map((r) => ({ tenantId: r.tenant != null ? Number(r.tenant) : null, net: n(r.bal) }));
  }

  // Net Posted movement grouped by an ANALYSIS DIMENSION on the line (branch / cost center / project) ×
  // account, filtered to the given account TYPES via the chart of accounts (ledger-owned). The
  // segment-profitability read: consumers derive revenue/COGS/opex per segment from the (type, net) pairs.
  // `net` stays the raw numeric string so consumers keep their own num()/rounding conventions.
  async netByDimension(by: 'branch' | 'cost_center' | 'project', opts: { from: string; to: string; accountTypes: (typeof accounts.$inferSelect)['type'][] }): Promise<{ dim: string | number | null; accountCode: string; type: string | null; net: string }[]> {
    const dimCol = by === 'branch' ? journalLines.branchId : by === 'cost_center' ? journalLines.costCenterCode : journalLines.projectId;
    return this.db.select({
      dim: dimCol, accountCode: journalLines.accountCode, type: accounts.type,
      net: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}),0)`,
    }).from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .leftJoin(accounts, eq(journalLines.accountCode, accounts.code))
      .where(and(eq(journalEntries.status, 'Posted'), gte(journalEntries.entryDate, opts.from), lte(journalEntries.entryDate, opts.to), inArray(accounts.type, opts.accountTypes)))
      .groupBy(dimCol, journalLines.accountCode, accounts.type);
  }

  // GL-05 detective audit read: MANUAL journal entries dated on a weekend (dow 0=Sun, 6=Sat) with the
  // summed debit amount — the classic management-override red flag the controls scanner surfaces. No user
  // input in the predicate.
  async weekendManualEntries(): Promise<{ entryNo: string; entryDate: string; memo: string | null; amt: string }[]> {
    return this.db.select({ entryNo: journalEntries.entryNo, entryDate: journalEntries.entryDate, memo: journalEntries.memo, amt: sql<string>`coalesce(sum(${journalLines.debit}),0)` })
      .from(journalEntries).leftJoin(journalLines, eq(journalLines.entryId, journalEntries.id))
      .where(and(eq(journalEntries.source, 'Manual'), sql`extract(dow from ${journalEntries.entryDate}) in (0,6)`))
      .groupBy(journalEntries.entryNo, journalEntries.entryDate, journalEntries.memo);
  }

  // Register listing for one posting SOURCE — one row per (entry × positive-DEBIT line), newest first.
  // Serves maker-checker registers whose document of record IS the journal entry (e.g. the AR write-off
  // register: every AR-WRITEOFF entry has exactly one expense debit leg, so this yields one row per
  // write-off regardless of which account the tenant's posting rules routed it to). All statuses returned —
  // Draft = pending approval, Posted = effective, Voided = rejected.
  async sourceRegister(source: string, opts?: { tenantId?: number | null; limit?: number }): Promise<{ entryNo: string; status: string | null; memo: string | null; createdBy: string | null; date: string; debit: string | null }[]> {
    const conds = [eq(journalEntries.source, source), sql`${journalLines.debit} > 0`];
    if (opts?.tenantId != null) conds.push(eq(journalEntries.tenantId, opts.tenantId));
    return this.db.select({
      entryNo: journalEntries.entryNo, status: journalEntries.status, memo: journalEntries.memo,
      createdBy: journalEntries.createdBy, date: journalEntries.entryDate, debit: journalLines.debit,
    }).from(journalEntries).innerJoin(journalLines, eq(journalLines.entryId, journalEntries.id))
      .where(and(...conds)).orderBy(desc(journalEntries.id)).limit(opts?.limit ?? 200);
  }

  // The GL cash position (Σ debit − Σ credit over the CASH_ACCOUNTS set, Posted only) — the module
  // classifier lives here with the ledger instead of being re-derived by consumers.
  async cashPosition(tenantId?: number | null): Promise<number> {
    return this.accountNet([...CASH_ACCOUNTS], { tenantId });
  }

  // Recover the entry_no of an already-posted (source, source_ref) — the read-side companion of
  // LedgerService.alreadyPosted, for crash-recovery audit links. `opts.status` narrows to one JE status
  // and returns the LATEST match (maker-checker consumers looking up their pending Draft, e.g. FA-09's
  // disposal approval); without it the original single-row lookup is unchanged.
  async entryRefNo(source: string, sourceRef: string, opts?: { status?: (typeof journalEntries.$inferSelect)['status'] }): Promise<string | null> {
    const conds = [eq(journalEntries.source, source), eq(journalEntries.sourceRef, sourceRef)];
    if (opts?.status) {
      conds.push(eq(journalEntries.status, opts.status));
      const [row] = await this.db.select({ entryNo: journalEntries.entryNo }).from(journalEntries)
        .where(and(...conds)).orderBy(desc(journalEntries.id)).limit(1);
      return row?.entryNo ?? null;
    }
    const [row] = await this.db.select({ entryNo: journalEntries.entryNo }).from(journalEntries)
      .where(and(...conds)).limit(1);
    return row?.entryNo ?? null;
  }
}
