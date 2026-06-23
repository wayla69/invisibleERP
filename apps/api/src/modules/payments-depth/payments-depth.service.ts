import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { customerDeposits, houseAccounts, houseAccountEntries, paymentSurcharges } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { TaxService } from '../tax/tax.service';
import { roundCurrency } from '../tax/money';

const n = (x: any) => Number(x) || 0;
const r2 = (x: number) => roundCurrency(x, 'THB');

// Phase 8 — payments depth. Customer deposits (prepaid liability 2210, recognised to revenue on apply),
// house/charge accounts (AR 1100 with a credit limit + FX settlement → 5410) and card surcharge (4500).
// Every movement posts its own balanced JE; the sale builders are untouched.
@Injectable()
export class PaymentsDepthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly ledger: LedgerService,
    private readonly tax: TaxService,
  ) {}

  // ── customer deposits ──
  // Take a deposit (cash in advance): Dr 1000 Cash / Cr 2210 Customer Deposits.
  async takeDeposit(dto: { amount: number; member_id?: number; customer_name?: string; purpose?: string }, user: JwtUser) {
    const db = this.db as any;
    const amount = r2(n(dto.amount));
    if (amount <= 0) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'Amount must be positive', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
    const depositNo = await this.docNo.nextDaily('DEP');
    const je: any = await this.ledger.postEntry({ source: 'DEPOSIT', sourceRef: depositNo, tenantId: user.tenantId, memo: `Deposit ${depositNo}`, createdBy: user.username, lines: [{ account_code: '1000', debit: amount }, { account_code: '2210', credit: amount }] });
    const [d] = await db.insert(customerDeposits).values({ tenantId: user.tenantId ?? null, depositNo, memberId: dto.member_id ?? null, customerName: dto.customer_name ?? null, purpose: dto.purpose ?? 'booking', amount: String(amount), status: 'open', journalNo: je?.entry_no ?? null, createdBy: user.username }).returning({ id: customerDeposits.id });
    return { id: Number(d.id), deposit_no: depositNo, amount, status: 'open', journal_no: je?.entry_no ?? null };
  }

  // Apply a deposit to a sale (revenue recognised, VAT-inclusive): Dr 2210 Deposit / Cr 4000 net / Cr 2100 VAT.
  async applyDeposit(depositNo: string, dto: { amount?: number; sale_no?: string }, user: JwtUser) {
    const db = this.db as any;
    const dep = await this.loadDeposit(depositNo, user);
    const remaining = r2(n(dep.amount) - n(dep.appliedAmount) - n(dep.refundedAmount));
    const amount = dto.amount != null ? r2(n(dto.amount)) : remaining;
    if (amount <= 0) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'Amount must be positive', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
    if (amount > remaining + 0.001) throw new BadRequestException({ code: 'OVER_APPLY', message: `Cannot apply ${amount} — only ${remaining} remains`, messageTh: `ใช้มัดจำเกินคงเหลือ (${remaining})` });
    const inc = this.tax.calcInclusive({ gross: amount, country: 'TH' });
    const je: any = await this.ledger.postEntry({ source: 'DEPOSIT-APPLY', sourceRef: dto.sale_no ?? depositNo, tenantId: user.tenantId, memo: `Apply deposit ${depositNo}`, createdBy: user.username, lines: [{ account_code: '2210', debit: amount }, { account_code: '4000', credit: r2(inc.net) }, ...(inc.tax > 0 ? [{ account_code: '2100', credit: r2(inc.tax) }] : [])] });
    const applied = r2(n(dep.appliedAmount) + amount);
    const status = applied + n(dep.refundedAmount) >= n(dep.amount) - 0.001 ? 'applied' : 'open';
    await db.update(customerDeposits).set({ appliedAmount: String(applied), status, saleNo: dto.sale_no ?? dep.saleNo }).where(eq(customerDeposits.id, dep.id));
    return { deposit_no: depositNo, applied: amount, total_applied: applied, remaining: r2(n(dep.amount) - applied - n(dep.refundedAmount)), status, journal_no: je?.entry_no ?? null };
  }

  // Refund the unused deposit: Dr 2210 Deposit / Cr 1000 Cash.
  async refundDeposit(depositNo: string, dto: { amount?: number; reason?: string }, user: JwtUser) {
    const db = this.db as any;
    const dep = await this.loadDeposit(depositNo, user);
    const remaining = r2(n(dep.amount) - n(dep.appliedAmount) - n(dep.refundedAmount));
    const amount = dto.amount != null ? r2(n(dto.amount)) : remaining;
    if (amount <= 0 || amount > remaining + 0.001) throw new BadRequestException({ code: 'OVER_REFUND', message: `Cannot refund ${amount} — only ${remaining} remains`, messageTh: `คืนมัดจำเกินคงเหลือ (${remaining})` });
    const je: any = await this.ledger.postEntry({ source: 'DEPOSIT-REFUND', sourceRef: depositNo, tenantId: user.tenantId, memo: `Refund deposit ${depositNo}${dto.reason ? ` — ${dto.reason}` : ''}`, createdBy: user.username, lines: [{ account_code: '2210', debit: amount }, { account_code: '1000', credit: amount }] });
    const refunded = r2(n(dep.refundedAmount) + amount);
    const status = refunded + n(dep.appliedAmount) >= n(dep.amount) - 0.001 ? (n(dep.appliedAmount) > 0 ? 'closed' : 'refunded') : 'open';
    await db.update(customerDeposits).set({ refundedAmount: String(refunded), status }).where(eq(customerDeposits.id, dep.id));
    return { deposit_no: depositNo, refunded: amount, status, journal_no: je?.entry_no ?? null };
  }

  async listDeposits(_user: JwtUser, status?: string) {
    const db = this.db as any;
    const where = status ? eq(customerDeposits.status, status) : undefined;
    const rows = await (where ? db.select().from(customerDeposits).where(where) : db.select().from(customerDeposits)).orderBy(desc(customerDeposits.id)).limit(200);
    return { deposits: rows.map((d: any) => ({ deposit_no: d.depositNo, member_id: d.memberId != null ? Number(d.memberId) : null, customer_name: d.customerName, purpose: d.purpose, amount: n(d.amount), applied: n(d.appliedAmount), refunded: n(d.refundedAmount), remaining: r2(n(d.amount) - n(d.appliedAmount) - n(d.refundedAmount)), status: d.status, created_at: d.createdAt })) };
  }

  private async loadDeposit(depositNo: string, user: JwtUser) {
    const [d] = await (this.db as any).select().from(customerDeposits).where(and(eq(customerDeposits.tenantId, user.tenantId as any), eq(customerDeposits.depositNo, depositNo))).limit(1);
    if (!d) throw new NotFoundException({ code: 'DEPOSIT_NOT_FOUND', message: 'Deposit not found', messageTh: 'ไม่พบมัดจำ' });
    return d;
  }

  // ── house / charge accounts ──
  async openAccount(dto: { name: string; member_id?: number; credit_limit?: number }, user: JwtUser) {
    const db = this.db as any;
    const accountNo = await this.docNo.nextDaily('HA');
    const [a] = await db.insert(houseAccounts).values({ tenantId: user.tenantId ?? null, accountNo, memberId: dto.member_id ?? null, name: dto.name, creditLimit: String(r2(n(dto.credit_limit))), balance: '0', status: 'active', createdBy: user.username }).returning({ id: houseAccounts.id });
    return { id: Number(a.id), account_no: accountNo, name: dto.name, credit_limit: r2(n(dto.credit_limit)), balance: 0, status: 'active' };
  }

  // Charge a credit sale to the account (enforces the credit limit): Dr 1100 AR / Cr 4000 net / Cr 2100 VAT.
  async charge(accountNo: string, dto: { amount: number; sale_no?: string; memo?: string }, user: JwtUser) {
    const db = this.db as any;
    const acct = await this.loadAccount(accountNo, user);
    if (acct.status !== 'active') throw new BadRequestException({ code: 'ACCOUNT_NOT_ACTIVE', message: 'Account is not active', messageTh: 'บัญชีไม่พร้อมใช้งาน' });
    const amount = r2(n(dto.amount));
    if (amount <= 0) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'Amount must be positive', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
    const newBalance = r2(n(acct.balance) + amount);
    if (n(acct.creditLimit) > 0 && newBalance > n(acct.creditLimit) + 0.001) throw new BadRequestException({ code: 'CREDIT_LIMIT_EXCEEDED', message: `Charge would exceed credit limit (${n(acct.creditLimit)})`, messageTh: `เกินวงเงินเครดิต (${n(acct.creditLimit)})` });
    const inc = this.tax.calcInclusive({ gross: amount, country: 'TH' });
    const je: any = await this.ledger.postEntry({ source: 'HOUSE-CHARGE', sourceRef: dto.sale_no ?? accountNo, tenantId: user.tenantId, memo: `House charge ${accountNo}${dto.memo ? ` — ${dto.memo}` : ''}`, createdBy: user.username, lines: [{ account_code: '1100', debit: amount }, { account_code: '4000', credit: r2(inc.net) }, ...(inc.tax > 0 ? [{ account_code: '2100', credit: r2(inc.tax) }] : [])] });
    const entry = await this.appendEntry(acct, 'charge', amount, newBalance, { saleNo: dto.sale_no, memo: dto.memo, journalNo: je?.entry_no, user });
    await db.update(houseAccounts).set({ balance: String(newBalance) }).where(eq(houseAccounts.id, acct.id));
    return { account_no: accountNo, entry_no: entry, charged: amount, balance: newBalance, journal_no: je?.entry_no ?? null };
  }

  // Settle (pay down) the account. `amount` is the THB owed this payment clears (the AR cleared). Optionally
  // tendered in a foreign currency: `foreign_tendered` × `fx_rate` = THB cash received; any difference vs the
  // THB cleared is a REALISED FX gain/loss (5410). Dr 1000 received + (Dr 5410 loss) = Cr 1100 applied + (Cr 5410 gain).
  async settle(accountNo: string, dto: { amount: number; currency?: string; fx_rate?: number; foreign_tendered?: number; memo?: string }, user: JwtUser) {
    const db = this.db as any;
    const acct = await this.loadAccount(accountNo, user);
    const appliedThb = r2(n(dto.amount));
    if (appliedThb <= 0) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'Amount must be positive', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
    if (appliedThb > n(acct.balance) + 0.001) throw new BadRequestException({ code: 'OVER_SETTLE', message: `Cannot settle ${appliedThb} — balance is ${n(acct.balance)}`, messageTh: `ชำระเกินยอดค้าง (${n(acct.balance)})` });
    const currency = (dto.currency ?? 'THB').toUpperCase();
    const rate = currency === 'THB' ? 1 : n(dto.fx_rate);
    if (currency !== 'THB' && rate <= 0) throw new BadRequestException({ code: 'BAD_FX_RATE', message: 'fx_rate required for non-THB settlement', messageTh: 'ต้องระบุอัตราแลกเปลี่ยน' });
    // THB value of the cash actually received. Default: exact change → equals the THB cleared (no FX).
    const receivedThb = currency !== 'THB' && dto.foreign_tendered != null ? r2(n(dto.foreign_tendered) * rate) : appliedThb;
    const fxGainLoss = r2(receivedThb - appliedThb); // + = gain (we received more THB than we cleared)
    const newBalance = r2(n(acct.balance) - appliedThb);
    const je: any = await this.ledger.postEntry({ source: 'HOUSE-SETTLE', sourceRef: accountNo, tenantId: user.tenantId, memo: `House settle ${accountNo}${currency !== 'THB' ? ` (${currency}@${rate})` : ''}`, createdBy: user.username, lines: [
      { account_code: '1000', debit: receivedThb },
      ...(fxGainLoss < 0 ? [{ account_code: '5410', debit: r2(-fxGainLoss) }] : []), // loss → debit
      { account_code: '1100', credit: appliedThb },
      ...(fxGainLoss > 0 ? [{ account_code: '5410', credit: fxGainLoss }] : []),     // gain → credit
    ] });
    const entry = await this.appendEntry(acct, 'payment', appliedThb, newBalance, { memo: dto.memo, journalNo: je?.entry_no, currency, fxRate: rate, fxGainLoss, user });
    await db.update(houseAccounts).set({ balance: String(newBalance) }).where(eq(houseAccounts.id, acct.id));
    return { account_no: accountNo, entry_no: entry, settled: appliedThb, currency, fx_rate: rate, received_thb: receivedThb, fx_gain_loss: fxGainLoss, balance: newBalance, journal_no: je?.entry_no ?? null };
  }

  async statement(accountNo: string, user: JwtUser) {
    const db = this.db as any;
    const acct = await this.loadAccount(accountNo, user);
    const rows = await db.select().from(houseAccountEntries).where(eq(houseAccountEntries.accountId, Number(acct.id))).orderBy(houseAccountEntries.id);
    return {
      account_no: accountNo, name: acct.name, credit_limit: n(acct.creditLimit), balance: n(acct.balance), status: acct.status,
      available_credit: n(acct.creditLimit) > 0 ? r2(n(acct.creditLimit) - n(acct.balance)) : null,
      entries: rows.map((e: any) => ({ entry_no: e.entryNo, type: e.type, sale_no: e.saleNo, amount: n(e.amount), balance_after: n(e.balanceAfter), currency: e.currency, fx_rate: n(e.fxRate), memo: e.memo, created_at: e.createdAt })),
    };
  }

  async listAccounts(_user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(houseAccounts).orderBy(desc(houseAccounts.id)).limit(200);
    return { accounts: rows.map((a: any) => ({ account_no: a.accountNo, name: a.name, member_id: a.memberId != null ? Number(a.memberId) : null, credit_limit: n(a.creditLimit), balance: n(a.balance), status: a.status })) };
  }

  private async appendEntry(acct: any, type: string, amount: number, balanceAfter: number, opts: { saleNo?: string; memo?: string; journalNo?: string | null; currency?: string; fxRate?: number; fxGainLoss?: number; user: JwtUser }) {
    const entryNo = await this.docNo.nextDaily('HAE');
    await (this.db as any).insert(houseAccountEntries).values({ tenantId: opts.user.tenantId ?? null, accountId: Number(acct.id), entryNo, type, saleNo: opts.saleNo ?? null, amount: String(amount), balanceAfter: String(balanceAfter), currency: opts.currency ?? 'THB', fxRate: String(opts.fxRate ?? 1), fxGainLoss: String(opts.fxGainLoss ?? 0), journalNo: opts.journalNo ?? null, memo: opts.memo ?? null, createdBy: opts.user.username });
    return entryNo;
  }

  private async loadAccount(accountNo: string, user: JwtUser) {
    const [a] = await (this.db as any).select().from(houseAccounts).where(and(eq(houseAccounts.tenantId, user.tenantId as any), eq(houseAccounts.accountNo, accountNo))).limit(1);
    if (!a) throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND', message: 'House account not found', messageTh: 'ไม่พบบัญชีเครดิต' });
    return a;
  }

  // ── card surcharge ──
  async setSurcharge(dto: { method: string; pct: number; active?: boolean }, user: JwtUser) {
    const db = this.db as any;
    if (n(dto.pct) < 0 || n(dto.pct) > 20) throw new BadRequestException({ code: 'BAD_PCT', message: 'Surcharge % must be 0–20', messageTh: 'เปอร์เซ็นต์ค่าธรรมเนียมต้องอยู่ที่ 0–20' });
    const [existing] = await db.select().from(paymentSurcharges).where(and(eq(paymentSurcharges.tenantId, user.tenantId as any), eq(paymentSurcharges.method, dto.method))).limit(1);
    if (existing) { await db.update(paymentSurcharges).set({ pct: String(dto.pct), active: dto.active ?? true }).where(eq(paymentSurcharges.id, existing.id)); return { method: dto.method, pct: n(dto.pct), active: dto.active ?? true, updated: true }; }
    await db.insert(paymentSurcharges).values({ tenantId: user.tenantId ?? null, method: dto.method, pct: String(dto.pct), active: dto.active ?? true, createdBy: user.username });
    return { method: dto.method, pct: n(dto.pct), active: dto.active ?? true, updated: false };
  }

  async listSurcharges(_user: JwtUser) {
    const rows = await (this.db as any).select().from(paymentSurcharges).orderBy(paymentSurcharges.method);
    return { surcharges: rows.map((s: any) => ({ method: s.method, pct: n(s.pct), active: s.active })) };
  }

  async quoteSurcharge(method: string, amount: number, user: JwtUser) {
    const [s] = await (this.db as any).select().from(paymentSurcharges).where(and(eq(paymentSurcharges.tenantId, user.tenantId as any), eq(paymentSurcharges.method, method), eq(paymentSurcharges.active, true))).limit(1);
    const pct = s ? n(s.pct) : 0;
    const surcharge = r2(n(amount) * pct / 100);
    return { method, pct, base: r2(n(amount)), surcharge, total: r2(n(amount) + surcharge) };
  }

  // Record a card surcharge as VATable income: Dr 1000 Cash / Cr 4500 net / Cr 2100 VAT.
  async chargeSurcharge(dto: { method: string; amount: number; sale_no?: string }, user: JwtUser) {
    const q = await this.quoteSurcharge(dto.method, dto.amount, user);
    if (q.surcharge <= 0) throw new BadRequestException({ code: 'NO_SURCHARGE', message: 'No active surcharge for this method', messageTh: 'ไม่มีค่าธรรมเนียมสำหรับช่องทางนี้' });
    const inc = this.tax.calcInclusive({ gross: q.surcharge, country: 'TH' });
    const je: any = await this.ledger.postEntry({ source: 'CARD-SURCHARGE', sourceRef: dto.sale_no ?? dto.method, tenantId: user.tenantId, memo: `Card surcharge ${dto.method}`, createdBy: user.username, lines: [{ account_code: '1000', debit: q.surcharge }, { account_code: '4500', credit: r2(inc.net) }, ...(inc.tax > 0 ? [{ account_code: '2100', credit: r2(inc.tax) }] : [])] });
    return { method: dto.method, surcharge: q.surcharge, net: r2(inc.net), vat: r2(inc.tax), journal_no: je?.entry_no ?? null };
  }
}
