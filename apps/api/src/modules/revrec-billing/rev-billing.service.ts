import { Inject, Injectable, Optional, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { revContracts, revBillingSchedules, revrecSchedules } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { n, fx, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// ── Track D — Wave 1 (REV-24): contract-asset / contract-liability split + independent billing schedule ──
// TFRS 15 / IFRS 15 / ASC 606 §105-107. Billing is DECOUPLED from revenue recognition (RevRecService,
// REV-19). Revenue is recognized as performance obligations are satisfied; invoices are raised on their own
// milestone/period schedule here. The net position is:
//   • recognized > billed ⇒ CONTRACT ASSET (1265 unbilled receivable) — revenue earned ahead of invoicing.
//   • billed > recognized ⇒ CONTRACT LIABILITY (2410 deferred revenue) — invoiced ahead of performance.
// Billing (Dr 1100 AR) RECLASSES the earned contract asset 1265 → 1100 and parks any over-billing in 2410
// (mirrors the projects-POC pattern in projects.service.ts `bill`). Maker-checker (SoD): the user who
// DEFINES a billing milestone may NOT be the one who bills it. All GL routes through LedgerService.postEntry
// so PERIOD_LOCKED + GL-17 audit apply. No new COA (1100/1265/2410/4300 already exist + CF-classified).

const AR = '1100';                 // Accounts Receivable
const CONTRACT_ASSET = '1265';     // Contract Asset (Unbilled Receivable)
const CONTRACT_LIABILITY = '2410'; // Contract Liability / Deferred Revenue

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

export interface MilestoneDto { period: string; amount: number }
export interface DefineBillingScheduleDto { milestones: MilestoneDto[]; replace?: boolean }
export interface BillDto { billing_schedule_id: number; invoice_ref?: string; date?: string }

@Injectable()
export class RevBillingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly ledger?: LedgerService,
  ) {}

  private tid(user: JwtUser, explicit?: number | null): number {
    const t = explicit ?? user.tenantId ?? null;
    if (t == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'HQ/Admin must specify a tenant', messageTh: 'สำนักงานใหญ่ต้องระบุ tenant' });
    return Number(t);
  }

  private async assertContract(id: number) {
    const [c] = await this.db.select().from(revContracts).where(eq(revContracts.id, id)).limit(1);
    if (!c) throw new NotFoundException({ code: 'CONTRACT_NOT_FOUND', message: `Contract ${id} not found`, messageTh: `ไม่พบสัญญา ${id}` });
    return c;
  }

  // Σ recognized revenue for a contract (drives the contract-asset / contract-liability split).
  private async sumRecognized(contractId: number): Promise<number> {
    const rows = await this.db.select().from(revrecSchedules).where(eq(revrecSchedules.contractId, contractId));
    return round4(rows.filter((r: any) => r.recognized).reduce((a: number, r: any) => a + n(r.recognizedAmount), 0));
  }

  // ── POST :id/billing-schedule — MAKER defines the invoice milestones/periods (independent of the
  //    recognition schedule). Rows land in status 'Planned' tagged with the maker (created_by). A different
  //    user must bill them (SoD, REV-24). Σ milestones may not exceed the contract price (over-billing guard).
  async defineBillingSchedule(contractId: number, dto: DefineBillingScheduleDto, user: JwtUser) {
    const db = this.db;
    const c = await this.assertContract(contractId);
    if (!dto.milestones?.length) throw new BadRequestException({ code: 'NO_MILESTONES', message: 'at least one billing milestone is required', messageTh: 'ต้องมีงวดวางบิลอย่างน้อยหนึ่งงวด' });
    for (const m of dto.milestones) {
      if (!/^\d{4}-\d{2}$/.test(m.period)) throw new BadRequestException({ code: 'INVALID_PERIOD', message: `milestone period '${m.period}' must be YYYY-MM`, messageTh: 'งวดต้องเป็น YYYY-MM' });
      if (!(n(m.amount) > 0)) throw new BadRequestException({ code: 'INVALID_AMOUNT', message: 'milestone amount must be > 0', messageTh: 'จำนวนเงินงวดต้องมากกว่า 0' });
    }
    // existing planned (unbilled) milestones — optionally replaced, else added to.
    const existing = await db.select().from(revBillingSchedules).where(eq(revBillingSchedules.contractId, contractId));
    if (dto.replace) {
      for (const r of existing) if (r.status !== 'Billed') await db.delete(revBillingSchedules).where(eq(revBillingSchedules.id, Number(r.id)));
    }
    const stillPlanned = dto.replace ? [] : existing;
    const priorPlanned = round4(stillPlanned.reduce((a: number, r: any) => a + n(r.plannedAmount), 0));
    const newTotal = round4(dto.milestones.reduce((a: number, m: any) => a + n(m.amount), 0));
    // The billing schedule may not plan to invoice MORE than the contract price (customer over-billing).
    if (round4(priorPlanned + newTotal) > round4(n(c.totalPrice)) + 0.01)
      throw new BadRequestException({ code: 'SCHEDULE_EXCEEDS_CONTRACT', message: `Planned billing ${round4(priorPlanned + newTotal)} exceeds contract price ${n(c.totalPrice)}`, messageTh: 'ยอดวางบิลตามแผนเกินมูลค่าสัญญา' });

    for (const m of dto.milestones) {
      await db.insert(revBillingSchedules).values({
        tenantId: c.tenantId, contractId, period: m.period, plannedAmount: fx(n(m.amount), 4),
        billedAmount: '0', status: 'Planned', createdBy: user.username,
      });
    }
    return this.getSchedule(contractId);
  }

  // ── POST :id/bill — CHECKER raises an invoice for a scheduled milestone. Reclasses the earned contract
  //    asset (1265 → 1100 AR) and parks any billing-in-excess as a contract liability (2410). SoD: the biller
  //    must differ from the milestone's maker (created_by), else SOD_SELF_BILLING.
  async bill(contractId: number, dto: BillDto, user: JwtUser) {
    const db = this.db;
    const c = await this.assertContract(contractId);
    const [row] = await db.select().from(revBillingSchedules).where(and(eq(revBillingSchedules.id, Number(dto.billing_schedule_id)), eq(revBillingSchedules.contractId, contractId))).limit(1);
    if (!row) throw new NotFoundException({ code: 'MILESTONE_NOT_FOUND', message: `Billing milestone ${dto.billing_schedule_id} not found for contract ${contractId}`, messageTh: 'ไม่พบงวดวางบิล' });
    if (row.status === 'Billed') throw new BadRequestException({ code: 'ALREADY_BILLED', message: 'Milestone already billed', messageTh: 'งวดนี้วางบิลแล้ว' });
    // Maker-checker (REV-24): the invoicer cannot be the person who defined the milestone.
    if (row.createdBy && row.createdBy === user.username)
      throw new ForbiddenException({ code: 'SOD_SELF_BILLING', message: 'The user who defined a billing milestone may not bill it (segregation of duties)', messageTh: 'ผู้กำหนดงวดวางบิลไม่สามารถวางบิลเองได้ (แบ่งแยกหน้าที่)' });

    const billAmount = round4(n(row.plannedAmount));
    const billedBefore = round4(n(c.billedAmount));
    const newBilled = round4(billedBefore + billAmount);
    // Cumulative billing may never exceed the contract price (over-billing the customer).
    if (newBilled > round4(n(c.totalPrice)) + 0.01)
      throw new BadRequestException({ code: 'BILL_EXCEEDS_CONTRACT', message: `Billing ${billAmount} would exceed the contract ${n(c.totalPrice)} (already billed ${billedBefore})`, messageTh: 'วางบิลเกินมูลค่าสัญญา' });

    // Reclass: clear the earned-but-unbilled contract asset first; the remainder is billed in excess (2410).
    const recognizedToDate = await this.sumRecognized(contractId);
    const contractAsset = round4(Math.max(0, recognizedToDate - billedBefore));
    const clearAsset = round4(Math.min(billAmount, contractAsset));
    const toLiability = round4(billAmount - clearAsset);

    const invoiceRef = dto.invoice_ref ?? `REVBILL-${c.contractNo}-${row.period}`;
    const ref = `${c.contractNo}:${Number(row.id)}`;
    let entryNo: string | null = null;
    if (this.ledger && !(await this.ledger.alreadyPosted('REVBILL', ref, c.tenantId))) {
      const lines: any[] = [{ account_code: AR, debit: billAmount, memo: `AR — invoice ${invoiceRef}` }];
      if (clearAsset > 0) lines.push({ account_code: CONTRACT_ASSET, credit: clearAsset, memo: 'Reclass contract asset billed' });
      if (toLiability > 0) lines.push({ account_code: CONTRACT_LIABILITY, credit: toLiability, memo: 'Billings in excess (contract liability)' });
      const je: any = await this.ledger.postEntry({
        date: dto.date ?? ymd(), source: 'REVBILL', sourceRef: ref, tenantId: c.tenantId, currency: c.currency ?? undefined,
        memo: `TFRS15 contract billing ${c.contractNo} ${row.period}`, createdBy: user.username, viaSubledger: true, lines,
      });
      entryNo = je?.entry_no ?? null;
    }
    await db.update(revBillingSchedules).set({ status: 'Billed', billedAmount: fx(billAmount, 4), invoiceRef, billedBy: user.username, billedAt: new Date() }).where(eq(revBillingSchedules.id, Number(row.id)));
    await db.update(revContracts).set({ billedAmount: fx(newBilled, 4) }).where(eq(revContracts.id, contractId));
    return {
      contract_id: contractId, contract_no: c.contractNo, billing_schedule_id: Number(row.id), period: row.period,
      billed: billAmount, invoice_ref: invoiceRef, contract_asset_cleared: clearAsset, billings_in_excess: toLiability,
      billed_to_date: newBilled, entry_no: entryNo,
    };
  }

  // ── GET :id/position — cumulative recognized vs billed with the derived contract-asset / contract-liability
  //    balance (the detective tie-out: contract_asset = max(0, recognized − billed)). TFRS 15 §105-107.
  async position(contractId: number) {
    const c = await this.assertContract(contractId);
    const recognized = await this.sumRecognized(contractId);
    const billed = round4(n(c.billedAmount));
    const contractAsset = round4(Math.max(0, recognized - billed));
    const contractLiability = round4(Math.max(0, billed - recognized));
    return {
      contract_id: contractId, contract_no: c.contractNo, currency: c.currency, total_price: round4(n(c.totalPrice)),
      recognized_revenue: recognized, billed_to_date: billed,
      contract_asset: contractAsset,        // 1265 unbilled receivable
      contract_liability: contractLiability, // 2410 deferred revenue
      schedule: await this.getScheduleRows(contractId),
    };
  }

  private async getScheduleRows(contractId: number) {
    const rows = await this.db.select().from(revBillingSchedules).where(eq(revBillingSchedules.contractId, contractId)).orderBy(revBillingSchedules.period, revBillingSchedules.id);
    return rows.map((r: any) => ({ id: Number(r.id), period: r.period, planned_amount: n(r.plannedAmount), billed_amount: n(r.billedAmount), invoice_ref: r.invoiceRef, status: r.status, created_by: r.createdBy, billed_by: r.billedBy }));
  }

  async getSchedule(contractId: number) {
    const c = await this.assertContract(contractId);
    return { contract_id: contractId, contract_no: c.contractNo, total_price: round4(n(c.totalPrice)), billing_schedule: await this.getScheduleRows(contractId) };
  }
}
