import { Inject, Injectable, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { eq, and, desc, sql, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { investments, investmentPrices, investmentValuations } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import { currentTenantStore } from '../../common/tenant-context';
import { ymd, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// ── Investment & Securities register (Track C Wave 2) — control TRE-03 ─────────────────────────────────────
// A security is bought under maker-checker (create → PendingApproval; a DIFFERENT user approves → the buy JE
// posts Dr <class asset 1350|1360|1370> / Cr 1010 Bank; self-approve → 403 SOD_SELF_APPROVAL, mirroring
// FX-04 / TRE-01). Classification drives measurement:
//   • AMORTIZED_COST → interest income accretes on the EIR amortized-cost carrying (Dr 1350 / Cr 4700), reusing
//     the Wave-1 periodic cursor + alreadyPosted idempotency; MTM is NOT applicable (measured at amortized cost).
//   • FVOCI          → mark-to-market moves through the OCI equity RESERVE 3500 (the reusable OCI-reserve
//     primitive Wave-3 hedge accounting builds on), NOT P&L.
//   • FVTPL          → mark-to-market moves through P&L 5430 fair-value gain/loss.
// MTM can only be driven by an APPROVED price from the maker-checker price register (an unapproved price is
// rejected — this IS the TRE-03 valuation control, mirroring FX-04). ECL impairment books Dr 5440 / Cr 1355
// allowance (contra-asset). Everything routes through LedgerService.postEntry (GL-05 balanced + period lock).

const CLASSES = ['AMORTIZED_COST', 'FVOCI', 'FVTPL'] as const;
type Classification = (typeof CLASSES)[number];

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const round6 = (x: number) => Math.round((Number(x) || 0) * 1e6) / 1e6;
function addMonth(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

export interface InvestmentDto {
  instrument: string;
  instrumentType?: string;        // 'bond' | 'equity' | 'fund'
  symbol?: string;
  classification?: string;        // AMORTIZED_COST | FVOCI | FVTPL
  currency?: string;
  quantity?: number;
  cost: number;
  eirPct?: number;                // effective annual interest rate % (amortized-cost accretion)
  tradeDate?: string;
  maturityDate?: string;
  tenantId?: number | null;
}
export interface PriceDto { symbol: string; priceDate: string; price: number; source?: string; tenantId?: number | null }
export interface RevalueDto { asOf?: string }
export interface ImpairDto { ecl: number; asOf?: string }
export interface AccrueDto { asOf?: string; amount?: number }

@Injectable()
export class InvestmentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    @Optional() private readonly ledger?: LedgerService,
  ) {}

  private tenant(explicit?: number | null, user?: JwtUser): number | null {
    if (explicit !== undefined && explicit !== null) return explicit;
    return currentTenantStore()?.tenantId ?? user?.tenantId ?? null;
  }

  // The class asset account a holding books to (buy debit / MTM asset leg / interest-accretion debit).
  private classAsset(cls: Classification): string {
    if (cls === 'FVOCI') return postingDefault('INVEST.MTM.OCI', 'investment_fvoci');  // 1360
    if (cls === 'FVTPL') return postingDefault('INVEST.MTM.PL', 'investment_fvtpl');   // 1370
    return postingDefault('INVEST.BUY', 'investment_ac');                              // 1350 AMORTIZED_COST
  }

  // ── Reusable OCI-reserve primitive (Wave 3 hedge accounting reuses this) ─────────────────────────────────
  // Park a fair-value delta in the FVOCI equity reserve (3500) against the asset leg. A gain (delta > 0) is
  // Dr asset / Cr 3500; a loss is Dr 3500 / Cr asset. Returns the balanced JE lines (empty when delta rounds to 0).
  private ociReserveLines(assetAccount: string, delta: number): any[] {
    const d = round2(delta);
    if (d === 0) return [];
    const reserve = postingDefault('INVEST.MTM.OCI', 'oci_reserve'); // 3500
    return d > 0
      ? [{ account_code: assetAccount, debit: d }, { account_code: reserve, credit: d }]
      : [{ account_code: assetAccount, credit: -d }, { account_code: reserve, debit: -d }];
  }
  // FVTPL analogue — a fair-value delta through P&L (5430). Gain (delta > 0): Dr asset / Cr 5430; loss reverses.
  private plGainLossLines(assetAccount: string, delta: number): any[] {
    const d = round2(delta);
    if (d === 0) return [];
    const pl = postingDefault('INVEST.MTM.PL', 'fv_gain_loss'); // 5430
    return d > 0
      ? [{ account_code: assetAccount, debit: d }, { account_code: pl, credit: d }]
      : [{ account_code: assetAccount, credit: -d }, { account_code: pl, debit: -d }];
  }

  // ── Purchase — maker-checker (TRE-03) ────────────────────────────────────────────────────────────────────
  async createInvestment(dto: InvestmentDto, user: JwtUser) {
    const db = this.db;
    const cost = round2(dto.cost);
    if (!(cost > 0)) throw new BadRequestException({ code: 'BAD_COST', message: 'cost must be > 0', messageTh: 'ต้นทุนต้องมากกว่าศูนย์' });
    const cls = (CLASSES as readonly string[]).includes(dto.classification ?? '') ? (dto.classification as Classification) : 'AMORTIZED_COST';
    const qty = round6(dto.quantity ?? 1);
    if (!(qty > 0)) throw new BadRequestException({ code: 'BAD_QUANTITY', message: 'quantity must be > 0', messageTh: 'จำนวนหน่วยต้องมากกว่าศูนย์' });
    const eir = round6(dto.eirPct ?? 0);
    if (eir < 0) throw new BadRequestException({ code: 'BAD_RATE', message: 'eir_pct must be >= 0', messageTh: 'อัตราดอกเบี้ยต้องไม่ติดลบ' });
    const tenantId = this.tenant(dto.tenantId, user);
    const investmentNo = await this.docNo.nextDaily('INVS');
    const [row] = await db.insert(investments).values({
      investmentNo, tenantId, instrument: dto.instrument, instrumentType: dto.instrumentType ?? 'bond',
      symbol: dto.symbol ?? null, classification: cls, currency: dto.currency ?? 'THB', quantity: String(qty),
      cost: String(cost), eirPct: String(eir), tradeDate: dto.tradeDate ?? ymd(), maturityDate: dto.maturityDate ?? null,
      carryingValue: '0', allowance: '0', fvociReserve: '0', accruedIncome: '0', periodsPosted: 0, nextRunDate: null,
      status: 'PendingApproval', requestedBy: user.username, createdBy: user.username,
    }).returning({ id: investments.id });
    return this.getInvestment(Number(row!.id));
  }

  // Checker: approve a PendingApproval investment (approver ≠ requester ⇒ SOD_SELF_APPROVAL) → posts the buy JE.
  async approveInvestment(id: number, user: JwtUser) {
    const db = this.db;
    const inv = await this.loadInvestment(id);
    if (inv.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Investment is ${inv.status}, not pending approval`, messageTh: 'เงินลงทุนไม่ได้อยู่ในสถานะรออนุมัติ' });
    if (inv.requestedBy && inv.requestedBy === user.username) {
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot approve an investment you created', messageTh: 'ผู้สร้างอนุมัติเงินลงทุนของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    const cls = inv.classification as Classification;
    const cost = n(inv.cost);
    const asset = this.classAsset(cls);
    const tradeDate = String(inv.tradeDate ?? ymd());
    let entryNo: string | null = null;
    if (this.ledger && cost > 0) {
      const je: any = await this.ledger.postEntry({
        date: tradeDate, source: 'INVEST-BUY', sourceRef: inv.investmentNo, tenantId: inv.tenantId ?? null, currency: inv.currency ?? 'THB',
        memo: `Purchase ${inv.investmentNo} — ${inv.instrument} (${cls}) ${cost}`, createdBy: user.username,
        lines: [{ account_code: asset, debit: cost }, { account_code: postingDefault('INVEST.BUY', 'bank'), credit: cost }],
      });
      entryNo = je?.entry_no ?? null;
    }
    await db.update(investments).set({
      status: 'Approved', approvedBy: user.username, approvedAt: new Date(), carryingValue: String(cost),
      nextRunDate: cls === 'AMORTIZED_COST' ? addMonth(tradeDate) : null, entryNo,
    }).where(eq(investments.id, id));
    return this.getInvestment(id);
  }

  async rejectInvestment(id: number, user: JwtUser) {
    const db = this.db;
    const inv = await this.loadInvestment(id);
    if (inv.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Investment is ${inv.status}, not pending approval`, messageTh: 'เงินลงทุนไม่ได้อยู่ในสถานะรออนุมัติ' });
    await db.update(investments).set({ status: 'Rejected', approvedBy: user.username, approvedAt: new Date() }).where(eq(investments.id, id));
    return this.getInvestment(id);
  }

  // ── Maker-checker market-price register (mirrors FX-04) ──────────────────────────────────────────────────
  // A MANUAL price lands PendingApproval and cannot drive MTM until a DIFFERENT user approves it; an explicit
  // non-manual source (a feed) is auto-approved. Re-setting a (tenant, symbol, price_date) replaces it.
  async postPrice(dto: PriceDto, user: JwtUser) {
    const db = this.db;
    const price = round6(dto.price);
    if (!(price > 0)) throw new BadRequestException({ code: 'BAD_PRICE', message: 'price must be > 0', messageTh: 'ราคาต้องมากกว่าศูนย์' });
    const tenantId = this.tenant(dto.tenantId, user);
    const tCond = tenantId != null ? eq(investmentPrices.tenantId, tenantId) : isNull(investmentPrices.tenantId);
    await db.delete(investmentPrices).where(and(tCond, eq(investmentPrices.symbol, dto.symbol), eq(investmentPrices.priceDate, dto.priceDate)));
    const source = dto.source ?? 'manual';
    const pending = source === 'manual';
    await db.insert(investmentPrices).values({
      tenantId, symbol: dto.symbol, priceDate: dto.priceDate, price: String(price), source,
      status: pending ? 'PendingApproval' : 'Approved', requestedBy: pending ? user.username : null,
      approvedBy: pending ? null : user.username, approvedAt: pending ? null : new Date(), createdBy: user.username,
    });
    return { symbol: dto.symbol, price_date: dto.priceDate, price, tenant_id: tenantId, status: pending ? 'PendingApproval' : 'Approved' };
  }

  async approvePrice(symbol: string, priceDate: string, tenantId: number | null, user: JwtUser) {
    const db = this.db;
    const tid = this.tenant(tenantId, user);
    const tCond = tid != null ? eq(investmentPrices.tenantId, tid) : isNull(investmentPrices.tenantId);
    const [p] = await db.select().from(investmentPrices).where(and(tCond, eq(investmentPrices.symbol, symbol), eq(investmentPrices.priceDate, priceDate), eq(investmentPrices.status, 'PendingApproval'))).limit(1);
    if (!p) throw new BadRequestException({ code: 'NO_PENDING_PRICE', message: `No price pending approval for ${symbol} ${priceDate}`, messageTh: 'ไม่พบราคาที่รออนุมัติ' });
    if (p.requestedBy && p.requestedBy === user.username) throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot approve a price you entered', messageTh: 'ผู้บันทึกอนุมัติราคาของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    await db.update(investmentPrices).set({ status: 'Approved', approvedBy: user.username, approvedAt: new Date() }).where(eq(investmentPrices.id, p.id));
    return { symbol, price_date: priceDate, price: n(p.price), tenant_id: tid ?? null, status: 'Approved', approved_by: user.username, requested_by: p.requestedBy };
  }

  async rejectPrice(symbol: string, priceDate: string, tenantId: number | null, user: JwtUser) {
    const db = this.db;
    const tid = this.tenant(tenantId, user);
    const tCond = tid != null ? eq(investmentPrices.tenantId, tid) : isNull(investmentPrices.tenantId);
    const [p] = await db.select().from(investmentPrices).where(and(tCond, eq(investmentPrices.symbol, symbol), eq(investmentPrices.priceDate, priceDate), eq(investmentPrices.status, 'PendingApproval'))).limit(1);
    if (!p) throw new BadRequestException({ code: 'NO_PENDING_PRICE', message: `No price pending approval for ${symbol} ${priceDate}`, messageTh: 'ไม่พบราคาที่รออนุมัติ' });
    await db.update(investmentPrices).set({ status: 'Rejected', approvedBy: user.username, approvedAt: new Date() }).where(eq(investmentPrices.id, p.id));
    return { symbol, price_date: priceDate, tenant_id: tid ?? null, status: 'Rejected', rejected_by: user.username };
  }

  async listPrices(q: { symbol?: string; status?: string }, user?: JwtUser) {
    const db = this.db;
    const conds: any[] = [];
    // Scope explicitly to the caller's tenant — an Admin bypasses RLS in single-company mode (AC-18), so like
    // the debt register the read must add its own tenant filter to stay isolated.
    const tid = this.tenant(undefined, user);
    if (tid != null) conds.push(eq(investmentPrices.tenantId, tid));
    if (q.symbol) conds.push(eq(investmentPrices.symbol, q.symbol));
    if (q.status) conds.push(eq(investmentPrices.status, q.status));
    const rows = await db.select().from(investmentPrices).where(conds.length ? and(...conds) : undefined).orderBy(desc(investmentPrices.priceDate), desc(investmentPrices.id));
    return { prices: rows.map((r: any) => ({ symbol: r.symbol, price_date: r.priceDate, price: n(r.price), source: r.source, status: r.status, requested_by: r.requestedBy, approved_by: r.approvedBy })), count: rows.length };
  }

  // Latest APPROVED price for the symbol with price_date <= as_of. Pending/rejected prices are excluded — an
  // unapproved price must never drive MTM (TRE-03, mirrors FX-04's rateAsOf).
  private async approvedPriceAsOf(symbol: string, asOf: string): Promise<number | null> {
    const db = this.db;
    const [p] = await db.select().from(investmentPrices).where(and(eq(investmentPrices.symbol, symbol), eq(investmentPrices.status, 'Approved'), sql`${investmentPrices.priceDate} <= ${asOf}`)).orderBy(desc(investmentPrices.priceDate), desc(investmentPrices.id)).limit(1);
    return p ? n(p.price) : null;
  }

  // ── Mark-to-market (TRE-03) — FVOCI → OCI reserve 3500; FVTPL → P&L 5430; amortized cost is NOT marked ────
  async revalue(id: number, dto: RevalueDto, user: JwtUser) {
    const db = this.db;
    const inv = await this.loadInvestment(id);
    if (inv.status !== 'Approved') throw new BadRequestException({ code: 'INVESTMENT_NOT_APPROVED', message: 'Investment must be approved before revaluation', messageTh: 'ต้องอนุมัติเงินลงทุนก่อนวัดมูลค่า' });
    const cls = inv.classification as Classification;
    if (cls === 'AMORTIZED_COST') throw new BadRequestException({ code: 'MTM_NOT_APPLICABLE', message: 'Amortized-cost investments are measured at amortized cost, not marked to market', messageTh: 'เงินลงทุนราคาทุนตัดจำหน่ายไม่วัดมูลค่ายุติธรรม' });
    if (!inv.symbol) throw new BadRequestException({ code: 'NO_SYMBOL', message: 'Investment has no price symbol to revalue', messageTh: 'เงินลงทุนไม่มีสัญลักษณ์ราคา' });
    const asOf = dto.asOf ?? ymd();
    const price = await this.approvedPriceAsOf(inv.symbol, asOf);
    if (price == null) throw new BadRequestException({ code: 'NO_APPROVED_PRICE', message: `No APPROVED price for ${inv.symbol} as of ${asOf} — MTM requires an approved price`, messageTh: 'ไม่พบราคาที่อนุมัติแล้ว จึงวัดมูลค่ายุติธรรมไม่ได้' });
    const priorCarrying = n(inv.carryingValue);
    const fairValue = round2(price * n(inv.quantity));
    const delta = round2(fairValue - priorCarrying);
    const sourceRef = `${inv.investmentNo}-MTM-${asOf}`;
    if (this.ledger && await this.ledger.alreadyPosted('INVEST-MTM', sourceRef, inv.tenantId ?? null)) {
      return { investment_no: inv.investmentNo, as_of: asOf, price, classification: cls, prior_carrying: priorCarrying, fair_value: fairValue, delta: 0, entry_no: null, already: true };
    }
    const asset = this.classAsset(cls);
    const lines = cls === 'FVTPL' ? this.plGainLossLines(asset, delta) : this.ociReserveLines(asset, delta);
    let entryNo: string | null = null;
    if (this.ledger && lines.length) {
      const je: any = await this.ledger.postEntry({
        date: asOf, source: 'INVEST-MTM', sourceRef, tenantId: inv.tenantId ?? null, currency: inv.currency ?? 'THB',
        memo: `MTM ${inv.investmentNo} (${cls}) @ ${price} as of ${asOf} — delta ${delta}`, createdBy: user.username, lines,
      });
      entryNo = je?.entry_no ?? null;
    }
    const ociDelta = cls === 'FVOCI' ? delta : 0;
    const plDelta = cls === 'FVTPL' ? delta : 0;
    await db.update(investments).set({
      carryingValue: String(fairValue),
      fvociReserve: String(round2(n(inv.fvociReserve) + ociDelta)),
    }).where(eq(investments.id, id));
    await db.insert(investmentValuations).values({
      tenantId: inv.tenantId ?? null, investmentId: id, asOf, valType: 'MTM', price: String(round6(price)),
      priorCarrying: String(priorCarrying), newCarrying: String(fairValue), delta: String(delta),
      ociDelta: String(ociDelta), plDelta: String(plDelta), allowanceDelta: '0', entryNo, createdBy: user.username,
    });
    return { investment_no: inv.investmentNo, as_of: asOf, price, classification: cls, prior_carrying: priorCarrying, fair_value: fairValue, delta, oci_delta: ociDelta, pl_delta: plDelta, entry_no: entryNo };
  }

  // ── ECL impairment (TRE-03) — Dr 5440 Investment Impairment / Cr 1355 Allowance (contra-asset) ────────────
  async impair(id: number, dto: ImpairDto, user: JwtUser) {
    const db = this.db;
    const inv = await this.loadInvestment(id);
    if (inv.status !== 'Approved') throw new BadRequestException({ code: 'INVESTMENT_NOT_APPROVED', message: 'Investment must be approved before impairment', messageTh: 'ต้องอนุมัติเงินลงทุนก่อนบันทึกด้อยค่า' });
    const ecl = round2(dto.ecl);
    if (!(ecl > 0)) throw new BadRequestException({ code: 'BAD_ECL', message: 'ecl must be > 0', messageTh: 'ค่าเผื่อการด้อยค่าต้องมากกว่าศูนย์' });
    const asOf = dto.asOf ?? ymd();
    const sourceRef = `${inv.investmentNo}-ECL-${asOf}`;
    if (this.ledger && await this.ledger.alreadyPosted('INVEST-ECL', sourceRef, inv.tenantId ?? null)) {
      return { investment_no: inv.investmentNo, as_of: asOf, ecl: 0, allowance: n(inv.allowance), entry_no: null, already: true };
    }
    let entryNo: string | null = null;
    if (this.ledger) {
      const je: any = await this.ledger.postEntry({
        date: asOf, source: 'INVEST-ECL', sourceRef, tenantId: inv.tenantId ?? null, currency: inv.currency ?? 'THB',
        memo: `ECL impairment ${inv.investmentNo} ${asOf} — ${ecl}`, createdBy: user.username,
        lines: [{ account_code: postingDefault('INVEST.IMPAIR', 'impairment_loss'), debit: ecl }, { account_code: postingDefault('INVEST.IMPAIR', 'allowance'), credit: ecl }],
      });
      entryNo = je?.entry_no ?? null;
    }
    const newAllowance = round2(n(inv.allowance) + ecl);
    const newCarrying = round2(n(inv.carryingValue) - ecl);
    await db.update(investments).set({ allowance: String(newAllowance), carryingValue: String(newCarrying) }).where(eq(investments.id, id));
    await db.insert(investmentValuations).values({
      tenantId: inv.tenantId ?? null, investmentId: id, asOf, valType: 'ECL', price: null,
      priorCarrying: String(n(inv.carryingValue)), newCarrying: String(newCarrying), delta: String(round2(-ecl)),
      ociDelta: '0', plDelta: '0', allowanceDelta: String(ecl), entryNo, createdBy: user.username,
    });
    return { investment_no: inv.investmentNo, as_of: asOf, ecl, allowance: newAllowance, carrying_value: newCarrying, entry_no: entryNo };
  }

  // ── Interest / dividend income (TRE-03) ──────────────────────────────────────────────────────────────────
  // AMORTIZED_COST: idempotent EIR accretion on the carrying (Dr 1350 / Cr 4700), reusing the Wave-1 cursor +
  // alreadyPosted guard — one month posts per due call. FVOCI/FVTPL: a cash dividend/coupon (Dr 1010 / Cr 4700)
  // for the supplied `amount`.
  async accrue(id: number, dto: AccrueDto, user: JwtUser) {
    const db = this.db;
    const inv = await this.loadInvestment(id);
    if (inv.status !== 'Approved') throw new BadRequestException({ code: 'INVESTMENT_NOT_APPROVED', message: 'Investment must be approved before accrual', messageTh: 'ต้องอนุมัติเงินลงทุนก่อนบันทึกดอกเบี้ย/เงินปันผล' });
    const asOf = dto.asOf ?? ymd();
    const cls = inv.classification as Classification;

    if (cls === 'AMORTIZED_COST') {
      if (!inv.nextRunDate || String(inv.nextRunDate) > asOf) {
        return { investment_no: inv.investmentNo, as_of: asOf, type: 'interest', posted: 0, interest: 0, entry_no: null };
      }
      const carrying = n(inv.carryingValue);
      const interest = round2(carrying * (n(inv.eirPct) / 100 / 12));
      const period = String(inv.nextRunDate).slice(0, 7);
      const sourceRef = `${inv.investmentNo}-${period}`;
      if (this.ledger && await this.ledger.alreadyPosted('INVEST-ACCR', sourceRef, inv.tenantId ?? null)) {
        await db.update(investments).set({ nextRunDate: addMonth(String(inv.nextRunDate)) }).where(eq(investments.id, id));
        return { investment_no: inv.investmentNo, as_of: asOf, type: 'interest', posted: 0, interest: 0, entry_no: null };
      }
      let entryNo: string | null = null;
      if (this.ledger && interest > 0) {
        const je: any = await this.ledger.postEntry({
          date: String(inv.nextRunDate), source: 'INVEST-ACCR', sourceRef, tenantId: inv.tenantId ?? null, currency: inv.currency ?? 'THB',
          memo: `Investment interest (EIR) ${inv.investmentNo} ${period}`, createdBy: `${user?.username ?? 'system'} (invest)`,
          lines: [{ account_code: this.classAsset(cls), debit: interest }, { account_code: postingDefault('INVEST.INCOME', 'income'), credit: interest }],
        });
        entryNo = je?.entry_no ?? null;
      }
      await db.update(investments).set({
        carryingValue: String(round2(carrying + interest)),
        accruedIncome: String(round2(n(inv.accruedIncome) + interest)),
        periodsPosted: Number(inv.periodsPosted) + 1,
        nextRunDate: addMonth(String(inv.nextRunDate)),
      }).where(eq(investments.id, id));
      return { investment_no: inv.investmentNo, as_of: asOf, type: 'interest', posted: interest > 0 ? 1 : 0, period, interest, entry_no: entryNo };
    }

    // FVOCI / FVTPL — cash dividend/coupon received.
    const amount = round2(dto.amount ?? 0);
    if (!(amount > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'amount must be > 0 for a dividend/coupon', messageTh: 'จำนวนเงินปันผล/ดอกเบี้ยต้องมากกว่าศูนย์' });
    const sourceRef = `${inv.investmentNo}-DIV-${asOf}-${amount}`;
    let entryNo: string | null = null;
    if (this.ledger) {
      const je: any = await this.ledger.postEntry({
        date: asOf, source: 'INVEST-DIV', sourceRef, tenantId: inv.tenantId ?? null, currency: inv.currency ?? 'THB',
        memo: `Investment income (dividend/coupon) ${inv.investmentNo} ${asOf} — ${amount}`, createdBy: user.username,
        lines: [{ account_code: postingDefault('INVEST.INCOME', 'bank'), debit: amount }, { account_code: postingDefault('INVEST.INCOME', 'income'), credit: amount }],
      });
      entryNo = je?.entry_no ?? null;
    }
    await db.update(investments).set({ accruedIncome: String(round2(n(inv.accruedIncome) + amount)) }).where(eq(investments.id, id));
    return { investment_no: inv.investmentNo, as_of: asOf, type: 'dividend', posted: 1, amount, entry_no: entryNo };
  }

  // ── Reads ────────────────────────────────────────────────────────────────────────────────────────────────
  async listInvestments(tenantId?: number | null) {
    const db = this.db;
    const tid = this.tenant(tenantId);
    const rows = await db.select().from(investments).where(tid != null ? eq(investments.tenantId, tid) : undefined).orderBy(desc(investments.id));
    return { investments: rows.map(shapeInvestment), count: rows.length };
  }

  async getInvestment(id: number) {
    const inv = await this.loadInvestment(id);
    const db = this.db;
    const vals = await db.select().from(investmentValuations).where(eq(investmentValuations.investmentId, id)).orderBy(investmentValuations.id);
    return { ...shapeInvestment(inv), valuations: vals.map(shapeValuation) };
  }

  // Portfolio roll-up by classification (cost, carrying, allowance, OCI reserve).
  async portfolio(tenantId?: number | null) {
    const db = this.db;
    const tid = this.tenant(tenantId);
    const rows = await db.select().from(investments).where(and(
      ...(tid != null ? [eq(investments.tenantId, tid)] : []), eq(investments.status, 'Approved'),
    ));
    const byClass: Record<string, { classification: string; count: number; cost: number; carrying_value: number; allowance: number; fvoci_reserve: number }> = {};
    for (const c of CLASSES) byClass[c] = { classification: c, count: 0, cost: 0, carrying_value: 0, allowance: 0, fvoci_reserve: 0 };
    let totalCost = 0, totalCarrying = 0, totalAllowance = 0, totalReserve = 0;
    for (const r of rows) {
      const b = byClass[r.classification] ?? (byClass[r.classification] = { classification: r.classification, count: 0, cost: 0, carrying_value: 0, allowance: 0, fvoci_reserve: 0 });
      b.count += 1;
      b.cost = round2(b.cost + n(r.cost));
      b.carrying_value = round2(b.carrying_value + n(r.carryingValue));
      b.allowance = round2(b.allowance + n(r.allowance));
      b.fvoci_reserve = round2(b.fvoci_reserve + n(r.fvociReserve));
      totalCost = round2(totalCost + n(r.cost));
      totalCarrying = round2(totalCarrying + n(r.carryingValue));
      totalAllowance = round2(totalAllowance + n(r.allowance));
      totalReserve = round2(totalReserve + n(r.fvociReserve));
    }
    return {
      by_class: CLASSES.map((c) => byClass[c]!),
      totals: { count: rows.length, cost: totalCost, carrying_value: totalCarrying, allowance: totalAllowance, fvoci_reserve: totalReserve },
    };
  }

  private async loadInvestment(id: number) {
    const db = this.db;
    const [inv] = await db.select().from(investments).where(eq(investments.id, id)).limit(1);
    if (!inv) throw new NotFoundException({ code: 'INVESTMENT_NOT_FOUND', message: `Investment ${id} not found`, messageTh: `ไม่พบเงินลงทุน ${id}` });
    return inv;
  }
}

function shapeInvestment(i: any) {
  return {
    id: Number(i.id), investment_no: i.investmentNo, instrument: i.instrument, instrument_type: i.instrumentType,
    symbol: i.symbol, classification: i.classification, currency: i.currency, quantity: n(i.quantity), cost: n(i.cost),
    eir_pct: n(i.eirPct), trade_date: i.tradeDate, maturity_date: i.maturityDate, carrying_value: n(i.carryingValue),
    allowance: n(i.allowance), fvoci_reserve: n(i.fvociReserve), accrued_income: n(i.accruedIncome),
    periods_posted: Number(i.periodsPosted), next_run_date: i.nextRunDate, status: i.status, entry_no: i.entryNo,
    requested_by: i.requestedBy, approved_by: i.approvedBy, created_by: i.createdBy,
  };
}
function shapeValuation(v: any) {
  return {
    id: Number(v.id), as_of: v.asOf, val_type: v.valType, price: v.price != null ? n(v.price) : null,
    prior_carrying: n(v.priorCarrying), new_carrying: n(v.newCarrying), delta: n(v.delta), oci_delta: n(v.ociDelta),
    pl_delta: n(v.plDelta), allowance_delta: n(v.allowanceDelta), entry_no: v.entryNo,
  };
}
