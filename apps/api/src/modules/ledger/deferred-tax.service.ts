import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, lt, sql, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { deferredTaxRuns, arAllowance, fixedAssets } from '../../database/schema';
import { LedgerService } from './ledger.service';
import { currentTenantStore } from '../../common/tenant-context';
import { n } from '../../database/queries';
import { assertMakerChecker } from '../../common/control-profile';
import type { JwtUser } from '../../common/decorators';

// WS3.2 — Deferred tax (TAS 12 / TFRS, TAX-06). A maker-checker, idempotent-per-(tenant,period) run that
// computes deferred tax from book-vs-tax TEMPORARY differences and posts the DELTA vs the prior posted run.
//
// TEMPORARY DIFFERENCES gathered:
//   1. AR allowance for doubtful accounts (deductible temp diff). Book recognises the allowance now, but tax
//      deducts the loss only on write-off → bookBasis (carrying AR net of allowance) < taxBasis (gross AR for
//      tax). difference = −allowance (book < tax) ⇒ a DEDUCTIBLE temp diff ⇒ DTA = allowance × taxRate.
//   2. Accelerated depreciation (taxable temp diff). Tax depreciation is faster than book, so tax NBV < book
//      NBV. difference = bookNBV − taxNBV > 0 ⇒ a TAXABLE temp diff ⇒ DTL = difference × taxRate.
//
// TAX-DEPRECIATION BASIS (FIN-6a — parallel tax book): an asset that maintains a real parallel TAX book
// (fixed_assets.tax_net_book_value NOT NULL — seeded at acquisition, advanced by
// AssetsService.runTaxDepreciation with Thai tax caps + first-year initial allowances) contributes its ACTUAL
// tax NBV to the temporary difference — so the difference feeds the deferred-tax module directly instead of a
// manual GAAP adjustment. An asset WITHOUT a tax book falls back to the documented approximation: tax
// depreciation runs FASTER than book by a factor TAX_DEP_FACTOR (default 1.5 — Thai Revenue-Code
// accelerated/initial allowances), capping tax accumulated depreciation at the depreciable base (cost −
// salvage): tax_accum_dep = min(book_accum_dep × factor, cost − salvage); tax_nbv = cost − tax_accum_dep.
// Override the fallback factor per run via dto.taxDepFactor.
//
// DTA/DTL SIGN CONVENTION (and the GL posting of the period DELTA):
//   net_deferred = DTA − DTL (+ve ⇒ net deferred tax asset). delta = net_deferred − prior posted net_deferred.
//   An INCREASE in the net asset (delta > 0) is a deferred tax BENEFIT: Dr 1700 DTA / Cr 5950 (a credit to
//   5950 reduces tax expense). A DECREASE (delta < 0) is a deferred tax CHARGE: Dr 5950 / Cr 1700.
//   We carry the net on account 1700 for simplicity (a net asset position); if you prefer split presentation,
//   the same delta could be apportioned 1700/2700 — the P&L (5950) and net effect are identical. DTL account
//   2700 exists in the COA for that presentation/disclosure.

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;
const DTA = '1700';
const DEFERRED_TAX_EXPENSE = '5950';
const DEFAULT_TAX_RATE = 0.20;       // Thai CIT 20%
const DEFAULT_TAX_DEP_FACTOR = 1.5;  // tax depreciation assumed 1.5× faster than book (documented simplification)

export interface RunDeferredTaxDto { period: string; asOfDate?: string; taxRate?: number; taxDepFactor?: number; runBy: string; tenantId?: number | null }
export interface PostDeferredTaxDto { id: number; postedBy: string }

