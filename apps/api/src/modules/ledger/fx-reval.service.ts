import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, sql, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { fxRevalRuns, fxRates, arInvoices, apTransactions } from '../../database/schema';
import { LedgerService } from './ledger.service';
import { currentTenantStore } from '../../common/tenant-context';
import { n } from '../../database/queries';
import { assertMakerChecker } from '../../common/control-profile';
import type { JwtUser } from '../../common/decorators';

// WS3.2 — Period-end FX revaluation governance (GL-18). A maker-checker, idempotent-per-(tenant,period)
// wrapper around the unrealized-FX computation: runReval computes the gain/loss on every open foreign-
// currency monetary balance (AR/AP) at the closing rate and stages an 'Open' run; postReval (by a DIFFERENT
// user) posts the net to the GL. This is the governed, period-close counterpart to the ad-hoc FxService.revalue.
//
// FX SIGN CONVENTION (P&L sign on `net`/`total_gain`/`total_loss`, and the 5400 posting):
//   For each open foreign monetary item, delta_thb = open_foreign × (closing_rate − booked_rate).
//   * AR (an asset): a delta_thb > 0 is a GAIN (the receivable is worth more in THB) → Dr 1100 / Cr 5400.
//   * AP (a liability): a delta_thb > 0 is a LOSS (the payable costs more in THB) → Dr 5400 / Cr 2000.
//   So the P&L effect (net) = Σ(AR delta) − Σ(AP delta). net > 0 ⇒ net GAIN ⇒ Cr 5400 (credit = income);
//   net < 0 ⇒ net LOSS ⇒ Dr 5400. The monetary-control legs (1100/2000) restate the carrying balances.
// The control-account legs post with viaSubledger:true (the reval legitimately restates the AR/AP control
// accounts). Posting flows through LedgerService.postEntry so PERIOD_LOCKED (WS2.1) + the GL audit trail apply.

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;
const AR_CONTROL = '1100';
const AP_CONTROL = '2000';
const FX_UNREALIZED = '5400';

export interface RunRevalDto { period: string; asOfDate?: string; rates?: Record<string, number>; runBy: string; tenantId?: number | null }
export interface PostRevalDto { id: number; postedBy: string }

