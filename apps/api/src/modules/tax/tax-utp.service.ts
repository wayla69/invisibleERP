import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, desc, lt, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { dtaValuationAllowances, uncertainTaxPositions, deferredTaxRuns } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { DocNumberService } from '../../common/doc-number.service';
import { currentTenantStore } from '../../common/tenant-context';
import { n } from '../../database/queries';

// TAX-12 — ASC 740 income-tax disclosures on top of the deferred-tax engine (TAX-06):
//   1. DTA valuation allowance — a more-likely-than-not (MLTN) recoverability assessment on the GROSS deferred
//      tax asset. allowance = max(0, dta_gross − mltn_recoverable). runValuationAllowance stages an 'Open' row
//      per (tenant, period); postValuationAllowance is maker-checker (poster ≠ runner) and posts the DELTA vs
//      the prior posted allowance to the contra-DTA / deferred-tax-expense accounts (1700/5950).
//   2. Uncertain Tax Positions (FIN 48 / ASC 740-10) — a MEMO register (no GL leg; the reserve is a
//      disclosure): position, tax year, gross exposure, recognized benefit, reserve, interest/penalty accrual,
//      status Open|Settled|Lapsed. createUtp records the position; settleUtp is maker-checker (settler ≠ creator).

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;
const DTA = '1700';                  // Deferred Tax Asset (contra when the VA is booked)
const DEFERRED_TAX_EXPENSE = '5950'; // Deferred Tax Expense (the VA charge/benefit)

export interface RunVaDto { period: string; asOfDate?: string; dtaGross?: number; mltnRecoverable: number; basis?: string; runBy: string; tenantId?: number | null }
export interface PostVaDto { id: number; postedBy: string }
export interface CreateUtpDto { taxYear: number; description: string; grossExposure: number; recognizedBenefit?: number; interestPenalty?: number; createdBy: string; tenantId?: number | null }
export interface SettleUtpDto { id: number; status?: 'Settled' | 'Lapsed'; settlementAmount?: number; settlementNote?: string; settledBy: string }

