import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { revContracts, performanceObligations, revrecSchedules, revVariableEstimates } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { RevRecService } from '../revenue/revrec.service';
import { n, fx, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';

// ── Track D — Wave 2 (REV-25): variable consideration + the constraint (TFRS 15 / IFRS 15 / ASC 606 §50-59) ──
// The REV-19 engine (RevRecService) holds a FIXED transaction price (rev_contracts.total_price). Variable
// consideration (rebates, refunds, performance bonuses/penalties, price concessions, usage tiers) is:
//   1. ESTIMATED — expected value (Σ probability × amount) OR most-likely amount (§53).
//   2. CONSTRAINED — capped to the portion "highly probable" not to reverse (§56-58). Only the CONSTRAINED
//      amount (never the gross estimate) is added to the recognizable transaction price.
//   3. Re-estimated each reporting period (§59) and TRUED-UP — a change in the transaction price is allocated
//      to the performance obligations and the amount allocated to a SATISFIED obligation is recognized as a
//      cumulative catch-up in the period of change (§88).
// The estimate is a management JUDGEMENT, so it is a maker-checker artifact: the estimator (created_by) may
// NOT approve their own estimate (SOD_SELF_APPROVAL), and approval is MANDATORY before an estimate drives
// revenue (only an Approved estimate can be applied by /reestimate). Price recompute + re-allocation + the
// unrecognized-schedule rebuild REUSE RevRecService (allocateBySSP / buildSchedule / sumRecognized) — this
// module extends the contract, it does not rebuild the engine. The catch-up delta posts against 2410/1265 ↔
// 4300 (idempotent via LedgerService.postEntry) with the SAME asset-aware split as recognize(). No new COA.

const DEFERRED_REVENUE = '2410';   // Contract Liability / Deferred Revenue
const CONTRACT_ASSET = '1265';     // Contract Asset (Unbilled Receivable)
const REVENUE = '4300';            // Subscription & Service Revenue (recognized)

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

export interface ScenarioDto { amount: number; probability: number }
export interface RecordEstimateDto {
  method: 'expected_value' | 'most_likely';
  scenarios?: ScenarioDto[];        // expected_value: Σ amount×prob · most_likely: pick the max-probability amount
  most_likely_amount?: number;      // most_likely: an explicit single outcome (overrides scenarios)
  constrained_amount: number;       // management's highly-probable-not-to-reverse cap (must be ≤ gross)
  as_of?: string;
  note?: string;
}

@Injectable()
export class RevVariableService {
  // @Optional ledger so a standalone harness can construct the service without the GL graph; RevRecService is
  // exported by RevenueModule (the REV-19 engine) and REUSED for allocation + schedule rebuild.
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly revrec: RevRecService,
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

  // ── POST :id/variable-consideration — MAKER records an estimate (Pending). Computes the GROSS estimate by
  //    the chosen method, then validates the CONSTRAINT: the constrained amount may not exceed the estimate
  //    (you cannot recognize more than you estimate) — CONSTRAINT_EXCEEDS_ESTIMATE. No GL, no price change:
  //    the estimate does not drive revenue until a DIFFERENT user approves it and /reestimate applies it.
  async recordEstimate(contractId: number, dto: RecordEstimateDto, user: JwtUser) {
    const db = this.db;
    const c = await this.assertContract(contractId);
    const asOf = dto.as_of ?? ymd();

    let gross: number;
    if (dto.method === 'expected_value') {
      const scen = dto.scenarios ?? [];
      if (!scen.length) throw new BadRequestException({ code: 'NO_SCENARIOS', message: 'expected_value needs at least one {amount, probability} scenario', messageTh: 'วิธีค่าคาดหวังต้องมีสถานการณ์อย่างน้อยหนึ่งรายการ' });
      const sumP = round4(scen.reduce((a, s) => a + n(s.probability), 0));
      for (const s of scen) if (n(s.probability) < 0 || n(s.probability) > 1) throw new BadRequestException({ code: 'INVALID_PROBABILITY', message: 'each probability must be within [0,1]', messageTh: 'ความน่าจะเป็นแต่ละค่าต้องอยู่ในช่วง [0,1]' });
      if (Math.abs(sumP - 1) > 0.01) throw new BadRequestException({ code: 'INVALID_PROBABILITIES', message: `scenario probabilities must sum to 1 (got ${sumP})`, messageTh: 'ผลรวมความน่าจะเป็นต้องเท่ากับ 1' });
      gross = round4(scen.reduce((a, s) => a + n(s.amount) * n(s.probability), 0));
    } else if (dto.method === 'most_likely') {
      if (dto.most_likely_amount != null) {
        gross = round4(n(dto.most_likely_amount));
      } else {
        const scen = dto.scenarios ?? [];
        if (!scen.length) throw new BadRequestException({ code: 'NO_SCENARIOS', message: 'most_likely needs most_likely_amount or scenarios', messageTh: 'วิธีค่าที่เป็นไปได้มากสุดต้องมีจำนวนเงินหรือสถานการณ์' });
        const top = scen.reduce((best, s) => (n(s.probability) > n(best.probability) ? s : best), scen[0]!);
        gross = round4(n(top.amount));
      }
    } else {
      throw new BadRequestException({ code: 'INVALID_METHOD', message: "method must be 'expected_value' or 'most_likely'", messageTh: 'วิธีต้องเป็น expected_value หรือ most_likely' });
    }

    const constrained = round4(n(dto.constrained_amount));
    if (constrained < 0) throw new BadRequestException({ code: 'INVALID_CONSTRAINT', message: 'constrained_amount must be ≥ 0', messageTh: 'จำนวนที่จำกัดต้องไม่ติดลบ' });
    // THE CONTROL: the constraint caps the recognizable price — you may never recognize MORE than the
    // estimate. A constrained amount above the gross estimate is an over-recognition attempt.
    if (constrained > round4(gross) + 0.0001)
      throw new BadRequestException({ code: 'CONSTRAINT_EXCEEDS_ESTIMATE', message: `constrained_amount ${constrained} exceeds the gross estimate ${gross} — the constraint may only reduce the recognizable amount (TFRS 15 §56-58)`, messageTh: 'จำนวนที่จำกัดเกินกว่าค่าประมาณ — ข้อจำกัดทำได้เพียงลดจำนวนที่รับรู้ได้เท่านั้น' });

    const [row] = await db.insert(revVariableEstimates).values({
      tenantId: c.tenantId, contractId, asOf, method: dto.method,
      grossEstimate: fx(gross, 4), constrainedAmount: fx(constrained, 4), postedDelta: '0',
      status: 'Pending', note: dto.note ?? null, createdBy: user.username,
    }).returning();

    return { id: Number(row!.id), contract_id: contractId, as_of: asOf, method: dto.method, gross_estimate: gross, constrained_amount: constrained, status: 'Pending', created_by: user.username };
  }

  // ── POST :id/variable-consideration/:vcId/approve — CHECKER approves the estimate (Pending → Approved).
  //    SoD: the approver must differ from the estimator (created_by), else SOD_SELF_APPROVAL. Approval is
  //    MANDATORY before an estimate can drive revenue — /reestimate only applies APPROVED estimates.
  async approveEstimate(contractId: number, vcId: number, user: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    await this.assertContract(contractId);
    const [e] = await db.select().from(revVariableEstimates).where(and(eq(revVariableEstimates.id, vcId), eq(revVariableEstimates.contractId, contractId))).limit(1);
    if (!e) throw new NotFoundException({ code: 'ESTIMATE_NOT_FOUND', message: `Variable-consideration estimate ${vcId} not found for contract ${contractId}`, messageTh: 'ไม่พบค่าประมาณสิ่งตอบแทนผันแปร' });
    if (e.status !== 'Pending') throw new BadRequestException({ code: 'ESTIMATE_NOT_PENDING', message: `Estimate ${vcId} is ${e.status}, not Pending`, messageTh: 'ค่าประมาณไม่ได้อยู่ในสถานะรอการอนุมัติ' });
    // Maker-checker (SoD): the estimator cannot approve their own management judgement.
    await assertMakerChecker(db, { user, maker: e.createdBy, event: 'rev.estimate.approve', ref: `${contractId}:${vcId}`, amount: n(e.constrainedAmount), reason: selfApprovalReason, code: 'SOD_SELF_APPROVAL', message: 'The estimator cannot approve their own variable-consideration estimate (segregation of duties)', messageTh: 'ผู้ประมาณการไม่สามารถอนุมัติค่าประมาณของตนเองได้ (แบ่งแยกหน้าที่)' });
    await db.update(revVariableEstimates).set({ status: 'Approved', approvedBy: user.username }).where(eq(revVariableEstimates.id, vcId));
    return { id: vcId, contract_id: contractId, status: 'Approved', approved_by: user.username };
  }

  // ── POST :id/reestimate — MAKER applies the latest APPROVED, not-yet-applied estimate for the period:
  //    recompute the transaction price (fixed base + constrained variable) → re-allocate by SSP → rebuild the
  //    UNRECOGNIZED schedule → TRUE-UP already-recognized revenue with a cumulative catch-up (§88). The fixed
  //    base is derived as total_price − the previously-applied constrained amount, so repeated re-estimates
  //    each swap the whole variable component (they don't compound). Idempotent: with no unapplied approved
  //    estimate it is a no-op (applied:false); the GL post is also guarded by LedgerService.alreadyPosted.
  async reestimate(contractId: number, dto: { date?: string }, user: JwtUser) {
    const db = this.db;
    const c = await this.assertContract(contractId);

    // The estimate that drives this re-estimate = the newest Approved estimate not yet applied.
    const [E] = await db.select().from(revVariableEstimates)
      .where(and(eq(revVariableEstimates.contractId, contractId), eq(revVariableEstimates.status, 'Approved')))
      .orderBy(desc(revVariableEstimates.id)).limit(1);
    if (!E || E.appliedAt != null) {
      // Nothing to apply — an unapproved (Pending) estimate does NOT drive revenue; a re-run after apply is
      // a no-op. This is what makes approval mandatory before recognition and makes /reestimate idempotent.
      return { contract_id: contractId, contract_no: c.contractNo, applied: false, catch_up_delta: 0, message: 'no approved estimate awaiting application' };
    }

    // Prior applied constrained amount (the variable component currently baked into total_price). The newest
    // already-applied estimate (highest id among appliedAt != null) is the one currently reflected in price.
    const applied = (await db.select().from(revVariableEstimates)
      .where(eq(revVariableEstimates.contractId, contractId)).orderBy(desc(revVariableEstimates.id)))
      .filter((r: any) => r.appliedAt != null);
    const priorConstrained = applied.length ? n(applied[0]!.constrainedAmount) : 0;
    const fixedBase = round4(n(c.totalPrice) - priorConstrained);
    const newConstrained = n(E.constrainedAmount);
    const newTotal = round4(fixedBase + newConstrained);

    // Capture old allocation BEFORE the price change so we can scale already-recognized rows (the catch-up).
    const posBefore = await db.select().from(performanceObligations).where(eq(performanceObligations.contractId, contractId)).orderBy(performanceObligations.id);
    const oldAlloc = new Map<number, number>(posBefore.map((p: any) => [Number(p.id), n(p.allocatedPrice)]));
    const recognizedBefore = await this.revrec.sumRecognized(contractId);

    // 1. Recompute transaction price and re-allocate by SSP (REUSE the REV-19 engine).
    await db.update(revContracts).set({ totalPrice: fx(newTotal, 4) }).where(eq(revContracts.id, contractId));
    await this.revrec.allocateBySSP(contractId);

    // 2. TRUE-UP: scale each already-recognized schedule row to the new allocation so Σrecognized tracks the
    //    new price (a satisfied obligation's revenue is caught up in the period of change). The catch-up delta
    //    = the increase (or decrease) in recognized revenue across all satisfied portions.
    const posAfter = await db.select().from(performanceObligations).where(eq(performanceObligations.contractId, contractId)).orderBy(performanceObligations.id);
    const newAlloc = new Map<number, number>(posAfter.map((p: any) => [Number(p.id), n(p.allocatedPrice)]));
    let catchUp = 0;
    for (const p of posAfter) {
      const oId = Number(p.id);
      const a0 = oldAlloc.get(oId) ?? 0;
      const a1 = newAlloc.get(oId) ?? 0;
      if (!(a0 > 0)) continue;               // no prior allocation → no recognized rows to scale
      const scale = a1 / a0;
      const rows = await db.select().from(revrecSchedules).where(and(eq(revrecSchedules.obligationId, oId), eq(revrecSchedules.recognized, true)));
      for (const r of rows) {
        const oldRec = n(r.recognizedAmount);
        const newRec = round4(oldRec * scale);
        catchUp = round4(catchUp + (newRec - oldRec));
        await db.update(revrecSchedules).set({ recognizedAmount: fx(newRec, 4) }).where(eq(revrecSchedules.id, Number(r.id)));
      }
    }

    // 3. Rebuild the UNRECOGNIZED schedule at the new allocation (REUSE buildSchedule — it only rebuilds
    //    unrecognized rows; the scaled recognized rows are left untouched). Future recognition now runs at the
    //    new price and Σrecognized + Σfuture-planned == the new allocated amount.
    await this.revrec.buildSchedule(contractId);

    // 4. Refresh each obligation's satisfied_pct (scaling keeps recognized/allocated — and thus % — constant).
    for (const p of posAfter) {
      const oId = Number(p.id);
      const allocated = newAlloc.get(oId) ?? 0;
      const rows = await db.select().from(revrecSchedules).where(and(eq(revrecSchedules.obligationId, oId), eq(revrecSchedules.recognized, true)));
      const rec = round4(rows.reduce((s: number, r: any) => s + n(r.recognizedAmount), 0));
      const pct = allocated > 0 ? round4(Math.min((rec / allocated) * 100, 100)) : 0;
      const status = pct >= 99.999 ? 'Satisfied' : (pct > 0 ? 'InProgress' : 'Pending');
      await db.update(performanceObligations).set({ satisfiedPct: fx(pct, 4), status }).where(eq(performanceObligations.id, oId));
    }

    // 5. POST the catch-up delta on already-recognized revenue (idempotent). Same asset-aware split as
    //    recognize(): release billed-in-advance liability (Dr 2410) first, book the surplus recognized ahead
    //    of billing as a contract asset (Dr 1265) / Cr 4300. A downward re-estimate reverses (Dr 4300).
    let entryNo: string | null = null;
    if (this.ledger && Math.abs(catchUp) >= 0.0001) {
      const ref = `REVREC-VC:${c.contractNo}:${Number(E.id)}`;
      if (!(await this.ledger.alreadyPosted('REVREC-VC', ref, c.tenantId))) {
        const billed = round4(n(c.billedAmount));
        const availableLiability = round4(Math.max(0, billed - recognizedBefore));
        const lines: any[] = [];
        if (catchUp > 0) {
          const fromLiability = round4(Math.min(catchUp, availableLiability));
          const toAsset = round4(catchUp - fromLiability);
          if (fromLiability > 0) lines.push({ account_code: DEFERRED_REVENUE, debit: fromLiability, memo: 'Release contract liability (variable-consideration true-up)' });
          if (toAsset > 0) lines.push({ account_code: CONTRACT_ASSET, debit: toAsset, memo: 'Contract asset — variable-consideration true-up' });
          lines.push({ account_code: REVENUE, credit: catchUp, memo: 'Variable-consideration catch-up (recognized revenue)' });
        } else {
          const mag = round4(-catchUp);
          // Downward re-estimate: reduce recognized revenue. Restore any billing-in-advance liability first
          // (up to what billing covers post-reduction), else reduce the contract asset.
          const availableLiabilityAfter = round4(Math.max(0, billed - (recognizedBefore + catchUp)));
          const toLiability = round4(Math.min(mag, availableLiabilityAfter));
          const fromAsset = round4(mag - toLiability);
          lines.push({ account_code: REVENUE, debit: mag, memo: 'Reverse variable-consideration (constraint true-down)' });
          if (toLiability > 0) lines.push({ account_code: DEFERRED_REVENUE, credit: toLiability, memo: 'Restore contract liability' });
          if (fromAsset > 0) lines.push({ account_code: CONTRACT_ASSET, credit: fromAsset, memo: 'Reduce contract asset' });
        }
        const je: any = await this.ledger.postEntry({
          date: dto.date ?? ymd(), source: 'REVREC-VC', sourceRef: ref, tenantId: c.tenantId, currency: c.currency ?? undefined,
          memo: `TFRS15 variable-consideration true-up ${c.contractNo} (est ${Number(E.id)})`, createdBy: user.username, lines,
        });
        entryNo = je?.entry_no ?? null;
      }
    }

    await db.update(revVariableEstimates).set({ appliedAt: new Date(), postedDelta: fx(catchUp, 4) }).where(eq(revVariableEstimates.id, Number(E.id)));

    return {
      contract_id: contractId, contract_no: c.contractNo, applied: true, estimate_id: Number(E.id),
      fixed_base: fixedBase, constrained_amount: newConstrained, new_total_price: newTotal,
      recognized_before: recognizedBefore, catch_up_delta: catchUp, entry_no: entryNo,
    };
  }

  // ── GET :id/variable-consideration — list the contract's estimates (newest first) with the current price. ──
  async listEstimates(contractId: number) {
    const db = this.db;
    const c = await this.assertContract(contractId);
    const rows = await db.select().from(revVariableEstimates).where(eq(revVariableEstimates.contractId, contractId)).orderBy(desc(revVariableEstimates.id));
    return {
      contract_id: contractId, contract_no: c.contractNo, currency: c.currency, total_price: round4(n(c.totalPrice)),
      estimates: rows.map((r: any) => ({
        id: Number(r.id), as_of: r.asOf, method: r.method, gross_estimate: n(r.grossEstimate), constrained_amount: n(r.constrainedAmount),
        posted_delta: n(r.postedDelta), status: r.status, note: r.note, created_by: r.createdBy, approved_by: r.approvedBy,
        applied: r.appliedAt != null, applied_at: r.appliedAt,
      })),
    };
  }
}
