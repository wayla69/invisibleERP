import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { reProjects, reUnits, reBookings, reContracts, reInstallments } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const n = (x: unknown) => Number(x ?? 0);
const EPS = 0.005;

// GL: cash 1000, customer deposits (booking) 2210, contract liability (cash received pre-transfer) 2410.
const GL_CASH = '1000', GL_DEPOSIT = '2210', GL_CONTRACT_LIAB = '2410';

const addMonths = (d: Date, m: number) => { const x = new Date(d.getTime()); x.setMonth(x.getMonth() + m); return x.toISOString().slice(0, 10); };

export interface CreateDevDto { dev_code: string; name: string; location?: string }
export interface AddUnitDto { unit_no: string; unit_type?: string; area_sqm?: number; floor?: string; list_price: number }
export interface BookDto { dev_code: string; unit_no: string; buyer_name?: string; deposit: number; expires_on?: string }
export interface CreateContractDto { dev_code: string; unit_no: string; booking_no?: string; buyer_name?: string; discount?: number; down_payment: number; installment_count: number }
export interface PayDto { amount: number }

// Real-estate developer vertical (docs/35 P4, RE-01/02/03). Units → booking → sale contract (maker-checker) →
// installments. Cash received before transfer is a contract liability (2410) / deposit (2210); revenue
// recognises at transfer (P5). Standalone module (imports Ledger for the receipts; DocNumber @Global).
@Injectable()
export class RealEstateService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly ledger: LedgerService,
  ) {}

  private async devRow(devCode: string) {
    const [d] = await this.db.select().from(reProjects).where(eq(reProjects.devCode, devCode)).limit(1);
    if (!d) throw new NotFoundException({ code: 'DEVELOPMENT_NOT_FOUND', message: `Development ${devCode} not found`, messageTh: 'ไม่พบโครงการอสังหาฯ' });
    return d;
  }
  private async unitRow(devCode: string, unitNo: string) {
    const d = await this.devRow(devCode);
    const [u] = await this.db.select().from(reUnits).where(and(eq(reUnits.reProjectId, Number(d.id)), eq(reUnits.unitNo, unitNo))).limit(1);
    if (!u) throw new NotFoundException({ code: 'UNIT_NOT_FOUND', message: `Unit ${unitNo} not found in ${devCode}`, messageTh: 'ไม่พบยูนิต' });
    return u;
  }
  private async contractRow(contractNo: string) {
    const [c] = await this.db.select().from(reContracts).where(eq(reContracts.contractNo, contractNo)).limit(1);
    if (!c) throw new NotFoundException({ code: 'CONTRACT_NOT_FOUND', message: `Contract ${contractNo} not found`, messageTh: 'ไม่พบสัญญาจะซื้อจะขาย' });
    return c;
  }

  // ── D1 — property master & unit inventory ──
  async createDevelopment(dto: CreateDevDto, user: JwtUser) {
    await this.db.insert(reProjects).values({ tenantId: user.tenantId ?? null, devCode: dto.dev_code, name: dto.name, location: dto.location ?? null, status: 'active', createdBy: user.username });
    return this.listUnits(dto.dev_code);
  }
  async addUnit(devCode: string, dto: AddUnitDto, user: JwtUser) {
    const d = await this.devRow(devCode);
    if (n(dto.list_price) <= 0) throw new BadRequestException({ code: 'BAD_PRICE', message: 'list_price must be positive', messageTh: 'ราคาต้องมากกว่าศูนย์' });
    await this.db.insert(reUnits).values({
      tenantId: d.tenantId ?? user.tenantId ?? null, reProjectId: Number(d.id), unitNo: dto.unit_no, unitType: dto.unit_type ?? 'condo',
      areaSqm: String(r2(n(dto.area_sqm))), floor: dto.floor ?? null, listPrice: String(r2(n(dto.list_price))), status: 'available',
    });
    return this.getUnit(devCode, dto.unit_no);
  }
  async getUnit(devCode: string, unitNo: string) {
    const u = await this.unitRow(devCode, unitNo);
    return { dev_code: devCode, unit_no: u.unitNo, unit_type: u.unitType, area_sqm: n(u.areaSqm), floor: u.floor, list_price: n(u.listPrice), status: u.status };
  }
  async listUnits(devCode: string) {
    const d = await this.devRow(devCode);
    const units = await this.db.select().from(reUnits).where(eq(reUnits.reProjectId, Number(d.id))).orderBy(asc(reUnits.unitNo));
    const count = (st: string) => units.filter((u: any) => u.status === st).length;
    return {
      dev_code: devCode, name: d.name, location: d.location,
      units: units.map((u: any) => ({ unit_no: u.unitNo, unit_type: u.unitType, area_sqm: n(u.areaSqm), floor: u.floor, list_price: n(u.listPrice), status: u.status })),
      summary: { total: units.length, available: count('available'), reserved: count('reserved'), contracted: count('contracted'), transferred: count('transferred') },
    };
  }

  // ── D2 — booking → sale contract → installments ──
  // RE-01: a unit can only be booked when AVAILABLE (no double-booking).
  async book(dto: BookDto, user: JwtUser) {
    const u = await this.unitRow(dto.dev_code, dto.unit_no);
    if (u.status !== 'available') throw new BadRequestException({ code: 'UNIT_NOT_AVAILABLE', message: `Unit ${dto.unit_no} is ${u.status}, not available`, messageTh: 'ยูนิตนี้ไม่ว่างให้จอง' });
    const deposit = r2(n(dto.deposit));
    const bookingNo = await this.docNo.nextDaily('BKG');
    const tenantId = u.tenantId ?? user.tenantId ?? null;
    return this.db.transaction(async (tx) => {
      let entryNo: string | null = null;
      if (deposit > 0) {
        const je: any = await this.ledger.postEntry({ source: 'RE-BOOK', sourceRef: bookingNo, tenantId, memo: `Booking deposit ${bookingNo} (${dto.unit_no})`, createdBy: user.username, lines: [
          { account_code: GL_CASH, debit: deposit, memo: `Booking deposit ${dto.unit_no}` },
          { account_code: GL_DEPOSIT, credit: deposit, memo: `Customer deposit ${bookingNo}` },
        ] }, tx);
        entryNo = je.entry_no;
      }
      await tx.insert(reBookings).values({ tenantId, unitId: Number(u.id), bookingNo, buyerName: dto.buyer_name ?? null, deposit: String(deposit), status: 'held', expiresOn: dto.expires_on ?? null, entryNo, createdBy: user.username });
      await tx.update(reUnits).set({ status: 'reserved', updatedAt: new Date() }).where(eq(reUnits.id, Number(u.id)));
      return { booking_no: bookingNo, unit_no: dto.unit_no, deposit, status: 'held', entry_no: entryNo };
    });
  }

  // Draft a sale contract (price/discount authority; approved maker-checker → RE-02). No GL until approved.
  async createContract(dto: CreateContractDto, user: JwtUser) {
    const u = await this.unitRow(dto.dev_code, dto.unit_no);
    if (u.status !== 'available' && u.status !== 'reserved') throw new BadRequestException({ code: 'UNIT_NOT_CONTRACTABLE', message: `Unit ${dto.unit_no} is ${u.status}`, messageTh: 'ยูนิตนี้ทำสัญญาไม่ได้' });
    const listPrice = r2(n(u.listPrice));
    const discount = r2(Math.max(0, n(dto.discount)));
    if (discount > listPrice + EPS) throw new BadRequestException({ code: 'BAD_DISCOUNT', message: `Discount ${discount} exceeds the list price ${listPrice}`, messageTh: 'ส่วนลดเกินราคาตั้ง' });
    const price = r2(listPrice - discount);
    const downPayment = r2(n(dto.down_payment));
    if (downPayment < 0 || downPayment > price + EPS) throw new BadRequestException({ code: 'BAD_DOWN_PAYMENT', message: `Down payment ${downPayment} must be between 0 and the price ${price}`, messageTh: 'เงินดาวน์ไม่ถูกต้อง' });
    const installmentCount = Math.max(0, Math.floor(n(dto.installment_count)));
    const balance = r2(price - downPayment);
    if (balance > EPS && installmentCount < 1) throw new BadRequestException({ code: 'INSTALLMENTS_REQUIRED', message: 'A remaining balance requires at least one installment', messageTh: 'ยอดคงเหลือต้องมีงวดผ่อนอย่างน้อย 1 งวด' });

    let bookingId: number | null = null;
    if (dto.booking_no) {
      const [b] = await this.db.select().from(reBookings).where(eq(reBookings.bookingNo, dto.booking_no)).limit(1);
      if (!b || Number(b.unitId) !== Number(u.id)) throw new BadRequestException({ code: 'BOOKING_NOT_FOR_UNIT', message: `Booking ${dto.booking_no} is not for unit ${dto.unit_no}`, messageTh: 'ใบจองไม่ตรงกับยูนิต' });
      if (b.status !== 'held') throw new BadRequestException({ code: 'BOOKING_NOT_HELD', message: `Booking ${dto.booking_no} is ${b.status}`, messageTh: 'ใบจองไม่อยู่ในสถานะจอง' });
      if (n(b.deposit) > downPayment + EPS) throw new BadRequestException({ code: 'BAD_DOWN_PAYMENT', message: `Down payment ${downPayment} is less than the booking deposit ${n(b.deposit)}`, messageTh: 'เงินดาวน์ต้องไม่น้อยกว่าเงินจอง' });
      bookingId = Number(b.id);
    }
    const contractNo = await this.docNo.nextDaily('REC');
    await this.db.insert(reContracts).values({
      tenantId: u.tenantId ?? user.tenantId ?? null, unitId: Number(u.id), bookingId, contractNo, buyerName: dto.buyer_name ?? null,
      listPrice: String(listPrice), discount: String(discount), price: String(price), downPayment: String(downPayment), balance: String(balance),
      installmentCount, status: 'draft', createdBy: user.username,
    });
    return this.getContract(contractNo);
  }

  // Approve a draft contract (maker-checker, approver ≠ creator → RE-02) → contract active: unit contracted,
  // booking converted, the down-payment posts to the contract liability (2410), installment schedule generated.
  async approveContract(contractNo: string, user: JwtUser) {
    const c = await this.contractRow(contractNo);
    if (c.status !== 'draft') throw new BadRequestException({ code: 'CONTRACT_NOT_DRAFT', message: `Contract ${contractNo} is ${c.status}, not draft`, messageTh: 'สัญญาไม่ได้อยู่ในสถานะร่าง' });
    if (user.username && c.createdBy && user.username === c.createdBy) throw new BadRequestException({ code: 'SOD_SELF_APPROVAL', message: 'The contract preparer cannot approve their own contract (SoD)', messageTh: 'ผู้จัดทำสัญญาอนุมัติเองไม่ได้ (แบ่งแยกหน้าที่)' });
    const [u] = await this.db.select().from(reUnits).where(eq(reUnits.id, Number(c.unitId))).limit(1);
    if (!u || (u.status !== 'available' && u.status !== 'reserved')) throw new BadRequestException({ code: 'UNIT_NOT_CONTRACTABLE', message: `Unit is ${u?.status}`, messageTh: 'ยูนิตนี้ทำสัญญาไม่ได้แล้ว' });
    const tenantId = c.tenantId ?? user.tenantId ?? null;
    const downPayment = r2(n(c.downPayment));
    const bookingDeposit = c.bookingId ? r2(n((await this.db.select().from(reBookings).where(eq(reBookings.id, Number(c.bookingId))).limit(1))[0]?.deposit)) : 0;
    const cashIn = r2(downPayment - bookingDeposit); // additional cash collected at signing (deposit already banked)
    if (await this.ledger.alreadyPosted('RE-CONTRACT', contractNo, tenantId)) return { already: true, contract_no: contractNo };

    const entryNo = await this.db.transaction(async (tx) => {
      let je: any = { entry_no: null };
      if (downPayment > 0) {
        const lines: any[] = [];
        if (cashIn > 0) lines.push({ account_code: GL_CASH, debit: cashIn, memo: `Down payment ${contractNo}` });
        if (bookingDeposit > 0) lines.push({ account_code: GL_DEPOSIT, debit: bookingDeposit, memo: `Reclass booking deposit ${contractNo}` });
        lines.push({ account_code: GL_CONTRACT_LIAB, credit: downPayment, memo: `Contract liability ${contractNo}` });
        je = await this.ledger.postEntry({ source: 'RE-CONTRACT', sourceRef: contractNo, tenantId, memo: `Sale contract ${contractNo} down payment`, createdBy: user.username, lines }, tx);
      }
      // Installment schedule — equal parts, the last absorbs the rounding residual; monthly from approval.
      const balance = r2(n(c.balance));
      const count = Number(c.installmentCount);
      if (balance > EPS && count > 0) {
        const base = r2(Math.floor((balance / count) * 100) / 100);
        const base0 = new Date();
        for (let i = 1; i <= count; i++) {
          const amt = i === count ? r2(balance - base * (count - 1)) : base;
          await tx.insert(reInstallments).values({ tenantId, contractId: Number(c.id), seq: i, dueDate: addMonths(base0, i), amount: String(amt), status: 'pending' });
        }
      }
      if (c.bookingId) await tx.update(reBookings).set({ status: 'converted', updatedAt: new Date() }).where(eq(reBookings.id, Number(c.bookingId)));
      await tx.update(reUnits).set({ status: 'contracted', updatedAt: new Date() }).where(eq(reUnits.id, Number(c.unitId)));
      await tx.update(reContracts).set({ status: 'active', approvedBy: user.username, approvedAt: new Date(), entryNo: je.entry_no, updatedAt: new Date() }).where(eq(reContracts.id, Number(c.id)));
      return je.entry_no;
    });
    return { contract_no: contractNo, status: 'active', unit_status: 'contracted', down_payment: downPayment, cash_collected: cashIn, entry_no: entryNo };
  }

  // Pay an installment (RE-03: exact amount, pending only, no double-pay). Cash → contract liability (2410).
  async payInstallment(installmentId: number, dto: PayDto, user: JwtUser) {
    const [inst] = await this.db.select().from(reInstallments).where(eq(reInstallments.id, Number(installmentId))).limit(1);
    if (!inst) throw new NotFoundException({ code: 'INSTALLMENT_NOT_FOUND', message: `Installment ${installmentId} not found`, messageTh: 'ไม่พบงวดผ่อน' });
    if (inst.status === 'paid') throw new BadRequestException({ code: 'INSTALLMENT_PAID', message: `Installment ${installmentId} is already paid`, messageTh: 'งวดนี้ชำระแล้ว' });
    const amount = r2(n(dto.amount));
    if (Math.abs(amount - r2(n(inst.amount))) > EPS) throw new BadRequestException({ code: 'BAD_AMOUNT', message: `Payment ${amount} must equal the installment amount ${r2(n(inst.amount))}`, messageTh: 'จำนวนที่ชำระต้องเท่ากับยอดงวด' });
    const tenantId = inst.tenantId ?? user.tenantId ?? null;
    const [c] = await this.db.select({ no: reContracts.contractNo }).from(reContracts).where(eq(reContracts.id, Number(inst.contractId))).limit(1);
    const ref = `${c?.no}:INST${inst.seq}`;
    if (await this.ledger.alreadyPosted('RE-INSTALL', ref, tenantId)) return { already: true, installment_id: Number(installmentId) };
    const entryNo = await this.db.transaction(async (tx) => {
      const je: any = await this.ledger.postEntry({ source: 'RE-INSTALL', sourceRef: ref, tenantId, memo: `Installment ${ref}`, createdBy: user.username, lines: [
        { account_code: GL_CASH, debit: amount, memo: `Installment ${ref}` },
        { account_code: GL_CONTRACT_LIAB, credit: amount, memo: `Contract liability ${ref}` },
      ] }, tx);
      await tx.update(reInstallments).set({ status: 'paid', paidAmount: String(amount), paidAt: new Date(), entryNo: je.entry_no }).where(eq(reInstallments.id, Number(installmentId)));
      return je.entry_no;
    });
    return { installment_id: Number(installmentId), seq: inst.seq, amount, status: 'paid', entry_no: entryNo };
  }

  // ── Scheduled sweeps (docs/35 Depth) — ride the BI report scheduler ──
  private ymd() { return new Date().toISOString().slice(0, 10); }

  // Expire held bookings past their expiry date → free the unit back to available (inventory hygiene, RE-01).
  // The deposit stays a customer-deposit liability (2210) for a separate refund/forfeit decision.
  async expireDueBookings(asOf?: string): Promise<{ scanned: number; expired: number }> {
    const cutoff = asOf ?? this.ymd();
    const rows = await this.db.select().from(reBookings).where(and(eq(reBookings.status, 'held'), lt(reBookings.expiresOn, cutoff)));
    let expired = 0;
    for (const b of rows) {
      if (!b.expiresOn) continue;
      await this.db.update(reBookings).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(reBookings.id, Number(b.id)));
      await this.db.update(reUnits).set({ status: 'available', updatedAt: new Date() }).where(and(eq(reUnits.id, Number(b.unitId)), eq(reUnits.status, 'reserved')));
      expired += 1;
    }
    return { scanned: rows.length, expired };
  }

  // Overdue installments (detective sweep) — pending installments past their due date, for a dunning/worklist.
  async overdueInstallments(asOf?: string): Promise<{ overdue: number; total: number; items: any[] }> {
    const cutoff = asOf ?? this.ymd();
    const rows = await this.db.select().from(reInstallments).where(and(eq(reInstallments.status, 'pending'), lt(reInstallments.dueDate, cutoff))).orderBy(asc(reInstallments.dueDate));
    return {
      overdue: rows.length,
      total: r2(rows.reduce((a: number, i: any) => a + n(i.amount), 0)),
      items: rows.map((i: any) => ({ installment_id: Number(i.id), contract_id: Number(i.contractId), seq: i.seq, due_date: i.dueDate, amount: n(i.amount) })),
    };
  }

  async getContract(contractNo: string) {
    const c = await this.contractRow(contractNo);
    const installments = await this.db.select().from(reInstallments).where(eq(reInstallments.contractId, Number(c.id))).orderBy(asc(reInstallments.seq));
    const paid = r2(installments.filter((i: any) => i.status === 'paid').reduce((a: number, i: any) => a + n(i.paidAmount), 0));
    return {
      contract_no: c.contractNo, unit_id: Number(c.unitId), booking_id: c.bookingId ? Number(c.bookingId) : null, buyer_name: c.buyerName,
      list_price: n(c.listPrice), discount: n(c.discount), price: n(c.price), down_payment: n(c.downPayment), balance: n(c.balance),
      installment_count: c.installmentCount, status: c.status, created_by: c.createdBy, approved_by: c.approvedBy, entry_no: c.entryNo,
      installments_paid: paid, outstanding: r2(n(c.balance) - paid),
      installments: installments.map((i: any) => ({ id: Number(i.id), seq: i.seq, due_date: i.dueDate, amount: n(i.amount), paid_amount: n(i.paidAmount), status: i.status })),
    };
  }
}
