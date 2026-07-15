import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { revContracts, performanceObligations, revrecSchedules, revContractModifications } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { RevRecService } from '../revenue/revrec.service';
import { n, fx, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';

// ── Track D — Wave 3 (REV-26): contract modifications (TFRS 15 / IFRS 15 / ASC 606 §18-21) ──────────────────
// A change to a contract (added/changed goods or services, or a price change) must be CLASSIFIED and accounted
// for as exactly one of three, and the CLASSIFICATION IS THE CONTROL:
//   • separate_contract (§20)   — added goods are DISTINCT AND priced at their standalone selling price (SSP)
//        ⇒ account as a NEW independent contract; the original is untouched (no re-allocation, no catch-up).
//   • prospective (§21a)        — distinct but NOT at SSP ⇒ terminate old + create new: RE-ALLOCATE the
//        remaining (unrecognized) transaction price over the remaining POs; NO catch-up on satisfied revenue.
//   • cumulative_catchup (§21b) — NOT distinct (part of a single performance obligation) ⇒ adjust revenue at
//        the modification date via a CATCH-UP JE on the already-recognized portion.
// A wrong "separate_contract" call HIDES a required catch-up, so the modification is a maker-checker artifact:
// the maker records + classifies (Pending, drives NOTHING), a DIFFERENT user approves it (→ SOD_SELF_APPROVAL),
// and only an APPROVED modification drives revenue (approval applies the effect). The price recompute /
// re-allocation / unrecognized-schedule rebuild / cumulative catch-up REUSE the REV-19 engine (RevRecService:
// createContract / allocateBySSP / buildSchedule / sumRecognized) — this module extends the contract, it does
// not rebuild the engine. The catch-up posts against 2410/1265 ↔ 4300 with the SAME asset-aware split as
// recognize() (idempotent via LedgerService.postEntry). No new COA.

const DEFERRED_REVENUE = '2410';   // Contract Liability / Deferred Revenue
const CONTRACT_ASSET = '1265';     // Contract Asset (Unbilled Receivable)
const REVENUE = '4300';            // Subscription & Service Revenue (recognized)

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;
function addMonths(period: string, k: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + k;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}
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

export type ModType = 'separate_contract' | 'prospective' | 'cumulative_catchup';
export interface ModPoDto { name: string; ssp: number; method?: 'point_in_time' | 'over_time'; start_date?: string; end_date?: string }
export interface ModifyDto {
  added_price: number;                 // incremental consideration promised by the modification
  distinct_flag: boolean;              // are the added goods DISTINCT (§27)? — management judgement
  at_ssp_flag: boolean;                // are they priced at their standalone selling price (§20)? — judgement
  obligations?: ModPoDto[];            // the added / changed performance obligations
  as_of?: string;                      // modification date (YYYY-MM-DD)
  note?: string;
}

@Injectable()
export class RevModificationService {
  // @Optional ledger so a standalone harness can construct the service without the GL graph; RevRecService is
  // exported by RevenueModule (the REV-19 engine) and REUSED for create/allocate/schedule/sumRecognized.
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly revrec: RevRecService,
    @Optional() private readonly ledger?: LedgerService,
  ) {}

  private async assertContract(id: number) {
    const [c] = await this.db.select().from(revContracts).where(eq(revContracts.id, id)).limit(1);
    if (!c) throw new NotFoundException({ code: 'CONTRACT_NOT_FOUND', message: `Contract ${id} not found`, messageTh: `ไม่พบสัญญา ${id}` });
    return c;
  }

  // TFRS 15 §18-21 classification — the judgement that IS the control. distinct_flag/at_ssp_flag are the
  // maker's management assertions; the checker reviews the resulting classification on approval.
  private classify(distinct: boolean, atSsp: boolean): ModType {
    if (distinct && atSsp) return 'separate_contract';   // §20
    if (distinct && !atSsp) return 'prospective';        // §21a
    return 'cumulative_catchup';                          // §21b (not distinct)
  }

  private validateObligations(obligations: ModPoDto[] | undefined, required: boolean) {
    if (!obligations?.length) {
      if (required) throw new BadRequestException({ code: 'NO_OBLIGATIONS', message: 'the modification must add at least one performance obligation', messageTh: 'การแก้ไขสัญญาต้องมีภาระที่ต้องปฏิบัติอย่างน้อยหนึ่งรายการ' });
      return;
    }
    for (const po of obligations) {
      if (!po.name) throw new BadRequestException({ code: 'INVALID_OBLIGATION', message: 'each added obligation needs a name', messageTh: 'ภาระที่เพิ่มต้องมีชื่อ' });
      if (!(n(po.ssp) >= 0)) throw new BadRequestException({ code: 'INVALID_OBLIGATION', message: 'ssp must be ≥ 0', messageTh: 'ราคาขายเดี่ยวต้องไม่ติดลบ' });
      const method = po.method ?? 'point_in_time';
      if (method === 'over_time' && (!po.start_date || !po.end_date))
        throw new BadRequestException({ code: 'INVALID_OBLIGATION', message: `over_time obligation '${po.name}' needs start_date and end_date`, messageTh: 'ภาระแบบรับรู้ตลอดช่วงต้องมีวันเริ่มและวันสิ้นสุด' });
    }
  }

  // ── POST :id/modify — MAKER records + classifies a modification. It lands Pending and drives NOTHING (no
  //    contract/schedule/GL change) until a DIFFERENT user approves it. Returns the §18-21 classification and a
  //    PREVIEW of the effect so the reviewer can judge it. added_price = the incremental consideration.
  async modify(contractId: number, dto: ModifyDto, user: JwtUser) {
    const db = this.db;
    const c = await this.assertContract(contractId);
    const asOf = dto.as_of ?? ymd();
    const added = round4(n(dto.added_price));
    const type = this.classify(!!dto.distinct_flag, !!dto.at_ssp_flag);

    // separate_contract + prospective add DISTINCT goods, so they require obligations. A cumulative catch-up
    // (not distinct) is a change to the existing single PO — obligations are optional (a pure price change).
    this.validateObligations(dto.obligations, type !== 'cumulative_catchup');
    if ((type === 'separate_contract' || type === 'prospective') && !(added > 0))
      throw new BadRequestException({ code: 'INVALID_ADDED_PRICE', message: 'added_price must be > 0 for a distinct-goods modification', messageTh: 'ราคาที่เพิ่มต้องมากกว่า 0 สำหรับสินค้าที่แยกได้' });

    // Preview effect (NOT posted): what the modification will do once approved.
    const recognizedToDate = await this.revrec.sumRecognized(contractId);
    const oldTotal = round4(n(c.totalPrice));
    let previewEffect = 0;
    if (type === 'separate_contract') previewEffect = added;                                   // new contract value
    else if (type === 'prospective') previewEffect = round4((oldTotal - recognizedToDate) + added); // re-allocated remaining
    else previewEffect = oldTotal > 0 ? round4(recognizedToDate * ((round4(oldTotal + added) / oldTotal) - 1)) : 0; // catch-up Δ

    const [row] = await db.insert(revContractModifications).values({
      tenantId: c.tenantId, contractId, asOf, type,
      addedPrice: fx(added, 4), distinctFlag: !!dto.distinct_flag, atSspFlag: !!dto.at_ssp_flag,
      effectAmount: fx(previewEffect, 4), addedPos: JSON.stringify(dto.obligations ?? []),
      status: 'Pending', note: dto.note ?? null, createdBy: user.username,
    }).returning();

    return {
      id: Number(row!.id), contract_id: contractId, contract_no: c.contractNo, as_of: asOf,
      type, distinct_flag: !!dto.distinct_flag, at_ssp_flag: !!dto.at_ssp_flag, added_price: added,
      classification_basis: type === 'separate_contract' ? 'TFRS 15 §20 — distinct & at SSP → new independent contract'
        : type === 'prospective' ? 'TFRS 15 §21(a) — distinct but not at SSP → re-allocate remaining, no catch-up'
        : 'TFRS 15 §21(b) — not distinct → cumulative catch-up',
      preview_effect: previewEffect, status: 'Pending', created_by: user.username,
    };
  }

  // ── POST :id/modifications/:modId/approve — CHECKER (≠ the maker, else SOD_SELF_APPROVAL) approves the
  //    modification, which APPLIES the §18-21 effect (the classification only drives revenue once reviewed).
  async approve(contractId: number, modId: number, user: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const c = await this.assertContract(contractId);
    const [m] = await db.select().from(revContractModifications).where(and(eq(revContractModifications.id, modId), eq(revContractModifications.contractId, contractId))).limit(1);
    if (!m) throw new NotFoundException({ code: 'MODIFICATION_NOT_FOUND', message: `Contract modification ${modId} not found for contract ${contractId}`, messageTh: 'ไม่พบการแก้ไขสัญญา' });
    if (m.status !== 'Pending') throw new BadRequestException({ code: 'MODIFICATION_NOT_PENDING', message: `Modification ${modId} is ${m.status}, not Pending`, messageTh: 'การแก้ไขสัญญาไม่ได้อยู่ในสถานะรอการอนุมัติ' });
    // Maker-checker (SoD): the person who classified the modification cannot approve their own judgement.
    await assertMakerChecker(db, { user, maker: m.createdBy, event: 'rev.modification.approve', ref: `${contractId}:${modId}`, amount: n(m.addedPrice), reason: selfApprovalReason, code: 'SOD_SELF_APPROVAL', message: 'The user who recorded a contract modification cannot approve it (segregation of duties)', messageTh: 'ผู้บันทึกการแก้ไขสัญญาไม่สามารถอนุมัติเองได้ (แบ่งแยกหน้าที่)' });

    const type = m.type as ModType;
    let result: any;
    if (type === 'separate_contract') result = await this.applySeparate(c, m, user);
    else if (type === 'prospective') result = await this.applyProspective(c, m, user);
    else result = await this.applyCumulative(c, m, user);

    await db.update(revContractModifications).set({
      status: 'Applied', approvedBy: user.username, appliedAt: new Date(),
      effectAmount: fx(result.effect, 4), newContractId: result.new_contract_id ?? null,
    }).where(eq(revContractModifications.id, modId));

    return { id: modId, contract_id: contractId, type, status: 'Applied', approved_by: user.username, ...result };
  }

  // §20 — DISTINCT & at SSP: account as a NEW independent contract. The original is UNTOUCHED. Reuses the
  // REV-19 engine (createContract → allocateBySSP → buildSchedule); recognition then runs on the new contract
  // via the ordinary /recognize path. No GL is posted here (creating a contract raises no entry on its own).
  private async applySeparate(c: any, m: any, user: JwtUser) {
    const pos: ModPoDto[] = JSON.parse(m.addedPos || '[]');
    const newContractNo = `${c.contractNo}-M${Number(m.id)}`;
    const created = await this.revrec.createContract({
      contract_no: newContractNo, customer_id: c.customerId != null ? Number(c.customerId) : null,
      contract_date: m.asOf, currency: c.currency ?? undefined, total_price: n(m.addedPrice),
      description: `Separate contract (TFRS 15 §20) from ${c.contractNo}`,
      obligations: pos.map((p) => ({ name: p.name, ssp: n(p.ssp), method: p.method, start_date: p.start_date, end_date: p.end_date })),
    }, user);
    const newId = Number(created.id);
    await this.revrec.allocateBySSP(newId);
    await this.revrec.buildSchedule(newId);
    return { effect: round4(n(m.addedPrice)), new_contract_id: newId, new_contract_no: newContractNo, new_total_price: round4(n(m.addedPrice)), catch_up_delta: 0, entry_no: null, original_untouched: true };
  }

  // §21(a) — DISTINCT but NOT at SSP: termination + new. Add the distinct POs, then RE-ALLOCATE the remaining
  // consideration = (unrecognized old price) + added_price over the REMAINING POs (unsatisfied portions + new),
  // in proportion to their SSP. Already-recognized revenue is FROZEN — NO catch-up JE. The unrecognized
  // schedule is rebuilt over the remaining periods so future recognition runs at the re-allocated price.
  private async applyProspective(c: any, m: any, user: JwtUser) {
    const db = this.db;
    const contractId = Number(c.id);
    const recognizedToDate = await this.revrec.sumRecognized(contractId);
    const addedPos: ModPoDto[] = JSON.parse(m.addedPos || '[]');
    // Insert the added distinct POs (allocated 0 for now — re-allocation sets it below).
    for (const po of addedPos) {
      const method = po.method ?? 'point_in_time';
      await db.insert(performanceObligations).values({
        tenantId: c.tenantId, contractId, name: po.name, ssp: fx(n(po.ssp), 4), allocatedPrice: '0',
        method, startDate: po.start_date ?? m.asOf, endDate: po.end_date ?? null, satisfiedPct: '0', status: 'Pending',
      });
    }
    const oldTotal = round4(n(c.totalPrice));
    const newTotal = round4(oldTotal + n(m.addedPrice));
    await db.update(revContracts).set({ totalPrice: fx(newTotal, 4) }).where(eq(revContracts.id, contractId));

    const pos = await db.select().from(performanceObligations).where(eq(performanceObligations.contractId, contractId)).orderBy(performanceObligations.id);
    // Per-PO recognized + the re-allocation basis = ssp × unrecognized-fraction (a fully-satisfied PO has
    // basis 0 → it keeps allocated = recognized and gets no share; a new PO has basis = its full ssp).
    const recById = new Map<number, number>();
    const basisById = new Map<number, number>();
    for (const p of pos) {
      const oId = Number(p.id);
      const recRows = await db.select().from(revrecSchedules).where(and(eq(revrecSchedules.obligationId, oId), eq(revrecSchedules.recognized, true)));
      const rec = round4(recRows.reduce((a: number, r: any) => a + n(r.recognizedAmount), 0));
      recById.set(oId, rec);
      const oldAllocated = n(p.allocatedPrice);
      const unrecFrac = oldAllocated > 0 ? Math.max(0, round4((oldAllocated - rec) / oldAllocated)) : 1;
      basisById.set(oId, round4(n(p.ssp) * unrecFrac));
    }
    const remainingConsideration = round4(newTotal - recognizedToDate);
    const sumBasis = round4(pos.reduce((a: number, p: any) => a + (basisById.get(Number(p.id)) ?? 0), 0));
    if (!(sumBasis > 0)) throw new BadRequestException({ code: 'NO_REMAINING_OBLIGATIONS', message: 'no remaining (unsatisfied) obligations to re-allocate the modification over', messageTh: 'ไม่มีภาระคงเหลือให้จัดสรรใหม่' });

    // Compute each remaining PO's share; force Σ share == remainingConsideration by dropping the residual on
    // the largest-basis PO, so Σ allocated == newTotal exactly.
    const shareById = new Map<number, number>();
    let assigned = 0; let maxId = 0; let maxBasis = -1;
    for (const p of pos) {
      const oId = Number(p.id); const b = basisById.get(oId) ?? 0;
      const share = b > 0 ? round4(remainingConsideration * b / sumBasis) : 0;
      shareById.set(oId, share); assigned = round4(assigned + share);
      if (b > maxBasis) { maxBasis = b; maxId = oId; }
    }
    const residual = round4(remainingConsideration - assigned);
    if (Math.abs(residual) >= 0.00005 && maxId) shareById.set(maxId, round4((shareById.get(maxId) ?? 0) + residual));

    for (const p of pos) {
      const oId = Number(p.id);
      const rec = recById.get(oId) ?? 0;
      const newAllocated = round4(rec + (shareById.get(oId) ?? 0));
      await db.update(performanceObligations).set({ allocatedPrice: fx(newAllocated, 4) }).where(eq(performanceObligations.id, oId));
      await this.rebuildRemaining(c, p, newAllocated, rec);
      await this.refreshObligation(oId);
    }
    return { effect: remainingConsideration, re_allocated_remaining: remainingConsideration, new_total_price: newTotal, recognized_before: recognizedToDate, catch_up_delta: 0, entry_no: null };
  }

  // Rebuild the UNRECOGNIZED schedule of one PO, FREEZING already-recognized rows (prospective — no catch-up):
  // spread (newAllocated − recognized) over the PO's remaining (not-yet-recognized) periods. This differs from
  // RevRecService.buildSchedule (which straight-lines the WHOLE allocated across all months) because here the
  // recognized rows keep their ORIGINAL amounts, so only the remaining balance is spread over remaining months.
  private async rebuildRemaining(c: any, po: any, newAllocated: number, recognized: number) {
    const db = this.db;
    const oId = Number(po.id);
    const existing = await db.select().from(revrecSchedules).where(eq(revrecSchedules.obligationId, oId));
    for (const row of existing) if (!row.recognized) await db.delete(revrecSchedules).where(eq(revrecSchedules.id, Number(row.id)));
    const recognizedPeriods = new Set(existing.filter((r: any) => r.recognized).map((r: any) => r.period));
    const remaining = round4(newAllocated - recognized);
    if (remaining <= 0.00005) return;

    if (po.method === 'over_time') {
      const startP = String(po.startDate ?? c.contractDate).slice(0, 7);
      const endP = String(po.endDate ?? po.startDate ?? c.contractDate).slice(0, 7);
      const months = Math.max(1, monthsBetween(startP, endP));
      const remainingPeriods: string[] = [];
      for (let i = 0; i < months; i++) { const period = addMonths(startP, i); if (!recognizedPeriods.has(period)) remainingPeriods.push(period); }
      if (!remainingPeriods.length) return;
      const amts = splitStraightLine(remaining, remainingPeriods.length);
      for (let i = 0; i < remainingPeriods.length; i++)
        await db.insert(revrecSchedules).values({ tenantId: c.tenantId, contractId: Number(c.id), obligationId: oId, period: remainingPeriods[i]!, plannedAmount: fx(amts[i], 4), recognizedAmount: '0', recognized: false });
    } else {
      const period = String(po.startDate ?? c.contractDate).slice(0, 7);
      if (!recognizedPeriods.has(period))
        await db.insert(revrecSchedules).values({ tenantId: c.tenantId, contractId: Number(c.id), obligationId: oId, period, plannedAmount: fx(remaining, 4), recognizedAmount: '0', recognized: false });
    }
  }

  // §21(b) — NOT distinct: part of a single performance obligation ⇒ CUMULATIVE CATCH-UP at the modification
  // date. Recompute the transaction price (old + added), re-allocate by SSP (REUSE allocateBySSP), scale the
  // already-recognized rows to the new allocation, rebuild the unrecognized schedule, and POST the catch-up
  // delta (same asset-aware split as recognize()). This is the same catch-up primitive as the Wave-2 re-estimate.
  private async applyCumulative(c: any, m: any, user: JwtUser) {
    const db = this.db;
    const contractId = Number(c.id);
    const recognizedBefore = await this.revrec.sumRecognized(contractId);
    const posBefore = await db.select().from(performanceObligations).where(eq(performanceObligations.contractId, contractId)).orderBy(performanceObligations.id);
    const oldAlloc = new Map<number, number>(posBefore.map((p: any) => [Number(p.id), n(p.allocatedPrice)]));

    // Any provided obligations represent the changed scope folded into the arrangement (allocated 0 → SSP re-allocation sets it).
    const addedPos: ModPoDto[] = JSON.parse(m.addedPos || '[]');
    for (const po of addedPos) {
      const method = po.method ?? 'point_in_time';
      await db.insert(performanceObligations).values({
        tenantId: c.tenantId, contractId, name: po.name, ssp: fx(n(po.ssp), 4), allocatedPrice: '0',
        method, startDate: po.start_date ?? m.asOf, endDate: po.end_date ?? null, satisfiedPct: '0', status: 'Pending',
      });
    }
    const oldTotal = round4(n(c.totalPrice));
    const newTotal = round4(oldTotal + n(m.addedPrice));
    await db.update(revContracts).set({ totalPrice: fx(newTotal, 4) }).where(eq(revContracts.id, contractId));
    await this.revrec.allocateBySSP(contractId);

    // Scale already-recognized rows to the new allocation → the cumulative catch-up on satisfied portions.
    const posAfter = await db.select().from(performanceObligations).where(eq(performanceObligations.contractId, contractId)).orderBy(performanceObligations.id);
    const newAlloc = new Map<number, number>(posAfter.map((p: any) => [Number(p.id), n(p.allocatedPrice)]));
    let catchUp = 0;
    for (const p of posAfter) {
      const oId = Number(p.id);
      const a0 = oldAlloc.get(oId) ?? 0; const a1 = newAlloc.get(oId) ?? 0;
      if (!(a0 > 0)) continue;
      const scale = a1 / a0;
      const rows = await db.select().from(revrecSchedules).where(and(eq(revrecSchedules.obligationId, oId), eq(revrecSchedules.recognized, true)));
      for (const r of rows) {
        const oldRec = n(r.recognizedAmount); const newRec = round4(oldRec * scale);
        catchUp = round4(catchUp + (newRec - oldRec));
        await db.update(revrecSchedules).set({ recognizedAmount: fx(newRec, 4) }).where(eq(revrecSchedules.id, Number(r.id)));
      }
    }
    await this.revrec.buildSchedule(contractId);
    for (const p of posAfter) await this.refreshObligation(Number(p.id));

    // POST the catch-up delta (idempotent). Same asset-aware split as recognize()/re-estimate: release
    // billed-in-advance liability (Dr 2410) first, book the surplus recognized ahead of billing as a contract
    // asset (Dr 1265) / Cr 4300; a downward modification (partial termination) reverses (Dr 4300).
    let entryNo: string | null = null;
    if (this.ledger && Math.abs(catchUp) >= 0.0001) {
      const ref = `REVREC-MOD:${c.contractNo}:${Number(m.id)}`;
      if (!(await this.ledger.alreadyPosted('REVREC-MOD', ref, c.tenantId))) {
        const billed = round4(n(c.billedAmount));
        const availableLiability = round4(Math.max(0, billed - recognizedBefore));
        const lines: any[] = [];
        if (catchUp > 0) {
          const fromLiability = round4(Math.min(catchUp, availableLiability));
          const toAsset = round4(catchUp - fromLiability);
          if (fromLiability > 0) lines.push({ account_code: DEFERRED_REVENUE, debit: fromLiability, memo: 'Release contract liability (modification catch-up)' });
          if (toAsset > 0) lines.push({ account_code: CONTRACT_ASSET, debit: toAsset, memo: 'Contract asset — modification catch-up' });
          lines.push({ account_code: REVENUE, credit: catchUp, memo: 'Contract-modification cumulative catch-up (recognized revenue)' });
        } else {
          const mag = round4(-catchUp);
          const availableLiabilityAfter = round4(Math.max(0, billed - (recognizedBefore + catchUp)));
          const toLiability = round4(Math.min(mag, availableLiabilityAfter));
          const fromAsset = round4(mag - toLiability);
          lines.push({ account_code: REVENUE, debit: mag, memo: 'Reverse revenue (modification true-down)' });
          if (toLiability > 0) lines.push({ account_code: DEFERRED_REVENUE, credit: toLiability, memo: 'Restore contract liability' });
          if (fromAsset > 0) lines.push({ account_code: CONTRACT_ASSET, credit: fromAsset, memo: 'Reduce contract asset' });
        }
        const je: any = await this.ledger.postEntry({
          date: m.asOf ?? ymd(), source: 'REVREC-MOD', sourceRef: ref, tenantId: c.tenantId, currency: c.currency ?? undefined,
          memo: `TFRS15 contract-modification catch-up ${c.contractNo} (mod ${Number(m.id)})`, createdBy: user.username, lines,
        });
        entryNo = je?.entry_no ?? null;
      }
    }
    return { effect: catchUp, new_total_price: newTotal, recognized_before: recognizedBefore, catch_up_delta: catchUp, entry_no: entryNo };
  }

  // Recompute a PO's satisfied_pct + status from its schedule rows (mirrors RevRecService.refreshObligation,
  // which is private there).
  private async refreshObligation(obligationId: number) {
    const db = this.db;
    const [po] = await db.select().from(performanceObligations).where(eq(performanceObligations.id, obligationId)).limit(1);
    if (!po) return;
    const rows = await db.select().from(revrecSchedules).where(eq(revrecSchedules.obligationId, obligationId));
    const recognized = round4(rows.filter((r: any) => r.recognized).reduce((a: number, r: any) => a + n(r.recognizedAmount), 0));
    const allocated = n(po.allocatedPrice);
    const pct = allocated > 0 ? round4(Math.min((recognized / allocated) * 100, 100)) : 0;
    const status = pct >= 99.999 ? 'Satisfied' : (pct > 0 ? 'InProgress' : 'Pending');
    await db.update(performanceObligations).set({ satisfiedPct: fx(pct, 4), status }).where(eq(performanceObligations.id, obligationId));
  }

  // ── GET :id/modifications — list the contract's modifications (newest first). ──
  async listModifications(contractId: number) {
    const db = this.db;
    const c = await this.assertContract(contractId);
    const rows = await db.select().from(revContractModifications).where(eq(revContractModifications.contractId, contractId)).orderBy(desc(revContractModifications.id));
    return {
      contract_id: contractId, contract_no: c.contractNo, currency: c.currency, total_price: round4(n(c.totalPrice)),
      modifications: rows.map((r: any) => ({
        id: Number(r.id), as_of: r.asOf, type: r.type, added_price: n(r.addedPrice),
        distinct_flag: r.distinctFlag, at_ssp_flag: r.atSspFlag, effect_amount: n(r.effectAmount),
        new_contract_id: r.newContractId != null ? Number(r.newContractId) : null,
        status: r.status, note: r.note, created_by: r.createdBy, approved_by: r.approvedBy, applied_at: r.appliedAt,
      })),
    };
  }
}