@Injectable()
export class DeferredTaxService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
  ) {}

  private tenant(explicit?: number | null): number | null {
    if (explicit !== undefined && explicit !== null) return explicit;
    return currentTenantStore()?.tenantId ?? null;
  }
  private periodEndDate(period: string): string {
    const [y, m] = period.split('-').map(Number);
    const last = new Date(Date.UTC(y!, m, 0)).getUTCDate();
    return `${period}-${String(last).padStart(2, '0')}`;
  }

  // runDeferredTax — gather temporary differences, compute DTA/DTL and the delta vs the prior posted run,
  // stage an 'Open' run. Idempotent: re-running an Open period updates it; a Posted period throws ALREADY_POSTED.
  async runDeferredTax(dto: RunDeferredTaxDto) {
    const db = this.db;
    const tenantId = this.tenant(dto.tenantId);
    const asOf = dto.asOfDate ?? this.periodEndDate(dto.period);
    const taxRate = dto.taxRate ?? DEFAULT_TAX_RATE;
    const depFactor = dto.taxDepFactor ?? DEFAULT_TAX_DEP_FACTOR;

    const [existing] = await db.select().from(deferredTaxRuns)
      .where(and(tenantId != null ? eq(deferredTaxRuns.tenantId, tenantId) : isNull(deferredTaxRuns.tenantId), eq(deferredTaxRuns.period, dto.period))).limit(1);
    if (existing?.status === 'Posted') {
      throw new BadRequestException({ code: 'ALREADY_POSTED', message: `Deferred tax for ${dto.period} is already posted`, messageTh: `ภาษีเงินได้รอการตัดบัญชีงวด ${dto.period} โพสต์แล้ว` });
    }

    const temp: { name: string; bookBasis: number; taxBasis: number; difference: number; dtAssetOrLiab: 'DTA' | 'DTL' }[] = [];

    // 1. AR allowance — the latest POSTED allowance for the tenant as of the period end (deductible temp diff).
    const [alw] = await db.select().from(arAllowance).where(and(
      tenantId != null ? eq(arAllowance.tenantId, tenantId) : isNull(arAllowance.tenantId),
      eq(arAllowance.posted, true), lt(arAllowance.asOfDate, sql`(${asOf}::date + interval '1 day')`),
    )).orderBy(desc(arAllowance.asOfDate), desc(arAllowance.id)).limit(1);
    const allowance = alw ? n(alw.allowance) : 0;
    if (allowance > 0) {
      // bookBasis = carrying AR (net of allowance) < taxBasis (gross AR, no allowance for tax). difference < 0
      // (book < tax) ⇒ deductible temp diff ⇒ DTA. Represent book/tax relative to the allowance amount.
      temp.push({ name: 'AR allowance for doubtful accounts', bookBasis: 0, taxBasis: allowance, difference: round4(-allowance), dtAssetOrLiab: 'DTA' });
    }

    // 2. Accelerated depreciation — book NBV vs assumed tax NBV across active assets (taxable temp diff).
    const faWhere = [sql`${fixedAssets.status}::text <> 'disposed'`];
    if (tenantId != null) faWhere.push(eq(fixedAssets.tenantId, tenantId));
    const assets = await db.select().from(fixedAssets).where(and(...faWhere));
    let bookNbvTotal = 0, taxNbvTotal = 0;
    for (const a of assets) {
      bookNbvTotal = round4(bookNbvTotal + n(a.netBookValue));
      if (a.taxNetBookValue != null) {
        // FIN-6a — the asset maintains a real parallel tax book: use its ACTUAL tax NBV.
        taxNbvTotal = round4(taxNbvTotal + n(a.taxNetBookValue));
      } else {
        // Fallback: no tax book on this asset → approximate with the accelerated-depreciation factor.
        const cost = n(a.acquireCost), salvage = n(a.salvageValue), bookAccum = n(a.accumulatedDepreciation);
        const depreciable = Math.max(0, cost - salvage);
        const taxAccum = Math.min(round4(bookAccum * depFactor), depreciable);
        taxNbvTotal = round4(taxNbvTotal + (cost - taxAccum));
      }
    }
    const depDiff = round4(bookNbvTotal - taxNbvTotal); // bookNBV − taxNBV > 0 ⇒ taxable temp diff ⇒ DTL
    if (Math.abs(depDiff) > 1e-9) {
      temp.push({ name: 'Accelerated depreciation (book NBV vs tax NBV)', bookBasis: bookNbvTotal, taxBasis: taxNbvTotal, difference: depDiff, dtAssetOrLiab: depDiff >= 0 ? 'DTL' : 'DTA' });
    }

    // DTA from deductible (negative) differences; DTL from taxable (positive) differences.
    let dta = 0, dtl = 0;
    for (const d of temp) {
      const tax = round4(Math.abs(d.difference) * taxRate);
      if (d.dtAssetOrLiab === 'DTA') dta = round4(dta + tax);
      else dtl = round4(dtl + tax);
    }
    const netDeferred = round4(dta - dtl);

    // Prior POSTED run (most recent before this period) sets the carrying net deferred balance.
    const [prior] = await db.select().from(deferredTaxRuns).where(and(
      tenantId != null ? eq(deferredTaxRuns.tenantId, tenantId) : isNull(deferredTaxRuns.tenantId),
      eq(deferredTaxRuns.status, 'Posted'), lt(deferredTaxRuns.period, dto.period),
    )).orderBy(desc(deferredTaxRuns.period), desc(deferredTaxRuns.id)).limit(1);
    const priorNet = prior ? n(prior.netDeferred) : 0;
    const delta = round4(netDeferred - priorNet);

    let id: number;
    const vals = { asOfDate: asOf, taxRate: String(taxRate), tempDifferences: temp, dta: String(dta), dtl: String(dtl), netDeferred: String(netDeferred), deltaPosted: String(delta), runBy: dto.runBy };
    if (existing) {
      await db.update(deferredTaxRuns).set(vals).where(eq(deferredTaxRuns.id, existing.id));
      id = Number(existing.id);
    } else {
      const [ins] = await db.insert(deferredTaxRuns).values({ tenantId, period: dto.period, status: 'Open', ...vals }).returning({ id: deferredTaxRuns.id });
      id = Number(ins!.id);
    }
    return { id, period: dto.period, as_of_date: asOf, status: 'Open', tenant_id: tenantId, tax_rate: taxRate, temp_differences: temp, dta, dtl, net_deferred: netDeferred, prior_net: priorNet, delta_posted: delta };
  }

  // postDeferredTax — maker-checker post of an Open run (poster ≠ runner ⇒ SELF_POST). Posts the period
  // DELTA to 1700/5950 per the sign convention above; marks the run Posted. A Posted run throws ALREADY_POSTED.
  async postDeferredTax(dto: PostDeferredTaxDto, user: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const [run] = await db.select().from(deferredTaxRuns).where(eq(deferredTaxRuns.id, dto.id)).limit(1);
    if (!run) throw new NotFoundException({ code: 'DT_RUN_NOT_FOUND', message: `Deferred tax run ${dto.id} not found`, messageTh: `ไม่พบรายการภาษีเงินได้รอการตัดบัญชี ${dto.id}` });
    if (run.status === 'Posted') throw new BadRequestException({ code: 'ALREADY_POSTED', message: 'This deferred tax run is already posted', messageTh: 'รายการนี้โพสต์แล้ว' });
    if (run.runBy && run.runBy === dto.postedBy) {
      await assertMakerChecker(db, { user, maker: user.username, event: 'gl.deferred-tax.post', ref: String(dto.id), reason: selfApprovalReason, code: 'SELF_POST', message: 'Maker-checker: you cannot post a deferred tax run you ran', messageTh: 'ผู้คำนวณโพสต์รายการของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    const delta = round4(n(run.deltaPosted));
    let entryNo: string | null = null;
    if (Math.abs(delta) >= 0.0001) {
      // delta > 0 (net asset up) ⇒ deferred tax benefit: Dr 1700 / Cr 5950. delta < 0 ⇒ Dr 5950 / Cr 1700.
      const lines = delta > 0
        ? [{ account_code: DTA, debit: delta }, { account_code: DEFERRED_TAX_EXPENSE, credit: delta }]
        : [{ account_code: DEFERRED_TAX_EXPENSE, debit: -delta }, { account_code: DTA, credit: -delta }];
      const je: any = await this.ledger.postEntry({
        date: run.asOfDate, source: 'DEFTAX', sourceRef: `DT-${Number(run.id)}`, tenantId: run.tenantId ?? null, currency: 'THB',
        memo: `Deferred tax ${run.period} (Δ ${delta})`, createdBy: dto.postedBy, lines,
      });
      entryNo = je.entry_no;
    }
    await db.update(deferredTaxRuns).set({ status: 'Posted', postedBy: dto.postedBy, postedAt: new Date() }).where(eq(deferredTaxRuns.id, run.id));
    return { id: Number(run.id), period: run.period, status: 'Posted', net_deferred: n(run.netDeferred), delta_posted: delta, entry_no: entryNo, posted_by: dto.postedBy };
  }

  async list(tenantId?: number | null) {
    const db = this.db;
    const tid = this.tenant(tenantId);
    const rows = await db.select().from(deferredTaxRuns)
      .where(tid != null ? eq(deferredTaxRuns.tenantId, tid) : undefined)
      .orderBy(desc(deferredTaxRuns.period), desc(deferredTaxRuns.id)).limit(200);
    return { runs: rows.map(shape), count: rows.length };
  }
  async get(id: number) {
    const db = this.db;
    const [r] = await db.select().from(deferredTaxRuns).where(eq(deferredTaxRuns.id, id)).limit(1);
    if (!r) throw new NotFoundException({ code: 'DT_RUN_NOT_FOUND', message: `Deferred tax run ${id} not found`, messageTh: `ไม่พบรายการภาษีเงินได้รอการตัดบัญชี ${id}` });
    return shape(r);
  }
}

function shape(r: any) {
  return {
    id: Number(r.id), period: r.period, as_of_date: r.asOfDate, status: r.status, tax_rate: n(r.taxRate),
    temp_differences: r.tempDifferences, dta: n(r.dta), dtl: n(r.dtl), net_deferred: n(r.netDeferred),
    delta_posted: n(r.deltaPosted), run_by: r.runBy, posted_by: r.postedBy, posted_at: r.postedAt, created_at: r.createdAt,
  };
}
