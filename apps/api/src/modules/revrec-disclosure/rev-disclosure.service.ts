import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq, and, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { journalEntries, journalLines, revContracts, revrecSchedules } from '../../database/schema';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// ── Track D — Wave 4 (REV-27, FINAL): revenue disclosure pack (TFRS 15 / IFRS 15 / ASC 606 §120) ───────────
// Two READ-ONLY detective aggregators — they add NO table and post no GL:
//   • contract-liability rollforward (§120(b)) — opening → additions (billings) → recognized → closing over
//     the contract-liability (2410) and contract-asset (1265) control accounts, derived DIRECTLY from the GL
//     journal lines so it RECONCILES to GL by construction (opening + additions − reductions = closing = GL).
//   • RPO / backlog (§120(a)) — Σ transaction price allocated to UNSATISFIED (or partially satisfied)
//     performance obligations, i.e. Σ unrecognized allocated price, with an expected-timing band (≤12m / >12m).
// Both are tenant-scoped (RLS on the underlying tables + an explicit tenant filter for HQ/Admin) and idempotent
// (pure reads), so they are schedulable via the BI report scheduler (contract_liability_rollforward / rpo_backlog).

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;
const CONTRACT_LIABILITY = '2410'; // credit-normal
const CONTRACT_ASSET = '1265';     // debit-normal

// sources that ADD to the contract liability (bill/activate in advance) vs those that RELEASE it (recognize).
function classifySource(src: string | null): 'billings' | 'recognized' | 'financing' | 'modification' | 'other' {
  const s = src ?? '';
  if (s === 'REVBILL' || s === 'REVREC-INV') return 'billings';
  if (s === 'REVREC') return 'recognized';
  if (s === 'REVFIN') return 'financing';
  if (s === 'REVREC-MOD') return 'modification';
  return 'other';
}

