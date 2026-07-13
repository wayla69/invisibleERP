import { Inject, Injectable } from '@nestjs/common';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { journalEntries, journalLines } from '../../database/schema/ledger';
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

  // The GL cash position (Σ debit − Σ credit over the CASH_ACCOUNTS set, Posted only) — the module
  // classifier lives here with the ledger instead of being re-derived by consumers.
  async cashPosition(tenantId?: number | null): Promise<number> {
    return this.accountNet([...CASH_ACCOUNTS], { tenantId });
  }

  // Recover the entry_no of an already-posted (source, source_ref) — the read-side companion of
  // LedgerService.alreadyPosted, for crash-recovery audit links.
  async entryRefNo(source: string, sourceRef: string): Promise<string | null> {
    const [row] = await this.db.select({ entryNo: journalEntries.entryNo }).from(journalEntries)
      .where(and(eq(journalEntries.source, source), eq(journalEntries.sourceRef, sourceRef))).limit(1);
    return row?.entryNo ?? null;
  }
}
