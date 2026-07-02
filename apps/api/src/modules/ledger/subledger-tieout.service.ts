import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { sql, eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import {
  accounts, journalEntries, journalLines, subledgerTieoutRuns,
  arInvoices, apTransactions, invBalances, fixedAssets,
} from '../../database/schema';
import { currentTenantStore } from '../../common/tenant-context';
import { ymd, n } from '../../database/queries';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

type Subledger = 'AR' | 'AP' | 'INV' | 'FA';
const SUBLEDGERS: Subledger[] = ['AR', 'AP', 'INV', 'FA'];

export interface RunTieOutDto { subledger: Subledger; asOfDate?: string; runBy: string }

@Injectable()
export class SubledgerTieoutService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private tenantId(): number | null {
    return currentTenantStore()?.tenantId ?? null;
  }

  // ───────────────────── Run a tie-out ─────────────────────
  // GL-14: compute the GL control-account balance and the matching sub-ledger detail balance as of a
  // date, then record the variance. Upserts on (tenant, subledger, as-of) so a same-day re-run refreshes.
  async runTieOut(dto: RunTieOutDto) {
    const db = this.db;
    const subledger = dto.subledger;
    if (!SUBLEDGERS.includes(subledger)) {
      throw new BadRequestException({ code: 'BAD_SUBLEDGER', message: `subledger must be one of ${SUBLEDGERS.join('/')}`, messageTh: 'ระบบบัญชีย่อยไม่ถูกต้อง' });
    }
    const tenantId = this.tenantId();
    const asOf = dto.asOfDate ?? ymd();

    // 1. Resolve the control account flagged for this sub-ledger.
    const [ctl] = await db.select({ code: accounts.code })
      .from(accounts)
      .where(and(eq(accounts.isControl, true), eq(accounts.controlSubledger, subledger)))
      .limit(1);
    if (!ctl) {
      throw new NotFoundException({ code: 'NO_CONTROL_ACCOUNT', message: `No control account flagged for sub-ledger ${subledger}`, messageTh: `ไม่พบบัญชีคุมสำหรับระบบบัญชีย่อย ${subledger}` });
    }
    const controlAccount: string = ctl.code;

    // 2. GL balance = Σ(debit − credit) of POSTED journal_lines on the control account up to asOf,
    //    scoped to tenant (same approach as trialBalance: join lines→entries, status='Posted').
    const glConds = [
      eq(journalEntries.status, 'Posted'),
      eq(journalLines.accountCode, controlAccount),
      sql`${journalEntries.entryDate} <= ${asOf}`,
    ];
    if (tenantId != null) glConds.push(eq(journalLines.tenantId, tenantId));
    const [glRow] = await db
      .select({ net: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)` })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(...glConds));
    const glBalance = round2(n(glRow?.net));

    // 3. Sub-ledger balance from the originating detail tables (queried directly to avoid cross-module
    //    circular deps with FinanceService/AssetsService).
    const { subledgerBalance, detail } = await this.subledgerBalance(subledger, asOf, tenantId);

    // 4. Variance + status.
    const variance = round2(glBalance - subledgerBalance);
    const status = Math.abs(variance) < 0.01 ? 'Matched' : 'Variance';

    // 5. Upsert (idempotent per tenant/subledger/as-of). A re-run resets certification.
    const values = {
      tenantId: tenantId as number,
      subledger,
      controlAccount,
      asOfDate: asOf,
      glBalance: String(glBalance),
      subledgerBalance: String(subledgerBalance),
      variance: String(variance),
      status,
      detail,
      runBy: dto.runBy,
      certifiedBy: null as string | null,
      certifiedAt: null as Date | null,
      note: null as string | null,
    };
    const [row] = await db.insert(subledgerTieoutRuns).values(values)
      .onConflictDoUpdate({
        target: [subledgerTieoutRuns.tenantId, subledgerTieoutRuns.subledger, subledgerTieoutRuns.asOfDate],
        set: {
          controlAccount: values.controlAccount,
          glBalance: values.glBalance,
          subledgerBalance: values.subledgerBalance,
          variance: values.variance,
          status: values.status,
          detail: values.detail,
          runBy: values.runBy,
          certifiedBy: null,
          certifiedAt: null,
          note: null,
        },
      })
      .returning();
    return this.shape(row);
  }

  // Compute the sub-ledger detail balance + a small breakdown for the `detail` jsonb.
  private async subledgerBalance(subledger: Subledger, asOf: string, tenantId: number | null): Promise<{ subledgerBalance: number; detail: any }> {
    const db = this.db;
    if (subledger === 'AR') {
      // AR sub-ledger = Σ outstanding (amount − paid_amount) of customer invoices issued up to asOf.
      // Summed directly off ar_invoices (the AR sub-ledger of record) — equivalent to the closing balance
      // of customerStatement aggregated across all customers, but far cheaper.
      const conds = [sql`${arInvoices.invoiceDate} <= ${asOf}`];
      if (tenantId != null) conds.push(eq(arInvoices.tenantId, tenantId));
      const [r] = await db
        .select({ out: sql<string>`coalesce(sum(${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)),0)`, cnt: sql<string>`count(*)` })
        .from(arInvoices).where(and(...conds));
      return { subledgerBalance: round2(n(r?.out)), detail: { source: 'ar_invoices', basis: 'amount - paid_amount, invoice_date <= as_of', invoices: n(r?.cnt) } };
    }
    if (subledger === 'AP') {
      // AP sub-ledger = Σ outstanding (amount − paid_amount) of vendor bills dated up to asOf, off ap_transactions.
      const conds = [sql`${apTransactions.invoiceDate} <= ${asOf}`];
      if (tenantId != null) conds.push(eq(apTransactions.tenantId, tenantId));
      const [r] = await db
        .select({ out: sql<string>`coalesce(sum(${apTransactions.amount} - coalesce(${apTransactions.paidAmount},0)),0)`, cnt: sql<string>`count(*)` })
        .from(apTransactions).where(and(...conds));
      return { subledgerBalance: round2(n(r?.out)), detail: { source: 'ap_transactions', basis: 'amount - paid_amount, invoice_date <= as_of', bills: n(r?.cnt) } };
    }
    if (subledger === 'INV') {
      // INV sub-ledger = Σ total_value (on-hand qty × cost) from inv_balances — the perpetual inventory
      // valuation. inv_balances is a current snapshot (no per-date history), so the as-of date is advisory
      // here: the balance reflects the latest valuation, not a back-dated one.
      const conds: any[] = [];
      if (tenantId != null) conds.push(eq(invBalances.tenantId, tenantId));
      const [r] = await db
        .select({ val: sql<string>`coalesce(sum(${invBalances.totalValue}),0)`, cnt: sql<string>`count(*)` })
        .from(invBalances).where(conds.length ? and(...conds) : undefined);
      return { subledgerBalance: round2(n(r?.val)), detail: { source: 'inv_balances.total_value', basis: 'current perpetual valuation (snapshot — as_of advisory)', items: n(r?.cnt) } };
    }
    // FA sub-ledger = Σ net book value (acquire_cost − accumulated_depreciation) of non-disposed assets,
    // off fixed_assets. (Like inv_balances, fixed_assets carries the current register state, so the as-of
    // is advisory.)
    const conds = [sql`${fixedAssets.status} <> 'disposed'`];
    if (tenantId != null) conds.push(eq(fixedAssets.tenantId, tenantId));
    const [r] = await db
      .select({ nbv: sql<string>`coalesce(sum(${fixedAssets.acquireCost} - coalesce(${fixedAssets.accumulatedDepreciation},0)),0)`, cnt: sql<string>`count(*)` })
      .from(fixedAssets).where(and(...conds));
    return { subledgerBalance: round2(n(r?.nbv)), detail: { source: 'fixed_assets', basis: 'acquire_cost - accumulated_depreciation, status <> disposed (register snapshot — as_of advisory)', assets: n(r?.cnt) } };
  }

  // ───────────────────── Certify (maker-checker) ─────────────────────
  // GL-14 SoD: the certifier MUST differ from the runner (SELF_CERTIFY). Certification records the
  // certifier + timestamp and sets status to 'Certified' regardless of variance (a variance may be
  // accepted with a note explaining the reconciling items).
  async certify(dto: { id: number; certifiedBy: string; note?: string }) {
    const db = this.db;
    const [run] = await db.select().from(subledgerTieoutRuns).where(eq(subledgerTieoutRuns.id, dto.id)).limit(1);
    if (!run) throw new NotFoundException({ code: 'NOT_FOUND', message: `Tie-out run ${dto.id} not found`, messageTh: 'ไม่พบรายการกระทบยอด' });
    if (run.runBy === dto.certifiedBy) {
      throw new BadRequestException({ code: 'SELF_CERTIFY', message: 'Cannot certify your own tie-out run', messageTh: 'ผู้จัดทำรับรองรายการของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    const [row] = await db.update(subledgerTieoutRuns).set({
      status: 'Certified',
      certifiedBy: dto.certifiedBy,
      certifiedAt: new Date(),
      ...(dto.note !== undefined ? { note: dto.note } : {}),
    }).where(eq(subledgerTieoutRuns.id, dto.id)).returning();
    return this.shape(row);
  }

  // ───────────────────── Read ─────────────────────
  async list(opts?: { subledger?: string; asOfDate?: string }) {
    const db = this.db;
    const tenantId = this.tenantId();
    const conds: any[] = [];
    if (tenantId != null) conds.push(eq(subledgerTieoutRuns.tenantId, tenantId));
    if (opts?.subledger) conds.push(eq(subledgerTieoutRuns.subledger, opts.subledger));
    if (opts?.asOfDate) conds.push(eq(subledgerTieoutRuns.asOfDate, opts.asOfDate));
    const rows = await db.select().from(subledgerTieoutRuns)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(subledgerTieoutRuns.id));
    return { runs: rows.map((r: any) => this.shape(r)), count: rows.length };
  }

  async get(id: number) {
    const db = this.db;
    const [row] = await db.select().from(subledgerTieoutRuns).where(eq(subledgerTieoutRuns.id, id)).limit(1);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: `Tie-out run ${id} not found`, messageTh: 'ไม่พบรายการกระทบยอด' });
    return this.shape(row);
  }

  private shape(r: any) {
    return {
      id: Number(r.id),
      subledger: r.subledger,
      control_account: r.controlAccount,
      as_of_date: r.asOfDate,
      glBalance: n(r.glBalance),
      subledgerBalance: n(r.subledgerBalance),
      variance: n(r.variance),
      status: r.status,
      detail: r.detail ?? null,
      run_by: r.runBy,
      certified_by: r.certifiedBy ?? null,
      certified_at: r.certifiedAt ?? null,
      note: r.note ?? null,
      created_at: r.createdAt ?? null,
    };
  }
}
