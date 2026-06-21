import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq, and, desc, sql, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { fxRates, arInvoices, apTransactions } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { roundCurrency, isSupportedCurrency } from '../tax/money';
import { n, fx, ymd } from '../../database/queries';

const thb = (x: number) => roundCurrency(x, 'THB');

export interface SetRateDto { currency: string; rate_date: string; rate: number; tenantId?: number | null; source?: string; createdBy: string }
export interface RevalueDto { as_of: string; currency: string; auto_reverse?: boolean; tenantId?: number | null; createdBy: string }

@Injectable()
export class FxService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
  ) {}

  private assertCcy(ccy: string) {
    if (!isSupportedCurrency(ccy)) throw new BadRequestException({ code: 'UNSUPPORTED_CURRENCY', message: `Unsupported currency ${ccy}`, messageTh: 'ไม่รองรับสกุลเงินนี้' });
  }

  async setRate(dto: SetRateDto) {
    const db = this.db as any;
    this.assertCcy(dto.currency);
    // upsert by (tenant, currency, rate_date) — delete-then-insert to honor the partial unique indexes
    const tCond = dto.tenantId != null ? eq(fxRates.tenantId, dto.tenantId) : isNull(fxRates.tenantId);
    await db.delete(fxRates).where(and(tCond, eq(fxRates.currency, dto.currency), eq(fxRates.rateDate, dto.rate_date)));
    await db.insert(fxRates).values({ tenantId: dto.tenantId ?? null, currency: dto.currency, rateDate: dto.rate_date, rate: fx(dto.rate, 8), source: dto.source ?? 'manual', createdBy: dto.createdBy });
    return { currency: dto.currency, rate_date: dto.rate_date, rate: n(dto.rate), tenant_id: dto.tenantId ?? null };
  }

  async listRates(q: { currency?: string; as_of?: string }) {
    const db = this.db as any;
    const conds: any[] = [];
    if (q.currency) conds.push(eq(fxRates.currency, q.currency));
    if (q.as_of) conds.push(sql`${fxRates.rateDate} <= ${q.as_of}`);
    const rows = await db.select().from(fxRates).where(conds.length ? and(...conds) : undefined).orderBy(desc(fxRates.rateDate));
    return { rates: rows.map((r: any) => ({ currency: r.currency, rate_date: r.rateDate, rate: n(r.rate), tenant_id: r.tenantId })), count: rows.length };
  }

  // resolve the applicable rate: latest fx_rates row with rate_date <= as_of (THB = 1)
  private async rateAsOf(currency: string, asOf: string): Promise<number | null> {
    if (currency === 'THB') return 1;
    const db = this.db as any;
    const [r] = await db.select().from(fxRates).where(and(eq(fxRates.currency, currency), sql`${fxRates.rateDate} <= ${asOf}`)).orderBy(desc(fxRates.rateDate), desc(fxRates.id)).limit(1);
    return r ? n(r.rate) : null;
  }

  private async openBalances(currency: string | undefined, asOf: string) {
    const db = this.db as any;
    const arWhere = [sql`${arInvoices.status}::text <> 'Paid'`, sql`${arInvoices.currency} <> 'THB'`, sql`(${arInvoices.invoiceDate} IS NULL OR ${arInvoices.invoiceDate} <= ${asOf})`];
    if (currency) arWhere.push(eq(arInvoices.currency, currency));
    const ar = await db.select().from(arInvoices).where(and(...arWhere));
    const apWhere = [sql`${apTransactions.status}::text <> 'Paid'`, sql`${apTransactions.currency} <> 'THB'`, sql`(${apTransactions.invoiceDate} IS NULL OR ${apTransactions.invoiceDate} <= ${asOf})`];
    if (currency) apWhere.push(eq(apTransactions.currency, currency));
    const ap = await db.select().from(apTransactions).where(and(...apWhere));
    return { ar, ap };
  }

  async unrealizedFxReport(q: { as_of: string; currency?: string }) {
    const { ar, ap } = await this.openBalances(q.currency, q.as_of);
    const rateCache: Record<string, number> = {};
    const cur = async (ccy: string) => (rateCache[ccy] ??= (await this.rateAsOf(ccy, q.as_of)) ?? 0);
    const arRows: any[] = []; const apRows: any[] = [];
    for (const i of ar) {
      const openF = n(i.amount) - n(i.paidAmount); const bookedThb = thb(openF * n(i.fxRate)); const cr = await cur(i.currency); const currentThb = thb(openF * cr);
      arRows.push({ doc_no: i.invoiceNo, currency: i.currency, open_foreign: openF, booked_rate: n(i.fxRate), booked_thb: bookedThb, current_rate: cr, current_thb: currentThb, delta: thb(currentThb - bookedThb) });
    }
    for (const t of ap) {
      const openF = n(t.amount) - n(t.paidAmount); const bookedThb = thb(openF * n(t.fxRate)); const cr = await cur(t.currency); const currentThb = thb(openF * cr);
      apRows.push({ doc_no: t.txnNo, currency: t.currency, open_foreign: openF, booked_rate: n(t.fxRate), booked_thb: bookedThb, current_rate: cr, current_thb: currentThb, delta: thb(currentThb - bookedThb) });
    }
    const arDelta = thb(arRows.reduce((a, r) => a + r.delta, 0)); const apDelta = thb(apRows.reduce((a, r) => a + r.delta, 0));
    return { as_of: q.as_of, current_rate_by_ccy: rateCache, ar: arRows, ap: apRows, totals: { ar_delta: arDelta, ap_delta: apDelta, net_delta: thb(arDelta - apDelta) } };
  }

  // revalue one currency as-of a date → ONE balanced JE (source FXREVAL, idempotent per as_of:currency)
  async revalue(dto: RevalueDto) {
    this.assertCcy(dto.currency);
    if (dto.currency === 'THB') return { currency: 'THB', as_of: dto.as_of, current_rate: 1, ar_delta: 0, ap_delta: 0, bank_delta: 0, entry_no: null, note: 'base currency' };
    const sourceRef = `${dto.as_of}:${dto.currency}`;
    if (await this.ledger.alreadyPosted('FXREVAL', sourceRef)) return { currency: dto.currency, as_of: dto.as_of, current_rate: 0, ar_delta: 0, ap_delta: 0, bank_delta: 0, entry_no: null, already: true };
    const cur = await this.rateAsOf(dto.currency, dto.as_of);
    if (cur == null) throw new BadRequestException({ code: 'NO_RATE', message: `No FX rate for ${dto.currency} as of ${dto.as_of}`, messageTh: 'ไม่พบอัตราแลกเปลี่ยน' });
    const { ar, ap } = await this.openBalances(dto.currency, dto.as_of);
    const arDelta = thb(ar.reduce((a: number, i: any) => { const openF = n(i.amount) - n(i.paidAmount); return a + (openF * cur - openF * n(i.fxRate)); }, 0));
    const apDelta = thb(ap.reduce((a: number, t: any) => { const openF = n(t.amount) - n(t.paidAmount); return a + (openF * cur - openF * n(t.fxRate)); }, 0));
    const bankDelta = 0; // no foreign house-bank balances in scope (batch 2)

    const lines: any[] = []; let fx5400 = 0; // +ve = credit (gain), -ve = debit (loss)
    if (arDelta > 0) { lines.push({ account_code: '1100', debit: arDelta }); fx5400 += arDelta; }
    else if (arDelta < 0) { lines.push({ account_code: '1100', credit: -arDelta }); fx5400 += arDelta; }
    if (apDelta < 0) { lines.push({ account_code: '2000', debit: -apDelta }); fx5400 += -apDelta; }
    else if (apDelta > 0) { lines.push({ account_code: '2000', credit: apDelta }); fx5400 += -apDelta; }
    if (bankDelta > 0) { lines.push({ account_code: '1010', debit: bankDelta }); fx5400 += bankDelta; }
    else if (bankDelta < 0) { lines.push({ account_code: '1010', credit: -bankDelta }); fx5400 += bankDelta; }
    const fxNet = thb(fx5400);
    if (fxNet > 0) lines.push({ account_code: '5400', credit: fxNet });
    else if (fxNet < 0) lines.push({ account_code: '5400', debit: -fxNet });
    if (!lines.length) return { currency: dto.currency, as_of: dto.as_of, current_rate: cur, ar_delta: 0, ap_delta: 0, bank_delta: 0, entry_no: null, note: 'no open foreign balances' };

    const je: any = await this.ledger.postEntry({ date: dto.as_of, source: 'FXREVAL', sourceRef, tenantId: dto.tenantId ?? null, currency: 'THB', memo: `FX revaluation ${dto.currency} @ ${cur} as of ${dto.as_of}`, createdBy: dto.createdBy, lines });
    let reverseEntry: string | null = null;
    if (dto.auto_reverse) {
      const [y, m] = dto.as_of.slice(0, 7).split('-').map(Number);
      const nm = m < 12 ? `${y}-${String(m + 1).padStart(2, '0')}-01` : `${y + 1}-01-01`;
      const revRef = `${dto.as_of}:${dto.currency}:rev`;
      if (!(await this.ledger.alreadyPosted('FXREVAL-REV', revRef))) {
        const rev: any = await this.ledger.postEntry({ date: nm, source: 'FXREVAL-REV', sourceRef: revRef, tenantId: dto.tenantId ?? null, currency: 'THB', memo: `FX revaluation reversal ${dto.currency} ${dto.as_of}`, createdBy: dto.createdBy, lines: lines.map((l) => ({ account_code: l.account_code, debit: l.credit, credit: l.debit })) });
        reverseEntry = rev?.entry_no ?? null;
      }
    }
    return { currency: dto.currency, as_of: dto.as_of, current_rate: cur, ar_delta: arDelta, ap_delta: apDelta, bank_delta: bankDelta, entry_no: je?.entry_no ?? null, reverse_entry_no: reverseEntry };
  }
}