@Injectable()
export class FxRevalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
  ) {}

  private tenant(explicit?: number | null): number | null {
    if (explicit !== undefined && explicit !== null) return explicit;
    return currentTenantStore()?.tenantId ?? null;
  }
  private periodEndDate(period: string): string {
    const [y, m] = period.split('-').map(Number) as [number, number];
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${period}-${String(last).padStart(2, '0')}`;
  }

  // Latest APPROVED fx_rates row with rate_date <= asOf (THB = 1). Mirrors FxService.rateAsOf — an
  // unapproved manual rate (FX-04 maker-checker) must never drive a revaluation.
  private async rateAsOf(currency: string, asOf: string): Promise<number | null> {
    if (currency === 'THB') return 1;
    const db = this.db;
    const [r] = await db.select().from(fxRates)
      .where(and(eq(fxRates.currency, currency), eq(fxRates.status, 'Approved'), sql`${fxRates.rateDate} <= ${asOf}`))
      .orderBy(desc(fxRates.rateDate), desc(fxRates.id)).limit(1);
    return r ? n(r.rate) : null;
  }

  // runReval — compute the unrealized FX on open foreign-currency AR/AP as of the period end and stage an
  // 'Open' run. Closing rates come from the request `rates` map first (explicit closing rates), else the
  // latest APPROVED fx_rates row (the existing rate source). A currency with no rate from either source
  // throws MISSING_RATE. Idempotent: re-running an Open period updates it; a Posted period throws ALREADY_POSTED.
  async runReval(dto: RunRevalDto) {
    const db = this.db;
    const tenantId = this.tenant(dto.tenantId);
    const asOf = dto.asOfDate ?? this.periodEndDate(dto.period);
    const explicit = dto.rates ?? {};

    const [existing] = await db.select().from(fxRevalRuns)
      .where(and(tenantId != null ? eq(fxRevalRuns.tenantId, tenantId) : isNull(fxRevalRuns.tenantId), eq(fxRevalRuns.period, dto.period))).limit(1);
    if (existing?.status === 'Posted') {
      throw new BadRequestException({ code: 'ALREADY_POSTED', message: `FX revaluation for ${dto.period} is already posted`, messageTh: `การปรับปรุงอัตราแลกเปลี่ยนงวด ${dto.period} โพสต์แล้ว` });
    }

    // Open foreign-currency AR/AP (status ≠ Paid, currency ≠ THB, dated on/before as-of).
    const arWhere = [sql`${arInvoices.status}::text <> 'Paid'`, sql`${arInvoices.currency} <> 'THB'`, sql`(${arInvoices.invoiceDate} IS NULL OR ${arInvoices.invoiceDate} <= ${asOf})`];
    if (tenantId != null) arWhere.push(eq(arInvoices.tenantId, tenantId));
    const ar = await db.select().from(arInvoices).where(and(...arWhere));
    const apWhere = [sql`${apTransactions.status}::text <> 'Paid'`, sql`${apTransactions.currency} <> 'THB'`, sql`(${apTransactions.invoiceDate} IS NULL OR ${apTransactions.invoiceDate} <= ${asOf})`];
    if (tenantId != null) apWhere.push(eq(apTransactions.tenantId, tenantId));
    const ap = await db.select().from(apTransactions).where(and(...apWhere));

    // Resolve the closing rate per currency (explicit map wins; cache + collect what we used).
    const usedRates: Record<string, number> = {};
    const rateFor = async (ccy: string): Promise<number> => {
      if (usedRates[ccy] !== undefined) return usedRates[ccy];
      let r: number | null = explicit[ccy] != null ? Number(explicit[ccy]) : null;
      if (r == null) r = await this.rateAsOf(ccy, asOf);
      if (r == null || !(r > 0)) throw new BadRequestException({ code: 'MISSING_RATE', message: `No closing rate for ${ccy} as of ${asOf} (pass it in rates or set an approved fx_rate)`, messageTh: `ไม่พบอัตราปิดงวดสำหรับ ${ccy}` });
      return (usedRates[ccy] = round4(r));
    };

    const detail: any[] = [];
    let arDelta = 0, apDelta = 0;
    for (const i of ar) {
      const openF = round4(n(i.amount) - n(i.paidAmount));
      if (Math.abs(openF) < 1e-9) continue;
      const closing = await rateFor(i.currency!);
      const d = round4(openF * (closing - n(i.fxRate)));
      arDelta = round4(arDelta + d);
      detail.push({ scope: 'AR', doc_no: i.invoiceNo, currency: i.currency, open_foreign: openF, booked_rate: n(i.fxRate), closing_rate: closing, delta: d });
    }
    for (const t of ap) {
      const openF = round4(n(t.amount) - n(t.paidAmount));
      if (Math.abs(openF) < 1e-9) continue;
      const closing = await rateFor(t.currency!);
      const d = round4(openF * (closing - n(t.fxRate)));
      apDelta = round4(apDelta + d);
      detail.push({ scope: 'AP', doc_no: t.txnNo, currency: t.currency, open_foreign: openF, booked_rate: n(t.fxRate), closing_rate: closing, delta: d });
    }
    // P&L net = AR gain effect − AP gain effect (an AP increase is a loss). gain/loss split per the net sign.
    const net = round4(arDelta - apDelta);
    const totalGain = net > 0 ? net : 0;
    const totalLoss = net < 0 ? -net : 0;

    let id: number;
    if (existing) {
      await db.update(fxRevalRuns).set({
        asOfDate: asOf, rates: usedRates, totalGain: String(totalGain), totalLoss: String(totalLoss), net: String(net), detail, runBy: dto.runBy,
      }).where(eq(fxRevalRuns.id, existing.id));
      id = Number(existing.id);
    } else {
      const [ins] = await db.insert(fxRevalRuns).values({
        tenantId, period: dto.period, asOfDate: asOf, status: 'Open', rates: usedRates,
        totalGain: String(totalGain), totalLoss: String(totalLoss), net: String(net), detail, runBy: dto.runBy,
      }).returning({ id: fxRevalRuns.id });
      id = Number(ins!.id);
    }
    return { id, period: dto.period, as_of_date: asOf, status: 'Open', tenant_id: tenantId, rates: usedRates, ar_delta: arDelta, ap_delta: apDelta, total_gain: totalGain, total_loss: totalLoss, net, detail };
  }

  // postReval — maker-checker post of an Open run (poster ≠ runner ⇒ SELF_POST). Posts the AR/AP control
  // restatements and the net to 5400, then marks the run Posted. Idempotent: a Posted run throws ALREADY_POSTED.
  async postReval(dto: PostRevalDto, user: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const [run] = await db.select().from(fxRevalRuns).where(eq(fxRevalRuns.id, dto.id)).limit(1);
    if (!run) throw new NotFoundException({ code: 'FX_RUN_NOT_FOUND', message: `FX revaluation run ${dto.id} not found`, messageTh: `ไม่พบการปรับปรุงอัตราแลกเปลี่ยน ${dto.id}` });
    if (run.status === 'Posted') throw new BadRequestException({ code: 'ALREADY_POSTED', message: 'This FX revaluation is already posted', messageTh: 'การปรับปรุงนี้โพสต์แล้ว' });
    if (run.runBy && run.runBy === dto.postedBy) {
      await assertMakerChecker(db, { user, maker: user.username, event: 'gl.fxreval.post', ref: String(dto.id), reason: selfApprovalReason, code: 'SELF_POST', message: 'Maker-checker: you cannot post an FX revaluation you ran', messageTh: 'ผู้คำนวณโพสต์การปรับปรุงของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    const detail: any[] = (run.detail as any[]) ?? [];
    const arDelta = round4(detail.filter((d) => d.scope === 'AR').reduce((a, d) => a + n(d.delta), 0));
    const apDelta = round4(detail.filter((d) => d.scope === 'AP').reduce((a, d) => a + n(d.delta), 0));
    const net = round4(arDelta - apDelta);

    const lines: any[] = [];
    // AR control restatement: gain ⇒ Dr 1100 (receivable worth more), loss ⇒ Cr 1100.
    if (arDelta > 0) lines.push({ account_code: AR_CONTROL, debit: arDelta });
    else if (arDelta < 0) lines.push({ account_code: AR_CONTROL, credit: -arDelta });
    // AP control restatement: an increase (apDelta>0) is a loss ⇒ Cr 2000 (payable larger); decrease ⇒ Dr 2000.
    if (apDelta > 0) lines.push({ account_code: AP_CONTROL, credit: apDelta });
    else if (apDelta < 0) lines.push({ account_code: AP_CONTROL, debit: -apDelta });
    // 5400 takes the balancing P&L net: net gain ⇒ Cr 5400 (income), net loss ⇒ Dr 5400.
    if (net > 0) lines.push({ account_code: FX_UNREALIZED, credit: net });
    else if (net < 0) lines.push({ account_code: FX_UNREALIZED, debit: -net });

    let entryNo: string | null = null;
    if (lines.length) {
      const je: any = await this.ledger.postEntry({
        date: run.asOfDate, source: 'FXREVAL-RUN', sourceRef: `FXR-${Number(run.id)}`, tenantId: run.tenantId ?? null, currency: 'THB',
        memo: `FX revaluation ${run.period} (net ${net})`, createdBy: dto.postedBy, lines, viaSubledger: true,
      });
      entryNo = je.entry_no;
    }
    await db.update(fxRevalRuns).set({ status: 'Posted', postedBy: dto.postedBy, postedAt: new Date() }).where(eq(fxRevalRuns.id, run.id));
    return { id: Number(run.id), period: run.period, status: 'Posted', ar_delta: arDelta, ap_delta: apDelta, net, entry_no: entryNo, posted_by: dto.postedBy };
  }

  async list(tenantId?: number | null) {
    const db = this.db;
    const tid = this.tenant(tenantId);
    const rows = await db.select().from(fxRevalRuns)
      .where(tid != null ? eq(fxRevalRuns.tenantId, tid) : undefined)
      .orderBy(desc(fxRevalRuns.period), desc(fxRevalRuns.id)).limit(200);
    return { runs: rows.map(shape), count: rows.length };
  }
  async get(id: number) {
    const db = this.db;
    const [r] = await db.select().from(fxRevalRuns).where(eq(fxRevalRuns.id, id)).limit(1);
    if (!r) throw new NotFoundException({ code: 'FX_RUN_NOT_FOUND', message: `FX revaluation run ${id} not found`, messageTh: `ไม่พบการปรับปรุงอัตราแลกเปลี่ยน ${id}` });
    return shape(r);
  }
}

function shape(r: any) {
  return {
    id: Number(r.id), period: r.period, as_of_date: r.asOfDate, status: r.status, rates: r.rates,
    total_gain: n(r.totalGain), total_loss: n(r.totalLoss), net: n(r.net), detail: r.detail,
    run_by: r.runBy, posted_by: r.postedBy, posted_at: r.postedAt, created_at: r.createdAt,
  };
}
