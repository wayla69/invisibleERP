import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, lte } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { revContracts, performanceObligations, revrecSchedules, refundLiability } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { DocNumberService } from '../../common/doc-number.service';
import { n, fx, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// ── WS3.4 — TFRS 15 / IFRS 15 revenue recognition (REV-19) ──────────────────────────────────────────
// Five-step model for service/subscription/project contracts (the POS keeps its immediate recognition):
//   1 contract → 2 performance obligations → 3 transaction price → 4 allocate by SSP → 5 recognize as satisfied.
// Deferred revenue (2410) is raised on activation/invoice (Dr 1100 AR / Cr 2410) and released to revenue
// (4300) as POs are satisfied (Dr 2410 / Cr 4300). A refund liability (2420) provides for expected returns.
// All posting routes through LedgerService.postEntry so PERIOD_LOCKED (WS2.1) + GL-17 audit (WS2.2) apply.

const DEFERRED_REVENUE = '2410';   // Contract Liability / Deferred Revenue
const CONTRACT_ASSET = '1265';     // Contract Asset (Unbilled Receivable) — recognized ahead of billing (REV-24)
const REVENUE = '4300';            // Subscription & Service Revenue (recognized)
const AR = '1100';                 // Accounts Receivable (control — posted viaSubledger)
const REFUND_LIAB = '2420';        // Refund Liability

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;
function addMonths(period: string, k: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + k;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}
// inclusive month count between two 'YYYY-MM' periods
function monthsBetween(startPeriod: string, endPeriod: string): number {
  const [ys, ms] = startPeriod.split('-').map(Number) as [number, number];
  const [ye, me] = endPeriod.split('-').map(Number) as [number, number];
  return (ye * 12 + (me - 1)) - (ys * 12 + (ms - 1)) + 1;
}
function splitStraightLine(total: number, months: number): number[] {
  const per = Math.floor((total / months) * 10000) / 10000;
  const arr = Array(months).fill(per);
  arr[months - 1] = round4(total - per * (months - 1));
  return arr;
}

export interface PoDto { name: string; ssp: number; method?: 'point_in_time' | 'over_time'; start_date?: string; end_date?: string }
export interface CreateContractDto { contract_no?: string; customer_id?: number | null; contract_date?: string; currency?: string; total_price: number; description?: string; obligations: PoDto[] }

@Injectable()
export class RevRecService {
  // @Optional ledger so a standalone harness can construct the service without the GL graph.
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly ledger?: LedgerService,
    @Optional() private readonly docNo?: DocNumberService,
  ) {}

  private tid(user: JwtUser, explicit?: number | null): number {
    const t = explicit ?? user.tenantId ?? null;
    if (t == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'HQ/Admin must specify a tenant', messageTh: 'สำนักงานใหญ่ต้องระบุ tenant' });
    return Number(t);
  }

  // Step 1+2 — create the contract with its performance obligations.
  async createContract(dto: CreateContractDto, user: JwtUser) {
    const db = this.db;
    const tenantId = this.tid(user);
    const total = n(dto.total_price);
    if (!(total > 0)) throw new BadRequestException({ code: 'INVALID_ALLOCATION', message: 'total_price must be > 0', messageTh: 'ราคารวมตามสัญญาต้องมากกว่า 0' });
    if (!dto.obligations?.length) throw new BadRequestException({ code: 'INVALID_ALLOCATION', message: 'at least one performance obligation is required', messageTh: 'ต้องมีภาระที่ต้องปฏิบัติอย่างน้อยหนึ่งรายการ' });
    const contractNo = dto.contract_no ?? (this.docNo ? await this.docNo.nextDaily('REVC') : `REVC-${Date.now()}`);
    const contractDate = dto.contract_date ?? ymd();
    const currency = dto.currency ?? 'THB';

    const [c] = await db.insert(revContracts).values({
      tenantId, customerId: dto.customer_id ?? null, contractNo, contractDate, currency,
      totalPrice: fx(total, 4), status: 'Draft', description: dto.description ?? null, createdBy: user.username,
    }).returning();

    for (const po of dto.obligations) {
      const method = po.method ?? 'point_in_time';
      if (method === 'over_time' && (!po.start_date || !po.end_date)) {
        throw new BadRequestException({ code: 'INVALID_ALLOCATION', message: `over_time obligation '${po.name}' needs start_date and end_date`, messageTh: 'ภาระแบบรับรู้ตลอดช่วงต้องมีวันเริ่มและวันสิ้นสุด' });
      }
      await db.insert(performanceObligations).values({
        tenantId, contractId: Number(c!.id), name: po.name, ssp: fx(n(po.ssp), 4),
        allocatedPrice: '0', method, startDate: po.start_date ?? contractDate, endDate: po.end_date ?? null,
        satisfiedPct: '0', status: 'Pending',
      });
    }
    return this.getContract(Number(c!.id));
  }

  // Step 4 — allocate the transaction price across POs in proportion to SSP. The residual (from rounding)
  // lands on the largest-SSP PO so Σ allocated == total_price EXACTLY.
  async allocateBySSP(contractId: number) {
    const db = this.db;
    const c = await this.assertContract(contractId);
    const pos = await db.select().from(performanceObligations).where(eq(performanceObligations.contractId, contractId)).orderBy(performanceObligations.id);
    const total = n(c.totalPrice);
    const sumSsp = round4(pos.reduce((a: number, p: any) => a + n(p.ssp), 0));
    if (!(sumSsp > 0)) throw new BadRequestException({ code: 'INVALID_ALLOCATION', message: 'Σssp must be > 0', messageTh: 'ผลรวมราคาขายเดี่ยวต้องมากกว่า 0' });

    const alloc = pos.map((p: any) => round4(total * n(p.ssp) / sumSsp));
    let allocated = round4(alloc.reduce((a: number, x: number) => a + x, 0));
    const residual = round4(total - allocated);
    if (Math.abs(residual) >= 0.00005) {
      // put the residual on the largest-SSP PO
      let maxI = 0;
      for (let i = 1; i < pos.length; i++) if (n(pos[i]!.ssp) > n(pos[maxI]!.ssp)) maxI = i;
      alloc[maxI] = round4(alloc[maxI]! + residual);
    }
    for (let i = 0; i < pos.length; i++) {
      await db.update(performanceObligations).set({ allocatedPrice: fx(alloc[i], 4) }).where(eq(performanceObligations.id, Number(pos[i]!.id)));
    }
    return { contract_id: contractId, total_price: total, sum_ssp: sumSsp, allocation: pos.map((p: any, i: number) => ({ obligation_id: Number(p.id), name: p.name, ssp: n(p.ssp), allocated_price: alloc[i] })), sum_allocated: round4(alloc.reduce((a: number, x: number) => a + x, 0)) };
  }

  // Activation — set the contract Active. `bill_upfront` (default TRUE, REV-19 back-compat) raises the whole
  // contract price as a contract liability on day one: Dr 1100 AR / Cr 2410 Deferred Revenue. Set it FALSE
  // (REV-24, TFRS 15 §105-107) to DECOUPLE billing from recognition — nothing is billed here, so recognition
  // then runs ahead of billing and builds a contract ASSET (1265); invoices are raised on their own schedule
  // via /billing-schedule + /bill (RevBillingService). `billed_amount` on the contract tracks cumulative
  // billing and drives the asset/liability split.
  async activate(contractId: number, dto: { date?: string; bill_upfront?: boolean }, user: JwtUser) {
    const db = this.db;
    const c = await this.assertContract(contractId);
    if (c.status === 'Active' || c.status === 'Completed') throw new BadRequestException({ code: 'ALREADY_ACTIVE', message: 'Contract already active', messageTh: 'สัญญาเปิดใช้งานแล้ว' });
    const total = n(c.totalPrice);
    const billUpfront = dto.bill_upfront !== false; // default = today's behaviour
    let entryNo: string | null = null;
    if (billUpfront) {
      const ref = `REVREC-INV:${c.contractNo}`;
      if (this.ledger && !(await this.ledger.alreadyPosted('REVREC-INV', ref, c.tenantId))) {
        const je: any = await this.ledger.postEntry({
          date: dto.date ?? c.contractDate ?? undefined, source: 'REVREC-INV', sourceRef: ref, tenantId: c.tenantId, currency: c.currency ?? undefined,
          memo: `TFRS15 contract activation ${c.contractNo}`, createdBy: user.username, viaSubledger: true,
          lines: [{ account_code: AR, debit: total, memo: 'AR — contract' }, { account_code: DEFERRED_REVENUE, credit: total, memo: 'Deferred revenue' }],
        });
        entryNo = je?.entry_no ?? null;
      }
    }
    await db.update(revContracts).set({ status: 'Active', billedAmount: fx(billUpfront ? total : 0, 4) }).where(eq(revContracts.id, contractId));
    return { contract_id: contractId, status: 'Active', bill_upfront: billUpfront, billed: billUpfront ? total : 0, deferred_revenue: billUpfront ? total : 0, entry_no: entryNo };
  }

  // Σ recognized revenue for a contract (used for the contract-asset / contract-liability split, REV-24).
  async sumRecognized(contractId: number): Promise<number> {
    const rows = await this.db.select().from(revrecSchedules).where(eq(revrecSchedules.contractId, contractId));
    return round4(rows.filter((r: any) => r.recognized).reduce((a: number, r: any) => a + n(r.recognizedAmount), 0));
  }

  // Step 5 prep — build the recognition (amortization) schedule. over_time POs straight-line their
  // allocated_price across the months start..end; point_in_time POs get a single row at the satisfaction
  // date. Idempotent: rebuilds only UNRECOGNIZED rows (recognized rows are never touched).
  async buildSchedule(contractId: number) {
    const db = this.db;
    const c = await this.assertContract(contractId);
    const pos = await db.select().from(performanceObligations).where(eq(performanceObligations.contractId, contractId)).orderBy(performanceObligations.id);
    for (const p of pos) {
      // drop existing unrecognized rows for this PO, then rebuild
      const existing = await db.select().from(revrecSchedules).where(eq(revrecSchedules.obligationId, Number(p.id)));
      for (const row of existing) if (!row.recognized) await db.delete(revrecSchedules).where(eq(revrecSchedules.id, Number(row.id)));
      const recognizedPeriods = new Set(existing.filter((r: any) => r.recognized).map((r: any) => r.period));
      const allocated = n(p.allocatedPrice);

      if (p.method === 'over_time') {
        const startP = String(p.startDate ?? c.contractDate).slice(0, 7);
        const endP = String(p.endDate ?? p.startDate ?? c.contractDate).slice(0, 7);
        const months = Math.max(1, monthsBetween(startP, endP));
        const amts = splitStraightLine(allocated, months);
        for (let i = 0; i < months; i++) {
          const period = addMonths(startP, i);
          if (recognizedPeriods.has(period)) continue;
          await db.insert(revrecSchedules).values({ tenantId: c.tenantId, contractId, obligationId: Number(p.id), period, plannedAmount: fx(amts[i], 4), recognizedAmount: '0', recognized: false });
        }
      } else {
        const period = String(p.startDate ?? c.contractDate).slice(0, 7);
        if (!recognizedPeriods.has(period)) {
          await db.insert(revrecSchedules).values({ tenantId: c.tenantId, contractId, obligationId: Number(p.id), period, plannedAmount: fx(allocated, 4), recognizedAmount: '0', recognized: false });
        }
      }
    }
    return this.getContract(contractId);
  }

  // Step 5 — recognize all unrecognized schedule rows due in/through the period: Dr 2410 / Cr 4300.
  // Scoped to one tenant (or one contract). Idempotent — an already-recognized row is skipped.
  async recognize(dto: { contractId?: number; period: string }, user: JwtUser, explicitTenantId?: number | null) {
    const db = this.db;
    if (!/^\d{4}-\d{2}$/.test(dto.period)) throw new BadRequestException({ code: 'INVALID', message: 'period must be YYYY-MM', messageTh: 'งวดต้องเป็น YYYY-MM' });
    const tenantId = this.tid(user, explicitTenantId);
    const conds = [eq(revrecSchedules.tenantId, tenantId), eq(revrecSchedules.recognized, false), lte(revrecSchedules.period, dto.period)];
    if (dto.contractId != null) conds.push(eq(revrecSchedules.contractId, dto.contractId));
    const rows = await db.select().from(revrecSchedules).where(and(...conds)).orderBy(revrecSchedules.period, revrecSchedules.id);

    const journals: any[] = []; const skipped: any[] = []; let total = 0;
    for (const row of rows) {
      const amount = n(row.plannedAmount);
      const c = await this.assertContract(Number(row.contractId));
      const ref = `REVREC:${c.contractNo}:${row.obligationId}:${row.period}`;
      try {
        // TFRS 15 §105-107 contract-asset / contract-liability split (REV-24): recognizing revenue first
        // RELEASES any contract liability already billed in advance (Dr 2410), and the surplus recognized
        // AHEAD of billing builds a contract ASSET / unbilled receivable (Dr 1265). For a contract billed
        // up-front (REV-19 default, billed_amount == total_price) the liability always covers the amount, so
        // this reduces to today's Dr 2410 / Cr 4300 — back-compat preserved.
        const recognizedToDate = await this.sumRecognized(Number(row.contractId));
        const availableLiability = round4(Math.max(0, n(c.billedAmount) - recognizedToDate));
        const fromLiability = round4(Math.min(amount, availableLiability));
        const toAsset = round4(amount - fromLiability);
        let entryNo: string | null = null;
        if (this.ledger && !(await this.ledger.alreadyPosted('REVREC', ref, c.tenantId))) {
          const lines: any[] = [];
          if (fromLiability > 0) lines.push({ account_code: DEFERRED_REVENUE, debit: fromLiability, memo: 'Release contract liability (billed in advance)' });
          if (toAsset > 0) lines.push({ account_code: CONTRACT_ASSET, debit: toAsset, memo: 'Contract asset (unbilled receivable)' });
          lines.push({ account_code: REVENUE, credit: amount, memo: 'Recognized revenue' });
          const je: any = await this.ledger.postEntry({
            date: `${row.period}-01`, source: 'REVREC', sourceRef: ref, tenantId: c.tenantId, currency: c.currency ?? undefined,
            memo: `TFRS15 revenue recognition ${c.contractNo} ${row.period}`, createdBy: user.username,
            lines,
          });
          entryNo = je?.entry_no ?? null;
        }
        await db.update(revrecSchedules).set({ recognized: true, recognizedAmount: fx(amount, 4), recognizedEntryId: null }).where(eq(revrecSchedules.id, Number(row.id)));
        journals.push({ contract_no: c.contractNo, obligation_id: Number(row.obligationId), period: row.period, amount, entry_no: entryNo });
        total = round4(total + amount);
        await this.refreshObligation(Number(row.obligationId));
        await this.refreshContract(Number(row.contractId));
      } catch (e: any) {
        skipped.push({ schedule_id: Number(row.id), reason: e?.response?.code ?? e?.code ?? 'ERROR' });
      }
    }
    if (!rows.length) {
      // Distinguish "nothing due" from a genuine all-recognized state is informational only — callers
      // treat recognized_count 0 as idempotent (ALREADY_RECOGNIZED-equivalent: no new postings).
    }
    return { period: dto.period, recognized_count: journals.length, total_recognized: total, journals, skipped };
  }

  // Recompute a PO's satisfied_pct + status from its schedule rows.
  private async refreshObligation(obligationId: number) {
    const db = this.db;
    const [po] = await db.select().from(performanceObligations).where(eq(performanceObligations.id, obligationId)).limit(1);
    if (!po) return;
    const rows = await db.select().from(revrecSchedules).where(eq(revrecSchedules.obligationId, obligationId));
    const recognized = round4(rows.filter((r: any) => r.recognized).reduce((a: number, r: any) => a + n(r.recognizedAmount), 0));
    const allocated = n(po.allocatedPrice);
    const pct = allocated > 0 ? round4((recognized / allocated) * 100) : 0;
    const status = pct >= 99.999 ? 'Satisfied' : (pct > 0 ? 'InProgress' : 'Pending');
    await db.update(performanceObligations).set({ satisfiedPct: fx(Math.min(pct, 100), 4), status }).where(eq(performanceObligations.id, obligationId));
  }

  private async refreshContract(contractId: number) {
    const db = this.db;
    const pos = await db.select().from(performanceObligations).where(eq(performanceObligations.contractId, contractId));
    if (pos.length && pos.every((p: any) => p.status === 'Satisfied')) {
      await db.update(revContracts).set({ status: 'Completed' }).where(and(eq(revContracts.id, contractId), eq(revContracts.status, 'Active')));
    }
  }

  // Refund liability — provide for expected returns: expected = recognized-or-allocated × rate. Posts the
  // DELTA vs the prior posted provision: Dr 4300 (contra revenue) / Cr 2420 (increase), reversed if it falls.
  async accrueRefundLiability(dto: { contractId: number; expectedRefundRate: number; asOfDate?: string; postedBy?: string }, user: JwtUser) {
    const db = this.db;
    const c = await this.assertContract(dto.contractId);
    const rate = n(dto.expectedRefundRate);
    const asOf = dto.asOfDate ?? ymd();
    // base = recognized revenue if any, else the allocated price of the contract
    const scheds = await db.select().from(revrecSchedules).where(eq(revrecSchedules.contractId, dto.contractId));
    const recognized = round4(scheds.filter((r: any) => r.recognized).reduce((a: number, r: any) => a + n(r.recognizedAmount), 0));
    const base = recognized > 0 ? recognized : n(c.totalPrice);
    const expected = round4(base * rate);

    // prior posted provision for this contract (carrying balance of 2420)
    const priorRows = await db.select().from(refundLiability).where(and(eq(refundLiability.contractId, dto.contractId), eq(refundLiability.posted, true)));
    const prior = round4(priorRows.reduce((a: number, r: any) => a + n(r.postedAmount ?? 0), 0));
    const delta = round4(expected - prior);

    let entryNo: string | null = null;
    if (this.ledger && Math.abs(delta) >= 0.0001) {
      const ref = `REVREC-REF:${c.contractNo}:${asOf}`;
      if (!(await this.ledger.alreadyPosted('REVREC-REF', ref, c.tenantId))) {
        const lines = delta > 0
          ? [{ account_code: REVENUE, debit: delta, memo: 'Refund provision (contra revenue)' }, { account_code: REFUND_LIAB, credit: delta, memo: 'Refund liability' }]
          : [{ account_code: REFUND_LIAB, debit: -delta, memo: 'Reverse refund liability' }, { account_code: REVENUE, credit: -delta, memo: 'Restore revenue' }];
        const je: any = await this.ledger.postEntry({ date: asOf, source: 'REVREC-REF', sourceRef: ref, tenantId: c.tenantId, currency: c.currency ?? undefined, memo: `TFRS15 refund liability ${c.contractNo}`, createdBy: user.username, lines });
        entryNo = je?.entry_no ?? null;
      }
    }
    await db.insert(refundLiability).values({ tenantId: c.tenantId, contractId: dto.contractId, asOfDate: asOf, expectedRefundRate: fx(rate, 4), expectedRefundAmount: fx(expected, 4), posted: true, postedAmount: fx(delta, 4), createdBy: user.username });
    return { contract_id: dto.contractId, as_of_date: asOf, base, rate, expected_refund_amount: expected, prior_provision: prior, posted_delta: delta, entry_no: entryNo };
  }

  async getContract(id: number) {
    const db = this.db;
    const c = await this.assertContract(id);
    const pos = await db.select().from(performanceObligations).where(eq(performanceObligations.contractId, id)).orderBy(performanceObligations.id);
    const sched = await db.select().from(revrecSchedules).where(eq(revrecSchedules.contractId, id)).orderBy(revrecSchedules.period, revrecSchedules.id);
    return {
      id: Number(c.id), contract_no: c.contractNo, customer_id: c.customerId != null ? Number(c.customerId) : null,
      contract_date: c.contractDate, currency: c.currency, total_price: n(c.totalPrice), status: c.status, description: c.description,
      obligations: pos.map((p: any) => ({ id: Number(p.id), name: p.name, ssp: n(p.ssp), allocated_price: n(p.allocatedPrice), method: p.method, start_date: p.startDate, end_date: p.endDate, satisfied_pct: n(p.satisfiedPct), status: p.status })),
      schedule: sched.map((r: any) => ({ id: Number(r.id), obligation_id: Number(r.obligationId), period: r.period, planned_amount: n(r.plannedAmount), recognized_amount: n(r.recognizedAmount), recognized: r.recognized })),
    };
  }

  async listContracts(user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(revContracts).where(user.tenantId != null ? eq(revContracts.tenantId, user.tenantId) : undefined).orderBy(revContracts.id);
    return { contracts: rows.map((c: any) => ({ id: Number(c.id), contract_no: c.contractNo, contract_date: c.contractDate, total_price: n(c.totalPrice), status: c.status, currency: c.currency })), count: rows.length };
  }

  private async assertContract(id: number) {
    const db = this.db;
    const [c] = await db.select().from(revContracts).where(eq(revContracts.id, id)).limit(1);
    if (!c) throw new NotFoundException({ code: 'CONTRACT_NOT_FOUND', message: `Contract ${id} not found`, messageTh: `ไม่พบสัญญา ${id}` });
    return c;
  }
}
