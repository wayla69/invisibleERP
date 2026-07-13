import { BadRequestException } from '@nestjs/common';
import { sql, eq, and, gt, lte } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { fiscalPeriods, posMembers, posMemberLedger, loyaltyConfig, loyaltyPostingRuns } from '../../database/schema';
import { currentTenantStore } from '../../common/tenant-context';
import { ymd, n } from '../../database/queries';
import { postingDefault } from './posting-events';
import { LEADING } from './ledger-constants';
import { round4 } from './ledger-reporting.service';
import type { JournalLineDto, PostEntryDto } from './ledger.service';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// Resolve the tenant a period/close operation belongs to: explicit arg wins, else the request's
// own tenant (the interceptor's ALS). null only when called outside any request (bootstrap/seed).
// Exported — the facade's listAccounts shares the same resolution rule.
export function resolveTenantId(explicit?: number | null): number | null {
  if (explicit !== undefined && explicit !== null) return explicit;
  return currentTenantStore()?.tenantId ?? null;
}

// The facade's write/read primitives arrive as callback ports (docs/38 pattern) so this class never
// imports the facade at runtime (the JournalLineDto/PostEntryDto imports above are type-only, erased).
export interface LedgerPeriodsPorts {
  postEntry(dto: PostEntryDto, outerTx?: any): Promise<any>;
  alreadyPosted(source: string, sourceRef: string, tenantId?: number | null): Promise<boolean>;
  postingOverrides(eventType: string, tenantId?: number | null): Promise<Record<string, string>>;
  aggregateByType(db: any, from: string | null, to: string, costCenter?: string | null, ledgerCode?: string | null, tenantId?: number | null): Promise<any[]>;
}

// docs/46 Phase 4e cut 2 — the fiscal-calendar + close lifecycle (per-tenant periods, period/year close,
// opening-balance cutover, TFRS-15 loyalty points-liability accrual), moved VERBATIM out of
// ledger.service.ts. A PLAIN class constructed in the LedgerService ctor BODY (harnesses construct the
// facade positionally with (db, docNo)); the facade keeps thin delegators, so the public API is
// byte-identical. Posting stays behind the postEntry port — GL-05/GL-21 and the period gates all still
// run in LedgerPostingService.
export class LedgerPeriodsService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly ports: LedgerPeriodsPorts,
  ) {}

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
  // reads the loyalty sub-ledger tables directly and posts via the postEntry port.
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
        const loyAcct = (await this.ports.postingOverrides('LOYALTY.ACCRUE', tenantId)).loyalty_expense ?? postingDefault('LOYALTY.ACCRUE', 'loyalty_expense');
        const lines = delta > 0
          ? [{ account_code: loyAcct, debit: delta }, { account_code: '2250', credit: delta }]
          : [{ account_code: '2250', debit: -delta }, { account_code: loyAcct, credit: -delta }];
        const je: any = await this.ports.postEntry({
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
    if (await this.ports.alreadyPosted('OPENING', ref, tid)) return { already: true, batch_ref: ref };

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
    const je = await this.ports.postEntry({ date: ymd(), source: 'OPENING', sourceRef: ref, tenantId: tid, memo: `Opening balances ${ref}`, createdBy, lines, pendingApproval: true });
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
    if (await this.ports.alreadyPosted('CLOSE', closeRef, tid)) {
      return { closed: true, fiscal_year: fiscalYear, ledger: ledgerCode, already: true };
    }
    const from = `${fiscalYear}-01-01`, to = `${fiscalYear}-12-31`;
    // Accrue the loyalty points liability up to year-end BEFORE the P&L sweep, so the 5700 expense it books
    // is zeroed into Retained Earnings by this close (the 2250 liability stays on the balance sheet). Once,
    // on the leading book only; best-effort so a loyalty hiccup never blocks the year-end close.
    if (ledgerCode === LEADING && tid != null) {
      try { await this.accrueLiability({ tenantId: tid, createdBy, asOfDate: to }); } catch { /* best-effort */ }
    }
    const rows = await this.ports.aggregateByType(db, from, to, undefined, ledgerCode, tid);
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
    const je = await this.ports.postEntry({ date: to, source: 'CLOSE', sourceRef: closeRef, ledgerCode, tenantId: tid, allowClosedPeriod: true, memo: `Year-end close FY${fiscalYear} (${ledgerCode})`, createdBy, lines });
    // the tenant's fiscal calendar has no ledger dimension — only the LEADING close locks the months,
    // so non-leading ledgers can still post their own closing entry into December.
    if (ledgerCode === LEADING) for (let m = 1; m <= 12; m++) await this.closePeriod(`${fiscalYear}-${String(m).padStart(2, '0')}`, tid, { accrue: false });
    return { closed: true, fiscal_year: fiscalYear, ledger: ledgerCode, net_income: netIncome, entry_no: je.entry_no };
  }
}
