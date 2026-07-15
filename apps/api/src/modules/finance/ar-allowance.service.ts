import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { sql, eq, and, desc, lt } from 'drizzle-orm';
import { assertMakerChecker } from '../../common/control-profile';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { arAllowance, arInvoices } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { ymd, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// REV-18 — AR Allowance for Doubtful Accounts (Expected Credit Loss). An aging-driven provision: every open
// AR bucket carries a loss rate and the allowance is Σ(outstanding × rate). compute() upserts an UNposted
// row; post() journals the DELTA vs the prior posted allowance (Dr 5720 Bad-Debt Expense / Cr 1190 contra-
// asset, reversed if the allowance falls) under maker-checker (computer ≠ poster). Posting respects the
// period lock (WS2.1) via the normal LedgerService.postEntry path; 1190 is NOT a control account so the
// post needs no viaSubledger flag (1100 AR is never touched — the contra preserves gross AR).

const BAD_DEBT_EXPENSE = '5720';
const ALLOWANCE_CONTRA = '1190';

// Default ECL loss rates per aging bucket (overridable per computation). Conservative TFRS 9 style ladder.
const DEFAULT_RATES = { current: 0, d1_30: 0.01, d31_60: 0.05, d61_90: 0.20, d91_120: 0.50, d120_plus: 1.00 };
type Rates = typeof DEFAULT_RATES;
const BUCKET_LABELS: Record<keyof Rates, string> = {
  current: 'Current (not due)', d1_30: '1–30 days', d31_60: '31–60 days',
  d61_90: '61–90 days', d91_120: '91–120 days', d120_plus: '120+ days',
};

export interface ComputeAllowanceDto { as_of_date?: string; method?: 'aging' | 'percentage'; bucket_rates?: Partial<Rates>; flat_rate?: number; tenant_id?: number | null }

@Injectable()
export class ArAllowanceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly ledger?: LedgerService,
  ) {}

  private bucketFor(daysOverdue: number): keyof Rates {
    if (daysOverdue <= 0) return 'current';
    if (daysOverdue <= 30) return 'd1_30';
    if (daysOverdue <= 60) return 'd31_60';
    if (daysOverdue <= 90) return 'd61_90';
    if (daysOverdue <= 120) return 'd91_120';
    return 'd120_plus';
  }

  // Aging-driven (or flat-percentage) allowance computation. Upserts the (tenant, as_of_date) row UNposted.
  async computeAllowance(dto: ComputeAllowanceDto, user: JwtUser) {
    const db = this.db;
    const asOf = dto.as_of_date ?? ymd();
    const method = dto.method ?? 'aging';
    const tenantId = dto.tenant_id ?? user.tenantId ?? null;
    const rates: Rates = { ...DEFAULT_RATES, ...(dto.bucket_rates ?? {}) };

    // Open AR as of the date (invoices dated on/before as_of, not fully paid). Outstanding = amount − paid.
    const rows = await db.select({
      due_date: arInvoices.dueDate,
      outstanding: sql<string>`${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)`,
    }).from(arInvoices).where(and(
      tenantId != null ? eq(arInvoices.tenantId, tenantId) : sql`true`,
      sql`${arInvoices.status}::text <> 'Paid'`,
      lt(arInvoices.invoiceDate, sql`(${asOf}::date + interval '1 day')`),
    ));

    const agg: Record<keyof Rates, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d91_120: 0, d120_plus: 0 };
    let totalAr = 0;
    for (const r of rows) {
      const out = n(r.outstanding);
      if (out <= 0.0001) continue;
      totalAr = round4(totalAr + out);
      const overdue = r.due_date ? Math.round((Date.parse(asOf) - Date.parse(String(r.due_date))) / 86400000) : 0;
      const b = this.bucketFor(overdue);
      agg[b] = round4(agg[b] + out);
    }

    let buckets: { bucket: string; label: string; outstanding: number; rate: number; provision: number }[];
    let allowance = 0;
    if (method === 'percentage') {
      const flat = dto.flat_rate ?? 0.02; // 2% of total AR by default
      allowance = round4(totalAr * flat);
      buckets = [{ bucket: 'total', label: 'Total AR × flat rate', outstanding: totalAr, rate: flat, provision: allowance }];
    } else {
      buckets = (Object.keys(agg) as (keyof Rates)[]).map((b) => {
        const provision = round4(agg[b] * rates[b]);
        allowance = round4(allowance + provision);
        return { bucket: b, label: BUCKET_LABELS[b], outstanding: round4(agg[b]), rate: rates[b], provision };
      });
    }

    // Upsert the (tenant, as_of_date) row UNposted (re-computing overwrites a still-unposted row; a posted
    // row for the same date is locked — recompute under a new date).
    const [existing] = await db.select().from(arAllowance)
      .where(and(tenantId != null ? eq(arAllowance.tenantId, tenantId) : sql`${arAllowance.tenantId} is null`, eq(arAllowance.asOfDate, asOf))).limit(1);
    if (existing?.posted) {
      throw new BadRequestException({ code: 'ALLOWANCE_POSTED', message: `Allowance for ${asOf} is already posted; compute under a new date`, messageTh: `ค่าเผื่อหนี้สงสัยจะสูญของ ${asOf} โพสต์แล้ว` });
    }
    let id: number;
    if (existing) {
      await db.update(arAllowance).set({ method, totalAr: String(totalAr), allowance: String(allowance), buckets, computedBy: user.username }).where(eq(arAllowance.id, existing.id));
      id = Number(existing.id);
    } else {
      const [ins] = await db.insert(arAllowance).values({ tenantId, asOfDate: asOf, method, totalAr: String(totalAr), allowance: String(allowance), buckets, computedBy: user.username }).returning({ id: arAllowance.id });
      id = Number(ins!.id);
    }
    return { id, as_of_date: asOf, method, tenant_id: tenantId, total_ar: totalAr, allowance, buckets, posted: false };
  }

  // Maker-checker post: the poster MUST differ from the computer (SoD). Journals the DELTA vs the most-recent
  // PRIOR posted allowance for the tenant. Increase ⇒ Dr 5720 / Cr 1190; decrease ⇒ Dr 1190 / Cr 5720.
  async postAllowance(id: number, user: JwtUser, selfApprovalReason?: string | null) {
    if (!this.ledger) throw new BadRequestException({ code: 'LEDGER_UNAVAILABLE', message: 'Ledger not available', messageTh: 'ระบบบัญชีไม่พร้อมใช้งาน' });
    const db = this.db;
    const [row] = await db.select().from(arAllowance).where(eq(arAllowance.id, id)).limit(1);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Allowance computation not found', messageTh: 'ไม่พบการคำนวณค่าเผื่อ' });
    if (row.posted) throw new BadRequestException({ code: 'ALREADY_POSTED', message: 'This allowance is already posted', messageTh: 'ค่าเผื่อนี้โพสต์แล้ว' });
    await assertMakerChecker(db, { user, maker: row.computedBy, event: 'ar.allowance.post', ref: String(id), amount: n(row.allowance), reason: selfApprovalReason, code: 'SOD_SELF_POST', message: 'Maker-checker: you cannot post an allowance you computed', messageTh: 'ผู้คำนวณค่าเผื่อโพสต์เองไม่ได้ (แบ่งแยกหน้าที่)' });
    // Prior posted allowance (most recent posted as-of before this one) sets the carrying balance of 1190.
    const [prior] = await db.select().from(arAllowance)
      .where(and(
        row.tenantId != null ? eq(arAllowance.tenantId, row.tenantId) : sql`${arAllowance.tenantId} is null`,
        eq(arAllowance.posted, true), lt(arAllowance.asOfDate, row.asOfDate),
      )).orderBy(desc(arAllowance.asOfDate)).limit(1);
    const priorAllowance = prior ? n(prior.allowance) : 0;
    const target = n(row.allowance);
    const delta = round4(target - priorAllowance);

    let entryNo: string | null = null;
    if (Math.abs(delta) >= 0.0001) {
      const lines = delta > 0
        ? [{ account_code: BAD_DEBT_EXPENSE, debit: delta }, { account_code: ALLOWANCE_CONTRA, credit: delta }]
        : [{ account_code: ALLOWANCE_CONTRA, debit: -delta }, { account_code: BAD_DEBT_EXPENSE, credit: -delta }];
      const je: any = await this.ledger.postEntry({
        date: row.asOfDate, source: 'AR-ALLOW', sourceRef: `ALLOW-${id}`, tenantId: row.tenantId ?? null,
        memo: `ค่าเผื่อหนี้สงสัยจะสูญ ${row.asOfDate} (Δ ${delta})`, createdBy: user.username, lines,
      });
      entryNo = je.entry_no;
    }
    await db.update(arAllowance).set({ posted: true, postedBy: user.username, postedEntryId: null, postedAmount: String(delta), postedAt: new Date() }).where(eq(arAllowance.id, id));
    return { id, as_of_date: row.asOfDate, prior_allowance: priorAllowance, target_allowance: target, posted_amount: delta, entry_no: entryNo, posted: true, posted_by: user.username };
  }

  async list(tenantId?: number | null) {
    const db = this.db;
    const rows = await db.select().from(arAllowance)
      .where(tenantId != null ? eq(arAllowance.tenantId, tenantId) : undefined)
      .orderBy(desc(arAllowance.asOfDate), desc(arAllowance.id)).limit(200);
    return {
      allowances: rows.map((r: any) => ({ id: Number(r.id), as_of_date: r.asOfDate, method: r.method, total_ar: n(r.totalAr), allowance: n(r.allowance), buckets: r.buckets, posted: r.posted, posted_amount: r.postedAmount != null ? n(r.postedAmount) : null, computed_by: r.computedBy, posted_by: r.postedBy })),
      count: rows.length,
    };
  }
}

function round4(x: number) { return Math.round(x * 10000) / 10000; }
