import { Inject, Injectable, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { hedgeRelationships, hedgeDerivatives, hedgeEffectivenessTests, hedgeOciMovements } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import { currentTenantStore } from '../../common/tenant-context';
import { ymd, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// ── Hedge accounting register (Track C Wave 3) — control TRE-04 (IFRS 9 / TFRS 9 · ASC 815) ───────────────────
// A hedge RELATIONSHIP is DESIGNATED under maker-checker (create → PendingApproval; a DIFFERENT user approves →
// Approved; self-approve → 403 SOD_SELF_APPROVAL, mirroring TRE-03 / FX-04). THE CONTROL: no hedge/OCI accounting
// happens until the relationship is Approved (designation) AND its LATEST effectiveness test is effective=true.
//   • Undesignated / unapproved relationship → any accounting is rejected HEDGE_NOT_DESIGNATED.
//   • A CASH_FLOW hedge's OCI treatment is refused (HEDGE_NOT_EFFECTIVE) unless Approved+effective; the whole
//     remeasurement then flows to P&L (the caller books it with to_pl). When Approved+effective the EFFECTIVE
//     portion defers in the Cash-Flow Hedge Reserve 3550 (OCI equity, mirroring the Wave-2 FVOCI reserve 3500)
//     and only the INEFFECTIVE portion hits P&L 5450. Reclassification recycles 3550 → the hedged-item revenue
//     line when the hedged cash flow occurs.
//   • A FAIR_VALUE hedge (Approved+effective) routes the derivative change to P&L 5450 and BASIS-ADJUSTS the
//     hedged item's carrying account with an offsetting P&L leg.
// The derivative fair-value change posts Dr 1380 Derivative Asset (gain) / Cr 2460 Derivative Liability (loss).
// Everything routes through LedgerService.postEntry (GL-05 balanced + period lock). Reuses the Wave-1/2 treasury
// duties (treasury maker / treasury_approve checker); tenant-scoped (RLS).

const TYPES = ['CASH_FLOW', 'FAIR_VALUE'] as const;
type HedgeType = (typeof TYPES)[number];

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

export interface HedgeDto {
  hedgedItem: string;
  hedgingInstrument: string;
  hedgeType?: string;                 // CASH_FLOW | FAIR_VALUE
  hedgeRatio?: number;
  notional?: number;
  documentation: string;
  hedgedItemAccount?: string;         // FAIR_VALUE hedge — the GL account basis-adjusted
  reclassAccount?: string;            // CASH_FLOW hedge — the revenue/P&L line OCI recycles to
  currency?: string;
  derivativeFv?: number;              // opening derivative fair value (usually 0 at inception)
  tenantId?: number | null;
}
export interface EffectivenessDto { testType?: string; method?: string; ratioPct: number; effective: boolean; asOf?: string; notes?: string }
export interface MeasureDto { fairValue: number; asOf?: string; effectivePortion?: number; hedgedItemDelta?: number; toPl?: boolean }
export interface RebalanceDto { hedgeRatio?: number; notional?: number; documentation?: string }
export interface ReclassifyDto { amount: number; asOf?: string; reclassAccount?: string }

@Injectable()
export class HedgeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    @Optional() private readonly ledger?: LedgerService,
  ) {}

  private tenant(explicit?: number | null, user?: JwtUser): number | null {
    if (explicit !== undefined && explicit !== null) return explicit;
    return currentTenantStore()?.tenantId ?? user?.tenantId ?? null;
  }

  // ── GL leg helpers (all signed on the delta; a gain is a debit to the derivative asset) ──────────────────────
  // The derivative fair-value change: a gain (delta>0) increases the derivative asset (Dr 1380); a loss (delta<0)
  // increases the derivative liability (Cr 2460). Simplified to the sign of the movement (derivative starts at 0).
  private derivativeLeg(delta: number): any[] {
    if (delta > 0) return [{ account_code: postingDefault('HEDGE.DERIVATIVE.MTM', 'derivative_asset'), debit: delta }];
    if (delta < 0) return [{ account_code: postingDefault('HEDGE.DERIVATIVE.MTM', 'derivative_liab'), credit: -delta }];
    return [];
  }
  // The OFFSETTING leg for a signed amount: a positive amount credits the account (offsets a derivative gain), a
  // negative amount debits it (offsets a derivative loss). Used for OCI 3550, P&L 5450 and the hedged-item offset.
  private offsetLeg(account: string, signed: number): any[] {
    const a = round2(signed);
    if (a > 0) return [{ account_code: account, credit: a }];
    if (a < 0) return [{ account_code: account, debit: -a }];
    return [];
  }
  // The hedged item's own carrying leg (FAIR_VALUE hedge basis adjustment): a positive fair-value change debits
  // the item (carrying up), a negative change credits it (carrying down).
  private itemLeg(account: string, signed: number): any[] {
    const a = round2(signed);
    if (a > 0) return [{ account_code: account, debit: a }];
    if (a < 0) return [{ account_code: account, credit: -a }];
    return [];
  }

  // ── Designation (maker, TRE-04) ──────────────────────────────────────────────────────────────────────────────
  async designate(dto: HedgeDto, user: JwtUser) {
    const db = this.db;
    if (!dto.documentation || !dto.documentation.trim()) {
      throw new BadRequestException({ code: 'BAD_DOCUMENTATION', message: 'Hedge documentation is required at designation (IFRS 9 6.4.1)', messageTh: 'ต้องมีเอกสารกำหนดความสัมพันธ์การป้องกันความเสี่ยง' });
    }
    const type = (TYPES as readonly string[]).includes(dto.hedgeType ?? '') ? (dto.hedgeType as HedgeType) : 'CASH_FLOW';
    const ratio = round2(dto.hedgeRatio ?? 1);
    if (!(ratio > 0)) throw new BadRequestException({ code: 'BAD_RATIO', message: 'hedge_ratio must be > 0', messageTh: 'อัตราส่วนการป้องกันความเสี่ยงต้องมากกว่าศูนย์' });
    const notional = round2(dto.notional ?? 0);
    if (notional < 0) throw new BadRequestException({ code: 'BAD_NOTIONAL', message: 'notional must be >= 0', messageTh: 'มูลค่าอ้างอิงต้องไม่ติดลบ' });
    const tenantId = this.tenant(dto.tenantId, user);
    const hedgeNo = await this.docNo.nextDaily('HEDG');
    const openFv = round2(dto.derivativeFv ?? 0);
    const [row] = await db.insert(hedgeRelationships).values({
      hedgeNo, tenantId, hedgedItem: dto.hedgedItem, hedgingInstrument: dto.hedgingInstrument, hedgeType: type,
      hedgeRatio: String(ratio), notional: String(notional), documentation: dto.documentation.trim(),
      hedgedItemAccount: dto.hedgedItemAccount ?? null, reclassAccount: dto.reclassAccount ?? null,
      currency: dto.currency ?? 'THB', derivativeFv: String(openFv), ociReserve: '0', basisAdjustment: '0',
      rebalances: 0, status: 'PendingApproval', requestedBy: user.username, createdBy: user.username,
    }).returning({ id: hedgeRelationships.id });
    const id = Number(row!.id);
    await db.insert(hedgeDerivatives).values({
      tenantId, relationshipId: id, instrument: dto.hedgingInstrument, notional: String(notional),
      fairValue: String(openFv), createdBy: user.username,
    });
    return this.getHedge(id);
  }

  // Checker: approve a PendingApproval relationship (approver ≠ requester ⇒ SOD_SELF_APPROVAL).
  async approve(id: number, user: JwtUser) {
    const db = this.db;
    const rel = await this.load(id);
    if (rel.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Hedge is ${rel.status}, not pending approval`, messageTh: 'ความสัมพันธ์การป้องกันความเสี่ยงไม่ได้อยู่ในสถานะรออนุมัติ' });
    if (rel.requestedBy && rel.requestedBy === user.username) {
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot approve a hedge designation you created', messageTh: 'ผู้กำหนดอนุมัติความสัมพันธ์ของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    await db.update(hedgeRelationships).set({ status: 'Approved', approvedBy: user.username, approvedAt: new Date() }).where(eq(hedgeRelationships.id, id));
    return this.getHedge(id);
  }

  async reject(id: number, user: JwtUser) {
    const db = this.db;
    const rel = await this.load(id);
    if (rel.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Hedge is ${rel.status}, not pending approval`, messageTh: 'ความสัมพันธ์การป้องกันความเสี่ยงไม่ได้อยู่ในสถานะรออนุมัติ' });
    await db.update(hedgeRelationships).set({ status: 'Rejected', approvedBy: user.username, approvedAt: new Date() }).where(eq(hedgeRelationships.id, id));
    return this.getHedge(id);
  }

  // ── Effectiveness testing (TRE-04) — a prospective/retrospective test; the latest effective=true unlocks OCI ──
  async recordEffectiveness(id: number, dto: EffectivenessDto, user: JwtUser) {
    const db = this.db;
    const rel = await this.load(id);
    if (rel.status !== 'Approved') {
      throw new BadRequestException({ code: 'HEDGE_NOT_DESIGNATED', message: 'Relationship must be an Approved designation before effectiveness testing', messageTh: 'ต้องอนุมัติการกำหนดความสัมพันธ์ก่อนทดสอบประสิทธิผล' });
    }
    const ratio = round2(dto.ratioPct);
    const asOf = dto.asOf ?? ymd();
    const [row] = await db.insert(hedgeEffectivenessTests).values({
      tenantId: rel.tenantId ?? null, relationshipId: id, testType: dto.testType === 'retrospective' ? 'retrospective' : 'prospective',
      method: dto.method ?? 'dollar_offset', ratioPct: String(ratio), effective: !!dto.effective, asOf, notes: dto.notes ?? null,
      createdBy: user.username,
    }).returning({ id: hedgeEffectivenessTests.id });
    return { id: Number(row!.id), hedge_no: rel.hedgeNo, test_type: dto.testType === 'retrospective' ? 'retrospective' : 'prospective', method: dto.method ?? 'dollar_offset', ratio_pct: ratio, effective: !!dto.effective, as_of: asOf };
  }

  // The latest effectiveness test (by as_of then id). Returns null when none recorded.
  private async latestTest(id: number) {
    const db = this.db;
    const [t] = await db.select().from(hedgeEffectivenessTests).where(eq(hedgeEffectivenessTests.relationshipId, id)).orderBy(desc(hedgeEffectivenessTests.asOf), desc(hedgeEffectivenessTests.id)).limit(1);
    return t ?? null;
  }

  // ── Remeasure the derivative fair value → route per the CONTROL GATE (TRE-04) ────────────────────────────────
  async measure(id: number, dto: MeasureDto, user: JwtUser) {
    const db = this.db;
    const rel = await this.load(id);
    // Gate #1: no accounting at all on an undesignated / unapproved relationship.
    if (rel.status !== 'Approved') {
      throw new BadRequestException({ code: 'HEDGE_NOT_DESIGNATED', message: 'Hedge accounting requires an Approved designation', messageTh: 'การบัญชีป้องกันความเสี่ยงต้องมีการกำหนดที่อนุมัติแล้ว' });
    }
    const newFv = round2(dto.fairValue);
    const priorFv = n(rel.derivativeFv);
    const delta = round2(newFv - priorFv);
    const asOf = dto.asOf ?? ymd();
    const type = rel.hedgeType as HedgeType;
    const test = await this.latestTest(id);
    const eligible = !!test && test.effective === true;

    let lines: any[] = [];
    let ociDelta = 0;       // signed movement in the CF hedge reserve (3550)
    let plDelta = 0;        // signed movement through P&L 5450 (memo)
    let basisDelta = 0;     // signed hedged-item basis adjustment (FV hedge)
    let route = '';

    if (type === 'CASH_FLOW') {
      if (dto.toPl) {
        // Conservative treatment (relationship not hedge-eligible, or caller elects P&L): whole change to P&L.
        route = 'PL';
        plDelta = delta;
        lines = [...this.derivativeLeg(delta), ...this.offsetLeg(postingDefault('HEDGE.DERIVATIVE.MTM', 'hedge_pl'), delta)];
      } else {
        // Gate #2: the OCI path is refused unless Approved AND latest test effective=true.
        if (!eligible) {
          throw new BadRequestException({ code: 'HEDGE_NOT_EFFECTIVE', message: 'Cash-flow hedge OCI deferral requires a passing effectiveness test; remeasure with to_pl to route the change to P&L', messageTh: 'การเลื่อนรับรู้ผ่าน OCI ต้องผ่านการทดสอบประสิทธิผล' });
        }
        route = 'OCI';
        const effective = round2(dto.effectivePortion !== undefined ? dto.effectivePortion : delta);
        const ineffective = round2(delta - effective);
        ociDelta = effective;
        plDelta = ineffective;
        lines = [
          ...this.derivativeLeg(delta),
          ...this.offsetLeg(postingDefault('HEDGE.CF.OCI', 'cf_hedge_reserve'), effective),
          ...this.offsetLeg(postingDefault('HEDGE.DERIVATIVE.MTM', 'hedge_pl'), ineffective),
        ];
      }
    } else {
      // FAIR_VALUE — the hedged item is basis-adjusted only when the hedge is effective; else the accounting is
      // refused (the derivative would still be FVTPL, but the basis adjustment is the hedge treatment gated here).
      if (!eligible) {
        throw new BadRequestException({ code: 'HEDGE_NOT_EFFECTIVE', message: 'Fair-value hedge basis adjustment requires a passing effectiveness test', messageTh: 'การปรับฐานรายการที่ป้องกันต้องผ่านการทดสอบประสิทธิผล' });
      }
      route = 'FV';
      const itemAcct = rel.hedgedItemAccount ?? postingDefault('HEDGE.FV.BASIS', 'hedged_item');
      const hedgedItemDelta = round2(dto.hedgedItemDelta !== undefined ? dto.hedgedItemDelta : -delta);
      basisDelta = hedgedItemDelta;
      plDelta = round2(delta + hedgedItemDelta); // net P&L = ineffectiveness
      lines = [
        // derivative fair-value change → P&L
        ...this.derivativeLeg(delta),
        ...this.offsetLeg(postingDefault('HEDGE.DERIVATIVE.MTM', 'hedge_pl'), delta),
        // hedged-item basis adjustment ↔ offsetting P&L
        ...this.itemLeg(itemAcct, hedgedItemDelta),
        ...this.offsetLeg(postingDefault('HEDGE.FV.BASIS', 'hedge_pl'), hedgedItemDelta),
      ];
    }

    let entryNo: string | null = null;
    if (this.ledger && lines.length) {
      const je: any = await this.ledger.postEntry({
        date: asOf, source: 'HEDGE-MTM', sourceRef: `${rel.hedgeNo}-MTM-${asOf}`, tenantId: rel.tenantId ?? null, currency: rel.currency ?? 'THB',
        memo: `Hedge remeasurement ${rel.hedgeNo} (${type}/${route}) as of ${asOf} — Δfv ${delta}`, createdBy: user.username, lines,
      });
      entryNo = je?.entry_no ?? null;
    }
    await db.update(hedgeRelationships).set({
      derivativeFv: String(newFv),
      ociReserve: String(round2(n(rel.ociReserve) + ociDelta)),
      basisAdjustment: String(round2(n(rel.basisAdjustment) + basisDelta)),
    }).where(eq(hedgeRelationships.id, id));
    await db.update(hedgeDerivatives).set({ fairValue: String(newFv) }).where(eq(hedgeDerivatives.relationshipId, id));
    await db.insert(hedgeOciMovements).values({
      tenantId: rel.tenantId ?? null, relationshipId: id, asOf, amount: String(ociDelta), plAmount: String(plDelta),
      reclassified: false, entryNo, createdBy: user.username,
    });
    return {
      hedge_no: rel.hedgeNo, as_of: asOf, hedge_type: type, route, prior_fair_value: priorFv, fair_value: newFv,
      delta, oci_delta: ociDelta, pl_delta: plDelta, basis_delta: basisDelta,
      oci_reserve: round2(n(rel.ociReserve) + ociDelta), entry_no: entryNo,
    };
  }

  // ── Rebalance (TRE-04) — adjust the hedge ratio / notional of an approved relationship ───────────────────────
  async rebalance(id: number, dto: RebalanceDto, user: JwtUser) {
    const db = this.db;
    const rel = await this.load(id);
    if (rel.status !== 'Approved') throw new BadRequestException({ code: 'HEDGE_NOT_DESIGNATED', message: 'Only an Approved relationship can be rebalanced', messageTh: 'ปรับสมดุลได้เฉพาะความสัมพันธ์ที่อนุมัติแล้ว' });
    const set: any = { rebalances: Number(rel.rebalances) + 1 };
    if (dto.hedgeRatio !== undefined) {
      const ratio = round2(dto.hedgeRatio);
      if (!(ratio > 0)) throw new BadRequestException({ code: 'BAD_RATIO', message: 'hedge_ratio must be > 0', messageTh: 'อัตราส่วนการป้องกันความเสี่ยงต้องมากกว่าศูนย์' });
      set.hedgeRatio = String(ratio);
    }
    if (dto.notional !== undefined) {
      const notional = round2(dto.notional);
      if (notional < 0) throw new BadRequestException({ code: 'BAD_NOTIONAL', message: 'notional must be >= 0', messageTh: 'มูลค่าอ้างอิงต้องไม่ติดลบ' });
      set.notional = String(notional);
      await db.update(hedgeDerivatives).set({ notional: String(notional) }).where(eq(hedgeDerivatives.relationshipId, id));
    }
    if (dto.documentation && dto.documentation.trim()) set.documentation = dto.documentation.trim();
    await db.update(hedgeRelationships).set(set).where(eq(hedgeRelationships.id, id));
    return this.getHedge(id);
  }

  // ── Reclassification (TRE-04) — recycle deferred OCI (3550) to P&L when the hedged cash flow occurs ──────────
  async reclassify(id: number, dto: ReclassifyDto, user: JwtUser) {
    const db = this.db;
    const rel = await this.load(id);
    if (rel.status !== 'Approved') throw new BadRequestException({ code: 'HEDGE_NOT_DESIGNATED', message: 'Reclassification requires an Approved designation', messageTh: 'การจัดประเภทใหม่ต้องมีการกำหนดที่อนุมัติแล้ว' });
    if (rel.hedgeType !== 'CASH_FLOW') throw new BadRequestException({ code: 'BAD_HEDGE_TYPE', message: 'Only a cash-flow hedge defers OCI to reclassify', messageTh: 'เฉพาะการป้องกันความเสี่ยงกระแสเงินสดจึงจัดประเภท OCI ใหม่ได้' });
    const amount = round2(dto.amount);
    if (!(amount > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'amount must be > 0', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
    const reserve = round2(n(rel.ociReserve));
    if (Math.abs(amount) > Math.abs(reserve) + 1e-9) {
      throw new BadRequestException({ code: 'OCI_INSUFFICIENT', message: `Reclassify ${amount} exceeds the deferred OCI reserve ${reserve}`, messageTh: 'จำนวนที่จัดประเภทใหม่เกินยอดสำรอง OCI ที่เลื่อนรับรู้ไว้' });
    }
    const asOf = dto.asOf ?? ymd();
    const reclassTarget = dto.reclassAccount ?? rel.reclassAccount ?? postingDefault('HEDGE.RECLASSIFY', 'reclass_target');
    const cfReserve = postingDefault('HEDGE.RECLASSIFY', 'cf_hedge_reserve');
    // A credit-balance reserve (deferred gains) recycles Dr 3550 / Cr revenue; a debit-balance reserve reverses.
    const gainReserve = reserve >= 0;
    const lines = gainReserve
      ? [{ account_code: cfReserve, debit: amount }, { account_code: reclassTarget, credit: amount }]
      : [{ account_code: cfReserve, credit: amount }, { account_code: reclassTarget, debit: amount }];
    let entryNo: string | null = null;
    if (this.ledger) {
      const je: any = await this.ledger.postEntry({
        date: asOf, source: 'HEDGE-RECLASS', sourceRef: `${rel.hedgeNo}-RC-${asOf}-${amount}`, tenantId: rel.tenantId ?? null, currency: rel.currency ?? 'THB',
        memo: `Cash-flow hedge OCI reclassification ${rel.hedgeNo} ${asOf} — ${amount} to ${reclassTarget}`, createdBy: user.username, lines,
      });
      entryNo = je?.entry_no ?? null;
    }
    const released = gainReserve ? -amount : amount; // reduce the reserve toward zero
    const newReserve = round2(reserve + released);
    await db.update(hedgeRelationships).set({ ociReserve: String(newReserve) }).where(eq(hedgeRelationships.id, id));
    await db.insert(hedgeOciMovements).values({
      tenantId: rel.tenantId ?? null, relationshipId: id, asOf, amount: String(released), plAmount: String(gainReserve ? amount : -amount),
      reclassified: true, entryNo, createdBy: user.username,
    });
    return { hedge_no: rel.hedgeNo, as_of: asOf, reclassified: amount, reclass_account: reclassTarget, oci_reserve: newReserve, entry_no: entryNo };
  }

  // ── Reads ────────────────────────────────────────────────────────────────────────────────────────────────────
  async listHedges(tenantId?: number | null) {
    const db = this.db;
    const tid = this.tenant(tenantId);
    const rows = await db.select().from(hedgeRelationships).where(tid != null ? eq(hedgeRelationships.tenantId, tid) : undefined).orderBy(desc(hedgeRelationships.id));
    return { hedges: rows.map(shapeHedge), count: rows.length };
  }

  async getHedge(id: number) {
    const rel = await this.load(id);
    const db = this.db;
    const [deriv] = await db.select().from(hedgeDerivatives).where(eq(hedgeDerivatives.relationshipId, id)).limit(1);
    const tests = await db.select().from(hedgeEffectivenessTests).where(eq(hedgeEffectivenessTests.relationshipId, id)).orderBy(hedgeEffectivenessTests.id);
    const movements = await db.select().from(hedgeOciMovements).where(eq(hedgeOciMovements.relationshipId, id)).orderBy(hedgeOciMovements.id);
    return {
      ...shapeHedge(rel),
      derivative: deriv ? { notional: n(deriv.notional), fair_value: n(deriv.fairValue), instrument: deriv.instrument } : null,
      effectiveness_tests: tests.map(shapeTest),
      oci_movements: movements.map(shapeMovement),
    };
  }

  private async load(id: number) {
    const db = this.db;
    const [rel] = await db.select().from(hedgeRelationships).where(eq(hedgeRelationships.id, id)).limit(1);
    if (!rel) throw new NotFoundException({ code: 'HEDGE_NOT_FOUND', message: `Hedge relationship ${id} not found`, messageTh: `ไม่พบความสัมพันธ์การป้องกันความเสี่ยง ${id}` });
    return rel;
  }
}

function shapeHedge(h: any) {
  return {
    id: Number(h.id), hedge_no: h.hedgeNo, hedged_item: h.hedgedItem, hedging_instrument: h.hedgingInstrument,
    hedge_type: h.hedgeType, hedge_ratio: n(h.hedgeRatio), notional: n(h.notional), documentation: h.documentation,
    hedged_item_account: h.hedgedItemAccount, reclass_account: h.reclassAccount, currency: h.currency,
    derivative_fv: n(h.derivativeFv), oci_reserve: n(h.ociReserve), basis_adjustment: n(h.basisAdjustment),
    rebalances: Number(h.rebalances), status: h.status, requested_by: h.requestedBy, approved_by: h.approvedBy,
    created_by: h.createdBy,
  };
}
function shapeTest(t: any) {
  return { id: Number(t.id), test_type: t.testType, method: t.method, ratio_pct: n(t.ratioPct), effective: !!t.effective, as_of: t.asOf, notes: t.notes };
}
function shapeMovement(m: any) {
  return { id: Number(m.id), as_of: m.asOf, amount: n(m.amount), pl_amount: n(m.plAmount), reclassified: !!m.reclassified, entry_no: m.entryNo };
}
