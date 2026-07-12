import { Inject, Injectable, Optional, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { revContracts, revFinancingSchedules } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import { n, fx, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// ── Track D — Wave 4 (REV-27, FINAL): significant financing component (TFRS 15 / IFRS 15 / ASC 606 §60-65) ──
// When the TIMING of payment gives the customer or the entity a MATERIAL financing benefit, the promised
// consideration is adjusted to its cash-selling-price PRESENT VALUE, and the difference (face − PV) is
// recognized as interest UNWOUND over the contract by the effective-interest method — the SAME EIR primitive
// the lease engine uses (leases.service.ts presentValue + periodic interest accrual). Two directions
// (TFRS 15 / IFRS 15 §60-65; Examples 26 & 29):
//   • advance (customer PREPAYS)  — the entity has effectively BORROWED from the customer, so it recognizes
//                                   interest EXPENSE (5900) and the contract liability ACCRETES from PV toward
//                                   face: Dr 5900 / Cr 2410. (IFRS 15 Example 29.)
//   • arrears (deferred payment)  — the entity effectively LENDS to the customer, so it recognizes interest
//                                   INCOME (4650) and the contract asset/receivable ACCRETES from PV toward
//                                   face: Dr 1265 / Cr 4650. (IFRS 15 Example 26.)
// The DISCOUNT RATE is a management JUDGEMENT and IS the control (an aggressive/omitted rate mis-states the
// revenue↔interest split), so the component is a maker-checker artifact: the maker records+rates it (rows land
// 'Pending', drive NOTHING), a DIFFERENT user approves it (→ SOD_SELF_APPROVAL), and only an APPROVED
// component may post its interest unwind. All GL routes through LedgerService.postEntry (PERIOD_LOCKED + GL-17
// audit), idempotent via alreadyPosted. New COA 4650 (arrears interest income); the advance case reuses 5900.

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;
function addMonths(period: string, k: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + k;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

export type FinancingDirection = 'advance' | 'arrears';
export interface FinancingComponentDto {
  discount_rate_pct: number;              // annual discount rate — the management JUDGEMENT (maker-checker)
  periods: number;                        // number of monthly unwind periods
  direction?: FinancingDirection;         // advance (prepay → 4650) | arrears (deferred → 5900); default advance
  material?: boolean;                     // the maker's assertion that the financing component IS significant
  nominal?: number;                       // face/undiscounted amount (default = contract total_price)
  start_period?: string;                  // 'YYYY-MM' the first interest period (default the contract month)
  note?: string;
}
export interface RunFinancingDto { period?: string; date?: string }

@Injectable()
export class RevFinancingService {
  // @Optional ledger so a standalone/partial harness can construct the service without the GL graph.
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly ledger?: LedgerService,
  ) {}

  private async assertContract(id: number) {
    const [c] = await this.db.select().from(revContracts).where(eq(revContracts.id, id)).limit(1);
    if (!c) throw new NotFoundException({ code: 'CONTRACT_NOT_FOUND', message: `Contract ${id} not found`, messageTh: `ไม่พบสัญญา ${id}` });
    return c;
  }

  // Present value of a single lump sum discounted `periods` months at monthly rate r (r=0 → face). The
  // financing amount = face − PV is unwound by EIR: opening balance = PV, each period accrues balance×r so the
  // balance grows back to face over the term; Σ interest == face − PV exactly (the residual lands on the last).
  private buildUnwind(nominal: number, ratePct: number, periods: number) {
    const r = ratePct / 100 / 12;
    const pv = round4(r === 0 ? nominal : nominal / Math.pow(1 + r, periods));
    const financingTotal = round4(nominal - pv);
    const rows: { opening: number; interest: number; closing: number }[] = [];
    let bal = pv; let accrued = 0;
    for (let i = 0; i < periods; i++) {
      const isLast = i === periods - 1;
      const interest = isLast ? round4(financingTotal - accrued) : round4(bal * r);
      const closing = isLast ? nominal : round4(bal + interest);
      rows.push({ opening: round4(bal), interest, closing });
      bal = closing; accrued = round4(accrued + interest);
    }
    return { pv, financingTotal, rows };
  }

  // ── POST :id/financing-component — MAKER flags a MATERIAL financing component + sets the discount rate,
  //    which discounts the transaction price to PV and schedules the EIR interest unwind. Rows land 'Pending'
  //    tagged with the maker (created_by) and DRIVE NOTHING until a different user approves the rate (SoD). ──
  async setFinancingComponent(contractId: number, dto: FinancingComponentDto, user: JwtUser) {
    const db = this.db;
    const c = await this.assertContract(contractId);
    if (dto.material === false)
      throw new BadRequestException({ code: 'FINANCING_NOT_MATERIAL', message: 'no significant financing component to record (material flag is false)', messageTh: 'ไม่มีองค์ประกอบทางการเงินที่มีนัยสำคัญให้บันทึก' });
    const rate = n(dto.discount_rate_pct);
    if (!(rate > 0)) throw new BadRequestException({ code: 'INVALID_DISCOUNT_RATE', message: 'discount_rate_pct must be > 0 for a significant financing component', messageTh: 'อัตราคิดลดต้องมากกว่า 0' });
    const periods = Number(dto.periods);
    if (!Number.isInteger(periods) || periods < 1) throw new BadRequestException({ code: 'INVALID_PERIODS', message: 'periods must be a positive integer', messageTh: 'จำนวนงวดต้องเป็นจำนวนเต็มบวก' });
    const direction: FinancingDirection = dto.direction === 'arrears' ? 'arrears' : 'advance';
    const nominal = round4(dto.nominal != null ? n(dto.nominal) : n(c.totalPrice));
    if (!(nominal > 0)) throw new BadRequestException({ code: 'INVALID_NOMINAL', message: 'nominal (face) amount must be > 0', messageTh: 'มูลค่าที่ตราไว้ต้องมากกว่า 0' });

    // one financing component per contract while any row is live (Pending/Approved). Re-run only after a full reset.
    const existing = await db.select().from(revFinancingSchedules).where(eq(revFinancingSchedules.contractId, contractId));
    if (existing.some((rrow: any) => rrow.status === 'Pending' || rrow.status === 'Approved'))
      throw new BadRequestException({ code: 'FINANCING_ALREADY_SET', message: 'a financing component already exists for this contract', messageTh: 'สัญญานี้มีองค์ประกอบทางการเงินอยู่แล้ว' });

    const startP = dto.start_period && /^\d{4}-\d{2}$/.test(dto.start_period) ? dto.start_period : String(c.contractDate).slice(0, 7);
    const { pv, financingTotal, rows } = this.buildUnwind(nominal, rate, periods);
    for (let i = 0; i < rows.length; i++) {
      await db.insert(revFinancingSchedules).values({
        tenantId: c.tenantId, contractId, seq: i + 1, period: addMonths(startP, i), direction,
        discountRatePct: fx(rate, 4), nominal: fx(nominal, 4), presentValue: fx(pv, 4),
        openingBalance: fx(rows[i]!.opening, 4), interestAmount: fx(rows[i]!.interest, 4), closingBalance: fx(rows[i]!.closing, 4),
        status: 'Pending', posted: false, note: dto.note ?? null, createdBy: user.username,
      });
    }
    return {
      contract_id: contractId, contract_no: c.contractNo, currency: c.currency, direction,
      discount_rate_pct: rate, periods, nominal, present_value: pv, financing_total: financingTotal,
      status: 'Pending', created_by: user.username,
      basis: direction === 'advance'
        ? 'TFRS 15 §60-65 — customer prepays: the entity borrows from the customer; financing charge accretes the contract liability as interest expense (Dr 5900 / Cr 2410)'
        : 'TFRS 15 §60-65 — deferred payment: the entity finances the customer; interest income accretes the contract asset (Dr 1265 / Cr 4650)',
      schedule: await this.scheduleRows(contractId),
    };
  }

  // ── POST :id/financing-component/approve — CHECKER (≠ the maker, else SOD_SELF_APPROVAL) approves the
  //    discount-rate judgement, flipping the Pending schedule to Approved so run-financing may post it. ──
  async approveFinancingComponent(contractId: number, user: JwtUser) {
    const db = this.db;
    const c = await this.assertContract(contractId);
    const rows = await db.select().from(revFinancingSchedules).where(and(eq(revFinancingSchedules.contractId, contractId), eq(revFinancingSchedules.status, 'Pending')));
    if (!rows.length) throw new NotFoundException({ code: 'FINANCING_NOT_PENDING', message: `No pending financing component for contract ${contractId}`, messageTh: 'ไม่มีองค์ประกอบทางการเงินที่รออนุมัติ' });
    const maker = rows[0]!.createdBy;
    if (maker && maker === user.username)
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'The user who set the financing component (discount rate) cannot approve it (segregation of duties)', messageTh: 'ผู้กำหนดองค์ประกอบทางการเงิน (อัตราคิดลด) ไม่สามารถอนุมัติเองได้ (แบ่งแยกหน้าที่)' });
    const when = new Date();
    for (const rrow of rows)
      await db.update(revFinancingSchedules).set({ status: 'Approved', approvedBy: user.username, approvedAt: when }).where(eq(revFinancingSchedules.id, Number(rrow.id)));
    return { contract_id: contractId, contract_no: c.contractNo, status: 'Approved', approved_by: user.username, approved_periods: rows.length };
  }

  // ── POST :id/run-financing — post the periodic interest unwind for the Approved schedule due through the
  //    period (idempotent). advance: Dr 5900 / Cr 2410 (interest expense, liability accretes); arrears: Dr 1265 / Cr 4650 (interest income, asset accretes). ──
  async runFinancing(contractId: number, dto: RunFinancingDto, user: JwtUser) {
    const db = this.db;
    const c = await this.assertContract(contractId);
    const period = dto.period && /^\d{4}-\d{2}$/.test(dto.period) ? dto.period : ymd().slice(0, 7);
    const all = await db.select().from(revFinancingSchedules).where(eq(revFinancingSchedules.contractId, contractId)).orderBy(revFinancingSchedules.seq);
    const approved = all.filter((rrow: any) => rrow.status === 'Approved');
    if (!approved.length) {
      if (all.some((rrow: any) => rrow.status === 'Pending'))
        throw new BadRequestException({ code: 'FINANCING_NOT_APPROVED', message: 'the financing component is pending approval of the discount rate; it cannot post interest yet', messageTh: 'องค์ประกอบทางการเงินยังรออนุมัติอัตราคิดลด — ยังลงรายการดอกเบี้ยไม่ได้' });
      throw new NotFoundException({ code: 'NO_FINANCING_COMPONENT', message: `No financing component for contract ${contractId}`, messageTh: 'ไม่พบองค์ประกอบทางการเงิน' });
    }
    const due = approved.filter((rrow: any) => !rrow.posted && String(rrow.period) <= period);
    const entries: any[] = []; let total = 0;
    for (const rrow of due) {
      const interest = round4(n(rrow.interestAmount));
      const ref = `REVFIN:${c.contractNo}:${Number(rrow.seq)}`;
      let entryNo: string | null = null;
      if (interest > 0 && this.ledger && !(await this.ledger.alreadyPosted('REVFIN', ref, c.tenantId))) {
        const lines = rrow.direction === 'arrears'
          ? [
              // arrears → REVFIN.INCOME: the entity lends to the customer; interest income accretes the contract asset.
              { account_code: postingDefault('REVFIN.INCOME', 'contract_asset'), debit: interest, memo: 'Contract asset accretes — financing interest income on the customer receivable' },
              { account_code: postingDefault('REVFIN.INCOME', 'interest_income'), credit: interest, memo: 'Significant financing component interest income' },
            ]
          : [
              // advance → REVFIN.EXPENSE: the entity borrows from the customer; interest expense accretes the contract liability.
              { account_code: postingDefault('REVFIN.EXPENSE', 'interest_expense'), debit: interest, memo: 'Financing interest expense on the customer prepayment' },
              { account_code: postingDefault('REVFIN.EXPENSE', 'contract_liability'), credit: interest, memo: 'Contract liability accretes toward face (financing charge)' },
            ];
        const je: any = await this.ledger.postEntry({
          date: dto.date ?? `${rrow.period}-01`, source: 'REVFIN', sourceRef: ref, tenantId: c.tenantId, currency: c.currency ?? undefined,
          memo: `TFRS15 financing component ${c.contractNo} ${rrow.period} (${rrow.direction})`, createdBy: user.username, lines,
        });
        entryNo = je?.entry_no ?? null;
      }
      await db.update(revFinancingSchedules).set({ posted: true, entryNo, postedAt: new Date() }).where(eq(revFinancingSchedules.id, Number(rrow.id)));
      entries.push({ seq: Number(rrow.seq), period: rrow.period, direction: rrow.direction, interest, entry_no: entryNo });
      total = round4(total + interest);
    }
    return { contract_id: contractId, contract_no: c.contractNo, period, posted_count: entries.length, total_interest: total, entries };
  }

  private async scheduleRows(contractId: number) {
    const rows = await this.db.select().from(revFinancingSchedules).where(eq(revFinancingSchedules.contractId, contractId)).orderBy(revFinancingSchedules.seq);
    return rows.map((rrow: any) => ({
      id: Number(rrow.id), seq: Number(rrow.seq), period: rrow.period, direction: rrow.direction,
      opening_balance: n(rrow.openingBalance), interest_amount: n(rrow.interestAmount), closing_balance: n(rrow.closingBalance),
      status: rrow.status, posted: rrow.posted, entry_no: rrow.entryNo, created_by: rrow.createdBy, approved_by: rrow.approvedBy,
    }));
  }

  // ── GET :id/financing-component — the financing schedule + the PV/face/interest summary (detective read). ──
  async getFinancingComponent(contractId: number) {
    const db = this.db;
    const c = await this.assertContract(contractId);
    const rows = await db.select().from(revFinancingSchedules).where(eq(revFinancingSchedules.contractId, contractId)).orderBy(desc(revFinancingSchedules.seq)).limit(1);
    const head: any = rows[0];
    const sched = await this.scheduleRows(contractId);
    const interestTotal = round4(sched.reduce((a, s) => a + n(s.interest_amount), 0));
    const postedTotal = round4(sched.filter((s) => s.posted).reduce((a, s) => a + n(s.interest_amount), 0));
    return {
      contract_id: contractId, contract_no: c.contractNo, currency: c.currency,
      direction: head?.direction ?? null, discount_rate_pct: head ? n(head.discountRatePct) : null,
      nominal: head ? n(head.nominal) : null, present_value: head ? n(head.presentValue) : null,
      financing_total: interestTotal, interest_posted: postedTotal, interest_unposted: round4(interestTotal - postedTotal),
      status: head?.status ?? null, schedule: sched,
    };
  }
}
