import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, desc, lte, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { incomeTaxProvisions, deferredTaxRuns } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { currentTenantStore } from '../../common/tenant-context';
import { n } from '../../database/queries';

// TAX-11 — Current income-tax provision + ETR reconciliation (ASC 740 / IAS 12, current side). A
// maker-checker, idempotent-per-(tenant,period) run that bridges book → tax:
//
//   pretax book income (ledger.incomeStatement over [from,to])
//     + Σ permanent book-to-tax adjustments          (non-deductible expenses +, tax-exempt income −)
//     + temporary book-to-tax adjustment             (REUSED from the deferred-tax run, TAX-06)
//     = taxable income
//   current tax  = taxable income × statutory rate   (CIT payable this period)
//
// The temporary adjustment is DERIVED from the linked deferred-tax run's period delta so the two modules
// never disagree: deferred posts the change in the net DTA/DTL; the current side takes the ORIGINATING
// temporary difference that produced it. For a taxable temp diff originating this period (accelerated
// depreciation) the net DTA falls (delta < 0) and taxable income is BELOW book — so the bridge subtracts
// (delta / rate). For a deductible temp diff (AR allowance) the net DTA rises (delta > 0) and taxable income
// is ABOVE book — the bridge adds (delta / rate). Hence:  temporaryAdjustment = deltaNetDeferred / rate.
//
// ETR RECONCILIATION (statutory → effective). Temporary differences do NOT move total tax expense (they only
// shift between current and deferred), so the reconciliation from the statutory rate to the effective rate is
// driven by PERMANENT differences, rate changes, valuation allowance and other prior-deferred items:
//   statutory tax (pretax × rate)
//     + permanent differences × rate
//     + rate-change effect on the deferred balance
//     + valuation-allowance impact
//     + other / prior-year deferred adjustments
//     = total income-tax expense  (= current tax + deferred tax + VA + rate-change + other)
//   effective rate = total income-tax expense / pretax book income
// This ties by construction: current = (pretax + perm + delta/rate)×rate = pretax×rate + perm×rate + delta,
// and deferred = −delta, so current + deferred = pretax×rate + perm×rate = statutory + permanent×rate.
//
// The provision JE books ONLY the current tax (Dr 5960 / Cr 2110); the deferred leg is posted by TAX-06.

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;
const CIT_EXPENSE = '5960';
const CIT_PAYABLE = '2110';
const DEFAULT_STATUTORY_RATE = 0.20; // Thai CIT 20%

export interface PermanentDiff { name: string; amount: number }
export interface RunProvisionDto {
  period: string;                 // 'YYYY-MM' — keys the deferred-tax link
  from?: string;                  // P&L window start (default: period month start)
  to?: string;                    // P&L window end (default: period month end)
  fiscalYear?: number;
  statutoryRate?: number;
  permanentDiffs?: PermanentDiff[];
  valuationAllowance?: number;
  rateChangeEffect?: number;
  otherAdjustments?: number;
  linkDeferred?: boolean;         // default true — pull the deferred-tax run for the period
  tenantId?: number | null;
  runBy: string;
}
export interface PostProvisionDto { id: number; postedBy: string }