@Injectable()
export class RevDisclosureService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private tenantOf(user: JwtUser, explicit?: number | null): number | null {
    const t = explicit ?? user.tenantId ?? null;
    return t == null ? null : Number(t);
  }

  // ── GET /api/revenue/disclosure/contract-liability-rollforward?period=YYYY-MM ──
  // Reconstructs the movement of the contract-liability (2410) and contract-asset (1265) control accounts over
  // the period from the GL journal lines, decomposed by source. Ties to GL by construction.
  async contractLiabilityRollforward(period: string, user: JwtUser, explicitTenantId?: number | null) {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new BadRequestException({ code: 'INVALID_PERIOD', message: 'period must be YYYY-MM', messageTh: 'งวดต้องเป็น YYYY-MM' });
    const db = this.db;
    const tenantId = this.tenantOf(user, explicitTenantId);
    const conds = [eq(journalEntries.status, 'Posted'), inArray(journalLines.accountCode, [CONTRACT_LIABILITY, CONTRACT_ASSET])];
    if (tenantId != null) conds.push(eq(journalEntries.tenantId, tenantId));
    const rows = await db.select({
      accountCode: journalLines.accountCode, debit: journalLines.debit, credit: journalLines.credit,
      entryDate: journalEntries.entryDate, source: journalEntries.source,
    }).from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id)).where(and(...conds));

    const build = (account: string, creditNormal: boolean) => {
      let opening = 0;
      const addBy: Record<string, number> = {}; const redBy: Record<string, number> = {};
      let additions = 0; let reductions = 0;
      for (const r of rows) {
        if (r.accountCode !== account) continue;
        const d = n(r.debit); const cr = n(r.credit);
        const ym = String(r.entryDate).slice(0, 7);
        // signed movement in the account's NORMAL direction (credit-normal: credit−debit; debit-normal: debit−credit)
        const inc = creditNormal ? cr : d;   // grows the balance (an addition)
        const dec = creditNormal ? d : cr;   // shrinks the balance (a reduction)
        if (ym < period) { opening = round4(opening + inc - dec); continue; }
        if (ym > period) continue; // future entries excluded from this period's rollforward
        const bucket = classifySource(r.source);
        if (inc > 0) { additions = round4(additions + inc); addBy[bucket] = round4((addBy[bucket] ?? 0) + inc); }
        if (dec > 0) { reductions = round4(reductions + dec); redBy[bucket] = round4((redBy[bucket] ?? 0) + dec); }
      }
      const closing = round4(opening + additions - reductions);
      return {
        account, opening,
        additions: { total: additions, by_source: addBy },
        reductions: { total: reductions, by_source: redBy },
        // §120 named lines (for the disclosure): billings raised vs revenue recognized against the liability.
        billings: round4(addBy.billings ?? 0),
        recognized: round4(redBy.recognized ?? 0),
        financing: round4((addBy.financing ?? 0) - (redBy.financing ?? 0)),
        closing,
      };
    };

    const liability = build(CONTRACT_LIABILITY, true);
    const asset = build(CONTRACT_ASSET, false);
    // GL closing balances (independent of the rollforward decomposition) — the reconciliation control.
    const glClosing = async (account: string, creditNormal: boolean) => {
      let bal = 0;
      for (const r of rows) {
        if (r.accountCode !== account) continue;
        if (String(r.entryDate).slice(0, 7) > period) continue;
        bal = round4(bal + (creditNormal ? n(r.credit) - n(r.debit) : n(r.debit) - n(r.credit)));
      }
      return bal;
    };
    const glLiability = await glClosing(CONTRACT_LIABILITY, true);
    const glAsset = await glClosing(CONTRACT_ASSET, false);
    const reconciled = Math.abs(liability.closing - glLiability) < 0.01 && Math.abs(asset.closing - glAsset) < 0.01;

    return {
      period, tenant_id: tenantId,
      contract_liability: { ...liability, gl_closing: glLiability, reconciled: Math.abs(liability.closing - glLiability) < 0.01 },
      contract_asset: { ...asset, gl_closing: glAsset, reconciled: Math.abs(asset.closing - glAsset) < 0.01 },
      reconciled, // opening + additions − reductions = closing = GL for BOTH control accounts (the §120 tie-out)
    };
  }

  // ── GET /api/revenue/disclosure/rpo — remaining performance obligation (backlog): Σ transaction price
  //    allocated to UNSATISFIED performance obligations = Σ unrecognized allocated price, banded by expected
  //    timing (≤12 months vs >12 months) from the recognition schedule. TFRS 15 §120(a). ──
  async rpo(user: JwtUser, opts?: { asOf?: string; explicitTenantId?: number | null }) {
    const db = this.db;
    const tenantId = this.tenantOf(user, opts?.explicitTenantId);
    const asOf = opts?.asOf && /^\d{4}-\d{2}$/.test(opts.asOf) ? opts.asOf : new Date().toISOString().slice(0, 7);
    // 12-month horizon boundary (inclusive of the 12th month).
    const [ay, am] = asOf.split('-').map(Number) as [number, number];
    const cutoffIdx = ay * 12 + (am - 1) + 12;

    const cConds = tenantId != null ? [eq(revContracts.tenantId, tenantId)] : [];
    const contracts = await db.select().from(revContracts).where(cConds.length ? and(...cConds) : undefined);
    const active = contracts.filter((c: any) => c.status !== 'Cancelled');
    const byId = new Map<number, any>(active.map((c: any) => [Number(c.id), c]));
    if (!byId.size) return { as_of: asOf, tenant_id: tenantId, total_rpo: 0, within_12m: 0, beyond_12m: 0, count: 0, by_contract: [] };

    const sched = await db.select().from(revrecSchedules).where(inArray(revrecSchedules.contractId, [...byId.keys()]));
    const perContract = new Map<number, { within: number; beyond: number; total: number }>();
    for (const s of sched) {
      if (s.recognized) continue; // already satisfied → not remaining
      const cid = Number(s.contractId);
      if (!byId.has(cid)) continue;
      const amt = n(s.plannedAmount);
      const [py, pm] = String(s.period).split('-').map(Number) as [number, number];
      const idx = py * 12 + (pm - 1);
      const acc = perContract.get(cid) ?? { within: 0, beyond: 0, total: 0 };
      if (idx <= cutoffIdx) acc.within = round4(acc.within + amt); else acc.beyond = round4(acc.beyond + amt);
      acc.total = round4(acc.total + amt);
      perContract.set(cid, acc);
    }
    const byContract = [...perContract.entries()].map(([cid, v]) => {
      const c = byId.get(cid);
      return { contract_id: cid, contract_no: c.contractNo, currency: c.currency, status: c.status, rpo: v.total, within_12m: v.within, beyond_12m: v.beyond };
    }).filter((r) => r.rpo > 0).sort((a, b) => b.rpo - a.rpo);

    const total = round4(byContract.reduce((a, r) => a + r.rpo, 0));
    const within = round4(byContract.reduce((a, r) => a + r.within_12m, 0));
    const beyond = round4(byContract.reduce((a, r) => a + r.beyond_12m, 0));
    return { as_of: asOf, tenant_id: tenantId, total_rpo: total, within_12m: within, beyond_12m: beyond, count: byContract.length, by_contract: byContract };
  }
}