@Injectable()
export class TaxUtpService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
    private readonly docNo: DocNumberService,
  ) {}

  private tenant(explicit?: number | null): number | null {
    if (explicit !== undefined && explicit !== null) return explicit;
    return currentTenantStore()?.tenantId ?? null;
  }
  private periodEndDate(period: string): string {
    const [y, m] = period.split('-').map(Number);
    const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
    return `${period}-${String(last).padStart(2, '0')}`;
  }
  private tenantEq(col: any, tid: number | null) {
    return tid != null ? eq(col, tid) : isNull(col);
  }

  // ───────────────────────── DTA valuation allowance ─────────────────────────
  // runValuationAllowance — resolve the gross DTA (explicit, else the latest deferred_tax_runs.dta for the
  // tenant), compute allowance = max(0, dta_gross − mltn_recoverable) and the delta vs the prior posted
  // allowance, stage an 'Open' row. Idempotent per (tenant, period); a Posted period throws ALREADY_POSTED.
  async runValuationAllowance(dto: RunVaDto) {
    const db = this.db;
    const tenantId = this.tenant(dto.tenantId);
    const asOf = dto.asOfDate ?? this.periodEndDate(dto.period);
    const mltn = round4(dto.mltnRecoverable);
    if (mltn < 0) throw new BadRequestException({ code: 'INVALID_MLTN', message: 'MLTN-recoverable amount cannot be negative', messageTh: 'จำนวนที่คาดว่าจะได้รับคืน (MLTN) ต้องไม่ติดลบ' });

    // gross DTA: explicit dto, else the most recent deferred_tax_runs row for the tenant (TAX-06 spine).
    let dtaGross = dto.dtaGross != null ? round4(dto.dtaGross) : 0;
    if (dto.dtaGross == null) {
      const [dt] = await db.select().from(deferredTaxRuns)
        .where(this.tenantEq(deferredTaxRuns.tenantId, tenantId))
        .orderBy(desc(deferredTaxRuns.period), desc(deferredTaxRuns.id)).limit(1);
      dtaGross = dt ? round4(n(dt.dta)) : 0;
    }
    if (dtaGross < 0) throw new BadRequestException({ code: 'INVALID_DTA', message: 'Gross DTA cannot be negative', messageTh: 'สินทรัพย์ภาษีเงินได้รอตัดบัญชี (ก่อนค่าเผื่อ) ต้องไม่ติดลบ' });

    const allowance = round4(Math.max(0, dtaGross - mltn));

    const [existing] = await db.select().from(dtaValuationAllowances)
      .where(and(this.tenantEq(dtaValuationAllowances.tenantId, tenantId), eq(dtaValuationAllowances.period, dto.period))).limit(1);
    if (existing?.status === 'Posted') {
      throw new BadRequestException({ code: 'ALREADY_POSTED', message: `Valuation allowance for ${dto.period} is already posted`, messageTh: `ค่าเผื่อการด้อยค่างวด ${dto.period} โพสต์แล้ว` });
    }

    // Prior POSTED allowance (most recent before this period) sets the carrying allowance balance.
    const [prior] = await db.select().from(dtaValuationAllowances).where(and(
      this.tenantEq(dtaValuationAllowances.tenantId, tenantId),
      eq(dtaValuationAllowances.status, 'Posted'), lt(dtaValuationAllowances.period, dto.period),
    )).orderBy(desc(dtaValuationAllowances.period), desc(dtaValuationAllowances.id)).limit(1);
    const priorAllowance = prior ? round4(n(prior.allowance)) : 0;
    const delta = round4(allowance - priorAllowance);

    const vals = { asOfDate: asOf, dtaGross: String(dtaGross), mltnRecoverable: String(mltn), allowance: String(allowance), deltaPosted: String(delta), basis: dto.basis ?? null, runBy: dto.runBy };
    let id: number;
    if (existing) {
      await db.update(dtaValuationAllowances).set(vals).where(eq(dtaValuationAllowances.id, existing.id));
      id = Number(existing.id);
    } else {
      const [ins] = await db.insert(dtaValuationAllowances).values({ tenantId, period: dto.period, status: 'Open', ...vals }).returning({ id: dtaValuationAllowances.id });
      id = Number(ins!.id);
    }
    return { id, period: dto.period, as_of_date: asOf, status: 'Open', tenant_id: tenantId, dta_gross: dtaGross, mltn_recoverable: mltn, allowance, prior_allowance: priorAllowance, delta_posted: delta };
  }

  // postValuationAllowance — maker-checker post of an Open row (poster ≠ runner ⇒ SELF_POST). Posts the DELTA
  // (allowance increase = a charge: Dr 5950 / Cr 1700; a release: Dr 1700 / Cr 5950). Marks the row Posted.
  async postValuationAllowance(dto: PostVaDto) {
    const db = this.db;
    const [row] = await db.select().from(dtaValuationAllowances).where(eq(dtaValuationAllowances.id, dto.id)).limit(1);
    if (!row) throw new NotFoundException({ code: 'VA_NOT_FOUND', message: `Valuation allowance ${dto.id} not found`, messageTh: `ไม่พบรายการค่าเผื่อการด้อยค่า ${dto.id}` });
    if (row.status === 'Posted') throw new BadRequestException({ code: 'ALREADY_POSTED', message: 'This valuation allowance is already posted', messageTh: 'รายการนี้โพสต์แล้ว' });
    if (row.runBy && row.runBy === dto.postedBy) {
      throw new ForbiddenException({ code: 'SELF_POST', message: 'Maker-checker: you cannot post a valuation allowance you ran', messageTh: 'ผู้คำนวณโพสต์รายการของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    const delta = round4(n(row.deltaPosted));
    let entryNo: string | null = null;
    if (Math.abs(delta) >= 0.0001) {
      // delta > 0 (allowance up) ⇒ a deferred-tax CHARGE reducing the net DTA: Dr 5950 / Cr 1700.
      // delta < 0 (allowance released) ⇒ a benefit restoring the DTA: Dr 1700 / Cr 5950.
      const lines = delta > 0
        ? [{ account_code: DEFERRED_TAX_EXPENSE, debit: delta }, { account_code: DTA, credit: delta }]
        : [{ account_code: DTA, debit: -delta }, { account_code: DEFERRED_TAX_EXPENSE, credit: -delta }];
      const je: any = await this.ledger.postEntry({
        date: row.asOfDate, source: 'DTAVA', sourceRef: `VA-${Number(row.id)}`, tenantId: row.tenantId ?? null, currency: 'THB',
        memo: `DTA valuation allowance ${row.period} (Δ ${delta})`, createdBy: dto.postedBy, lines,
      });
      entryNo = je.entry_no;
    }
    await db.update(dtaValuationAllowances).set({ status: 'Posted', postedBy: dto.postedBy, postedAt: new Date() }).where(eq(dtaValuationAllowances.id, row.id));
    return { id: Number(row.id), period: row.period, status: 'Posted', allowance: n(row.allowance), delta_posted: delta, entry_no: entryNo, posted_by: dto.postedBy };
  }

  async listValuationAllowances(tenantId?: number | null) {
    const db = this.db;
    const tid = this.tenant(tenantId);
    const rows = await db.select().from(dtaValuationAllowances)
      .where(tid != null ? eq(dtaValuationAllowances.tenantId, tid) : undefined)
      .orderBy(desc(dtaValuationAllowances.period), desc(dtaValuationAllowances.id)).limit(200);
    return { allowances: rows.map(shapeVa), count: rows.length };
  }

  // ───────────────────────── Uncertain Tax Positions (FIN 48) ─────────────────────────
  async createUtp(dto: CreateUtpDto) {
    const db = this.db;
    const tenantId = this.tenant(dto.tenantId);
    const gross = round4(dto.grossExposure);
    const recognized = round4(dto.recognizedBenefit ?? 0);
    if (gross < 0 || recognized < 0) throw new BadRequestException({ code: 'INVALID_AMOUNT', message: 'Exposure/benefit cannot be negative', messageTh: 'ยอดความเสี่ยง/ผลประโยชน์ที่รับรู้ต้องไม่ติดลบ' });
    if (recognized > gross) throw new BadRequestException({ code: 'BENEFIT_EXCEEDS_EXPOSURE', message: 'Recognized benefit cannot exceed the gross exposure', messageTh: 'ผลประโยชน์ที่รับรู้ต้องไม่เกินยอดความเสี่ยงรวม' });
    const reserve = round4(gross - recognized);
    const positionNo = await this.docNo.nextDaily('UTP');
    const [ins] = await db.insert(uncertainTaxPositions).values({
      tenantId, positionNo, taxYear: dto.taxYear, description: dto.description,
      grossExposure: String(gross), recognizedBenefit: String(recognized), reserve: String(reserve),
      interestPenalty: String(round4(dto.interestPenalty ?? 0)), status: 'Open', createdBy: dto.createdBy,
    }).returning();
    return shapeUtp(ins!);
  }

  // settleUtp — maker-checker close of a position (settler ≠ creator ⇒ SELF_SETTLE). Sets Settled | Lapsed.
  async settleUtp(dto: SettleUtpDto) {
    const db = this.db;
    const [row] = await db.select().from(uncertainTaxPositions).where(eq(uncertainTaxPositions.id, dto.id)).limit(1);
    if (!row) throw new NotFoundException({ code: 'UTP_NOT_FOUND', message: `Uncertain tax position ${dto.id} not found`, messageTh: `ไม่พบสถานะภาษีที่ไม่แน่นอน ${dto.id}` });
    if (row.status !== 'Open') throw new BadRequestException({ code: 'NOT_OPEN', message: 'Only an Open position can be settled', messageTh: 'ปิดได้เฉพาะสถานะที่ยังเปิดอยู่' });
    if (row.createdBy && row.createdBy === dto.settledBy) {
      throw new ForbiddenException({ code: 'SELF_SETTLE', message: 'Maker-checker: you cannot settle a position you created', messageTh: 'ผู้บันทึกปิดรายการของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    const status = dto.status ?? 'Settled';
    await db.update(uncertainTaxPositions).set({
      status, settledBy: dto.settledBy, settledAt: new Date(),
      settlementAmount: dto.settlementAmount != null ? String(round4(dto.settlementAmount)) : null,
      settlementNote: dto.settlementNote ?? null,
    }).where(eq(uncertainTaxPositions.id, row.id));
    return { id: Number(row.id), position_no: row.positionNo, status, settled_by: dto.settledBy, settlement_amount: dto.settlementAmount != null ? round4(dto.settlementAmount) : null };
  }

  async listUtp(tenantId?: number | null) {
    const db = this.db;
    const tid = this.tenant(tenantId);
    const rows = await db.select().from(uncertainTaxPositions)
      .where(tid != null ? eq(uncertainTaxPositions.tenantId, tid) : undefined)
      .orderBy(desc(uncertainTaxPositions.taxYear), desc(uncertainTaxPositions.id)).limit(500);
    const totals = rows.reduce((a, r) => ({
      gross_exposure: round4(a.gross_exposure + n(r.grossExposure)),
      recognized_benefit: round4(a.recognized_benefit + n(r.recognizedBenefit)),
      reserve: round4(a.reserve + (r.status === 'Open' ? n(r.reserve) : 0)),
      interest_penalty: round4(a.interest_penalty + (r.status === 'Open' ? n(r.interestPenalty) : 0)),
    }), { gross_exposure: 0, recognized_benefit: 0, reserve: 0, interest_penalty: 0 });
    return { positions: rows.map(shapeUtp), count: rows.length, totals };
  }
}

function shapeVa(r: any) {
  return {
    id: Number(r.id), period: r.period, as_of_date: r.asOfDate, status: r.status, tenant_id: r.tenantId,
    dta_gross: n(r.dtaGross), mltn_recoverable: n(r.mltnRecoverable), allowance: n(r.allowance),
    delta_posted: n(r.deltaPosted), basis: r.basis, run_by: r.runBy, posted_by: r.postedBy,
    posted_at: r.postedAt, posted_entry_id: r.postedEntryId, created_at: r.createdAt,
  };
}
function shapeUtp(r: any) {
  return {
    id: Number(r.id), position_no: r.positionNo, tax_year: Number(r.taxYear), description: r.description,
    gross_exposure: n(r.grossExposure), recognized_benefit: n(r.recognizedBenefit), reserve: n(r.reserve),
    interest_penalty: n(r.interestPenalty), status: r.status,
    settlement_amount: r.settlementAmount != null ? n(r.settlementAmount) : null, settlement_note: r.settlementNote,
    created_by: r.createdBy, created_at: r.createdAt, settled_by: r.settledBy, settled_at: r.settledAt,
  };
}