@Injectable()
export class TaxProvisionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
  ) {}

  private tenant(explicit?: number | null): number | null {
    if (explicit !== undefined && explicit !== null) return explicit;
    return currentTenantStore()?.tenantId ?? null;
  }
  private monthStart(period: string): string { return `${period}-01`; }
  private monthEnd(period: string): string {
    const [y, m] = period.split('-').map(Number);
    const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
    return `${period}-${String(last).padStart(2, '0')}`;
  }

  // runProvision — compute the current provision + ETR schedule and stage an 'Open' row. Idempotent:
  // re-running an Open period updates it; a Posted period throws ALREADY_POSTED.
  async runProvision(dto: RunProvisionDto) {
    const db = this.db;
    const tenantId = this.tenant(dto.tenantId);
    const from = dto.from ?? this.monthStart(dto.period);
    const to = dto.to ?? this.monthEnd(dto.period);
    const rate = dto.statutoryRate ?? DEFAULT_STATUTORY_RATE;
    const va = round4(dto.valuationAllowance ?? 0);
    const rateChange = round4(dto.rateChangeEffect ?? 0);
    const other = round4(dto.otherAdjustments ?? 0);
    const linkDeferred = dto.linkDeferred !== false;

    const [existing] = await db.select().from(incomeTaxProvisions)
      .where(and(tenantId != null ? eq(incomeTaxProvisions.tenantId, tenantId) : isNull(incomeTaxProvisions.tenantId), eq(incomeTaxProvisions.period, dto.period))).limit(1);
    if (existing?.status === 'Posted') {
      throw new BadRequestException({ code: 'ALREADY_POSTED', message: `Income-tax provision for ${dto.period} is already posted`, messageTh: `ประมาณการภาษีเงินได้งวด ${dto.period} โพสต์แล้ว` });
    }

    // 1. Pretax book income from the income statement (leading ledger, tenant-scoped by the RLS session).
    //    Exclude income-tax postings (DEFTAX deferred + CITPROV current) so the base is genuinely PRE-TAX and
    //    idempotent — a prior run's tax JE must not feed back into this period's pretax.
    const is = await this.ledger.incomeStatement(from, to, undefined, undefined, ['DEFTAX', 'CITPROV']);
    const pretax = round4(n(is.net_income));

    // 2. Permanent book-to-tax adjustments (caller-supplied M-1 items).
    const perms = (dto.permanentDiffs ?? []).map((p) => ({ name: p.name, amount: round4(p.amount) }));
    const permTotal = round4(perms.reduce((s, p) => s + p.amount, 0));

    // 3. Temporary book-to-tax adjustment — REUSED from the deferred-tax run for the period (or the latest
    //    posted run ≤ period). deltaNetDeferred / deferredRate = the originating temporary difference.
    let deferredLink: any = null;
    let tempAdj = 0;
    if (linkDeferred) {
      const [dtRun] = await db.select().from(deferredTaxRuns).where(and(
        tenantId != null ? eq(deferredTaxRuns.tenantId, tenantId) : isNull(deferredTaxRuns.tenantId),
        lte(deferredTaxRuns.period, dto.period),
      )).orderBy(desc(deferredTaxRuns.period), desc(deferredTaxRuns.id)).limit(1);
      if (dtRun) {
        const dRate = n(dtRun.taxRate) || rate;
        const delta = round4(n(dtRun.deltaPosted));
        tempAdj = dRate !== 0 ? round4(delta / dRate) : 0;
        const deferredTaxExpense = round4(-delta); // net DTA up (delta>0) ⇒ benefit (−); down ⇒ charge (+)
        deferredLink = {
          run_id: Number(dtRun.id), period: dtRun.period, status: dtRun.status,
          net_deferred: n(dtRun.netDeferred), delta, deferred_tax_expense: deferredTaxExpense, tax_rate: dRate,
          temp_differences: dtRun.tempDifferences ?? [],
        };
      }
    }
    const deferredTaxExpense = deferredLink ? round4(deferredLink.deferred_tax_expense) : 0;

    // 4. Taxable income + current tax.
    const taxable = round4(pretax + permTotal + tempAdj);
    const currentTax = round4(taxable * rate);

    // 5. Total income-tax expense + effective rate.
    const totalProvision = round4(currentTax + deferredTaxExpense + va + rateChange + other);
    const effectiveRate = pretax !== 0 ? round4(totalProvision / pretax) : 0;

    // 6. ETR reconciliation schedule (statutory → effective).
    const etrLines = this.buildEtrLines({ pretax, rate, permTotal, rateChange, va, other, totalProvision });

    const vals = {
      fiscalYear: dto.fiscalYear ?? null, fromDate: from, toDate: to,
      pretaxBookIncome: String(pretax), permanentDiffs: perms, temporaryDiffs: deferredLink?.temp_differences ?? [],
      permanentAdjTotal: String(permTotal), temporaryAdjTotal: String(tempAdj), taxableIncome: String(taxable),
      statutoryRate: String(rate), currentTax: String(currentTax), valuationAllowance: String(va),
      rateChangeEffect: String(rateChange), otherAdjustments: String(other), deferredTaxLink: deferredLink,
      totalProvision: String(totalProvision), effectiveRate: String(effectiveRate), etrLines, runBy: dto.runBy,
    };

    let id: number;
    if (existing) {
      await db.update(incomeTaxProvisions).set(vals).where(eq(incomeTaxProvisions.id, existing.id));
      id = Number(existing.id);
    } else {
      const [ins] = await db.insert(incomeTaxProvisions).values({ tenantId, period: dto.period, status: 'Open', ...vals }).returning({ id: incomeTaxProvisions.id });
      id = Number(ins!.id);
    }
    const [row] = await db.select().from(incomeTaxProvisions).where(eq(incomeTaxProvisions.id, id)).limit(1);
    return shape(row);
  }

  private buildEtrLines(a: { pretax: number; rate: number; permTotal: number; rateChange: number; va: number; other: number; totalProvision: number }) {
    const pct = (tax: number) => (a.pretax !== 0 ? round4(tax / a.pretax) : 0);
    const statutory = round4(a.pretax * a.rate);
    const permEffect = round4(a.permTotal * a.rate);
    const lines = [
      { key: 'statutory', label: 'ภาษีตามอัตราตามกฎหมาย (Income tax at statutory rate)', base: a.pretax, rate: a.rate, tax_effect: statutory, pct: pct(statutory) },
      { key: 'permanent', label: 'ผลต่างถาวร (Permanent differences)', base: a.permTotal, rate: a.rate, tax_effect: permEffect, pct: pct(permEffect) },
      { key: 'rate_change', label: 'ผลจากการเปลี่ยนอัตราภาษี (Effect of tax-rate changes)', base: null, rate: null, tax_effect: a.rateChange, pct: pct(a.rateChange) },
      { key: 'valuation_allowance', label: 'ค่าเผื่อการด้อยค่าสินทรัพย์ภาษี (Valuation allowance)', base: null, rate: null, tax_effect: a.va, pct: pct(a.va) },
      { key: 'other', label: 'รายการภาษีรอตัดบัญชีอื่น/งวดก่อน (Other / prior-year deferred)', base: null, rate: null, tax_effect: a.other, pct: pct(a.other) },
      { key: 'effective', label: 'ค่าใช้จ่ายภาษีเงินได้รวม (Total income-tax expense / effective)', base: a.pretax, rate: pct(a.totalProvision), tax_effect: a.totalProvision, pct: pct(a.totalProvision) },
    ];
    return lines;
  }

  // postProvision — maker-checker post of an Open row (poster ≠ runner ⇒ SOD_SELF_APPROVAL). Posts the
  // CURRENT tax (Dr 5960 / Cr 2110); marks Posted. A Posted row throws ALREADY_POSTED.
  async postProvision(dto: PostProvisionDto) {
    const db = this.db;
    const [row] = await db.select().from(incomeTaxProvisions).where(eq(incomeTaxProvisions.id, dto.id)).limit(1);
    if (!row) throw new NotFoundException({ code: 'PROVISION_NOT_FOUND', message: `Income-tax provision ${dto.id} not found`, messageTh: `ไม่พบประมาณการภาษีเงินได้ ${dto.id}` });
    if (row.status === 'Posted') throw new BadRequestException({ code: 'ALREADY_POSTED', message: 'This income-tax provision is already posted', messageTh: 'ประมาณการนี้โพสต์แล้ว' });
    if (row.runBy && row.runBy === dto.postedBy) {
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot post an income-tax provision you ran', messageTh: 'ผู้คำนวณโพสต์ประมาณการของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    const currentTax = round4(n(row.currentTax));
    let entryNo: string | null = null;
    if (Math.abs(currentTax) >= 0.0001) {
      // currentTax > 0 ⇒ Dr 5960 expense / Cr 2110 payable. A negative (tax benefit) reverses the legs.
      const lines = currentTax > 0
        ? [{ account_code: CIT_EXPENSE, debit: currentTax }, { account_code: CIT_PAYABLE, credit: currentTax }]
        : [{ account_code: CIT_PAYABLE, debit: -currentTax }, { account_code: CIT_EXPENSE, credit: -currentTax }];
      const je: any = await this.ledger.postEntry({
        date: row.toDate, source: 'CITPROV', sourceRef: `CIT-${Number(row.id)}`, tenantId: row.tenantId ?? null, currency: 'THB',
        memo: `Current income-tax provision ${row.period} (CIT ${currentTax})`, createdBy: dto.postedBy, lines,
      });
      entryNo = je.entry_no;
    }
    await db.update(incomeTaxProvisions).set({ status: 'Posted', postedBy: dto.postedBy, postedAt: new Date(), postedEntryId: entryNo }).where(eq(incomeTaxProvisions.id, row.id));
    const [updated] = await db.select().from(incomeTaxProvisions).where(eq(incomeTaxProvisions.id, row.id)).limit(1);
    return shape(updated);
  }

  async list(tenantId?: number | null) {
    const db = this.db;
    const tid = this.tenant(tenantId);
    const rows = await db.select().from(incomeTaxProvisions)
      .where(tid != null ? eq(incomeTaxProvisions.tenantId, tid) : undefined)
      .orderBy(desc(incomeTaxProvisions.period), desc(incomeTaxProvisions.id)).limit(200);
    return { provisions: rows.map(shape), count: rows.length };
  }
  async get(id: number) {
    const db = this.db;
    const [r] = await db.select().from(incomeTaxProvisions).where(eq(incomeTaxProvisions.id, id)).limit(1);
    if (!r) throw new NotFoundException({ code: 'PROVISION_NOT_FOUND', message: `Income-tax provision ${id} not found`, messageTh: `ไม่พบประมาณการภาษีเงินได้ ${id}` });
    return shape(r);
  }
  // etr — the standalone ETR reconciliation schedule (statutory → effective) for a provision row.
  async etr(id: number) {
    const p = await this.get(id);
    return {
      id: p.id, period: p.period, pretax_book_income: p.pretax_book_income, statutory_rate: p.statutory_rate,
      total_provision: p.total_provision, effective_rate: p.effective_rate, lines: p.etr_lines,
    };
  }
}

function shape(r: any) {
  return {
    id: Number(r.id), period: r.period, fiscal_year: r.fiscalYear, from: r.fromDate, to: r.toDate,
    pretax_book_income: n(r.pretaxBookIncome), permanent_diffs: r.permanentDiffs ?? [], temporary_diffs: r.temporaryDiffs ?? [],
    permanent_adj_total: n(r.permanentAdjTotal), temporary_adj_total: n(r.temporaryAdjTotal), taxable_income: n(r.taxableIncome),
    statutory_rate: n(r.statutoryRate), current_tax: n(r.currentTax), valuation_allowance: n(r.valuationAllowance),
    rate_change_effect: n(r.rateChangeEffect), other_adjustments: n(r.otherAdjustments), deferred_tax_link: r.deferredTaxLink ?? null,
    total_provision: n(r.totalProvision), effective_rate: n(r.effectiveRate), etr_lines: r.etrLines ?? [],
    status: r.status, posted_entry_id: r.postedEntryId ?? null, run_by: r.runBy, posted_by: r.postedBy,
    posted_at: r.postedAt, created_at: r.createdAt,
  };
}
