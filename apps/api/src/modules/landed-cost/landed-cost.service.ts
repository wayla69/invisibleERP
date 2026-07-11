import { Inject, Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { landedCostVouchers, landedCostAllocations, invBalances, invCostLayers, invMoves } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import { n, fx, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const r4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;
const EPS = 1e-6;
const bad = (code: string, message: string, messageTh: string) => new BadRequestException({ code, message, messageTh });

type Basis = 'value' | 'qty' | 'weight';
const BASES: Basis[] = ['value', 'qty', 'weight'];

export interface LandedChargeDto { freight?: number; duty?: number; insurance?: number; broker?: number }
export interface LandedLineDto { gr_no?: string; item_id: string; location_id?: string; qty: number; weight?: number; base_value?: number }
export interface CreateLandedCostDto { voucher_date?: string; basis?: Basis; currency?: string; charges?: LandedChargeDto; memo?: string; lines: LandedLineDto[] }

// INV-1 — Landed-cost allocation (COST-01). A landed-cost voucher attaches freight / duty / insurance /
// broker charges to posted goods receipts and apportions them into inventory unit cost (basis: value / qty /
// weight). On post, the STILL-ON-HAND share of each line's charge is capitalised into the perpetual
// sub-ledger (raises moving-average / open FIFO cost layers so future issues carry the loaded cost, Dr 1200)
// and the ALREADY-ISSUED residual is expensed to the costing variance account (Dr 5500 — mirroring how
// costing.service handles STD-costing PPV; issued qty is never retroactively re-costed), crediting the
// landed-cost accrual liability (2010). Post is maker-checker: the poster must differ from the preparer.
@Injectable()
export class LandedCostService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly ledger: LedgerService) {}

  private tenant(user: JwtUser): number {
    if (user.tenantId == null) throw bad('NO_TENANT', 'A tenant context is required', 'ต้องอยู่ในบริบทผู้เช่า');
    return user.tenantId;
  }

  private mkNo(): string {
    return `LCV-${ymd().replace(/-/g, '')}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  }

  // The per-line apportionment basis value for the chosen basis.
  private basisOf(basis: Basis, l: { qty: number; weight: number; baseValue: number }): number {
    return basis === 'qty' ? l.qty : basis === 'weight' ? l.weight : l.baseValue;
  }

  // Apportion total charges across the lines by basis, 2-dp, with the rounding remainder pinned to the last
  // line so Σ(alloc) === totalCharges exactly (same plug technique as costing.postReceiptGl).
  private apportion(basis: Basis, totalCharges: number, lines: { qty: number; weight: number; baseValue: number }[]): number[] {
    const bases = lines.map((l) => this.basisOf(basis, l));
    const sum = bases.reduce((a, b) => a + b, 0);
    if (!(sum > EPS)) throw bad('ALLOC_BASIS_ZERO', `Allocation basis '${basis}' sums to zero across the lines`, `ฐานปันส่วน '${basis}' รวมเป็นศูนย์ — ปันส่วนไม่ได้`);
    const total = r2(totalCharges);
    const out: number[] = new Array(lines.length).fill(0);
    let running = 0;
    for (let i = 0; i < lines.length; i++) {
      if (i === lines.length - 1) out[i] = r2(total - running);
      else { out[i] = r2((total * bases[i]!) / sum); running = r2(running + out[i]!); }
    }
    return out;
  }

  private chargeTotal(c: LandedChargeDto): number {
    return r2(n(c.freight) + n(c.duty) + n(c.insurance) + n(c.broker));
  }

  // ── Create a Draft voucher + its allocation target lines. base_value defaults to qty × current avg cost. ──
  async create(dto: CreateLandedCostDto, user: JwtUser) {
    const tenantId = this.tenant(user);
    const basis: Basis = dto.basis ?? 'value';
    if (!BASES.includes(basis)) throw bad('BAD_BASIS', `basis must be one of ${BASES.join('/')}`, 'ฐานปันส่วนไม่ถูกต้อง');
    if (!dto.lines?.length) throw bad('NO_LINES', 'At least one allocation line is required', 'ต้องมีรายการปันส่วนอย่างน้อยหนึ่งรายการ');
    const charges = dto.charges ?? {};
    const total = this.chargeTotal(charges);
    if (!(total > 0)) throw bad('NO_CHARGES', 'Total landed charges must be greater than zero', 'ยอดต้นทุนแฝงต้องมากกว่าศูนย์');
    const voucherNo = this.mkNo();
    const date = dto.voucher_date ?? ymd();

    const lineRows: { grNo: string | null; itemId: string; locationId: string; qty: number; weight: number; baseValue: number }[] = [];
    for (const l of dto.lines) {
      const qty = r4(l.qty);
      if (!(qty > 0)) throw bad('BAD_QTY', `qty must be > 0 for ${l.item_id}`, 'จำนวนต้องมากกว่าศูนย์');
      const loc = l.location_id || 'WH-MAIN';
      const bal = await this.balanceRow(tenantId, l.item_id, loc);
      const baseValue = l.base_value != null ? r2(l.base_value) : r2(qty * n(bal?.avgCost));
      lineRows.push({ grNo: l.gr_no ?? null, itemId: l.item_id, locationId: loc, qty, weight: r4(l.weight ?? 0), baseValue });
    }

    await this.db.insert(landedCostVouchers).values({
      tenantId, voucherNo, voucherDate: date, basis, currency: dto.currency ?? 'THB',
      freight: fx(n(charges.freight), 2), duty: fx(n(charges.duty), 2), insurance: fx(n(charges.insurance), 2), broker: fx(n(charges.broker), 2),
      totalCharges: fx(total, 2), accrualAccount: postingDefault('LANDEDCOST.CAPITALIZE', 'accrual'), status: 'Draft',
      memo: dto.memo ?? null, preparedBy: user.username,
    });
    // Preview the apportionment so the created rows carry alloc_amount immediately.
    const allocs = this.apportion(basis, total, lineRows);
    for (let i = 0; i < lineRows.length; i++) {
      const lr = lineRows[i]!;
      await this.db.insert(landedCostAllocations).values({
        tenantId, voucherNo, grNo: lr.grNo, itemId: lr.itemId, locationId: lr.locationId,
        qty: fx(lr.qty, 4), weight: fx(lr.weight, 4), baseValue: fx(lr.baseValue, 2), allocAmount: fx(allocs[i]!, 2),
      });
    }
    return this.get(user, voucherNo);
  }

  private async balanceRow(tenantId: number, itemId: string, locationId: string) {
    const [b] = await this.db.select().from(invBalances)
      .where(and(eq(invBalances.tenantId, tenantId), eq(invBalances.itemId, itemId), eq(invBalances.locationId, locationId))).limit(1);
    return b ?? null;
  }

  // ── Preview apportionment (no GL) — recompute from stored lines + charges; persist alloc_amount. Draft only. ──
  async allocate(voucherNo: string, user: JwtUser) {
    const tenantId = this.tenant(user);
    const v = await this.header(tenantId, voucherNo);
    if (v.status !== 'Draft') throw bad('NOT_DRAFT', `Voucher ${voucherNo} is ${v.status}; only a Draft can be re-allocated`, 'ปันส่วนได้เฉพาะใบที่เป็นแบบร่างเท่านั้น');
    const lines = await this.lines(tenantId, voucherNo);
    const lr = lines.map((l: any) => ({ qty: n(l.qty), weight: n(l.weight), baseValue: n(l.baseValue) }));
    const allocs = this.apportion(v.basis as Basis, n(v.totalCharges), lr);
    const preview: any[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l: any = lines[i];
      await this.db.update(landedCostAllocations).set({ allocAmount: fx(allocs[i]!, 2) }).where(eq(landedCostAllocations.id, Number(l.id)));
      preview.push({ item_id: l.itemId, gr_no: l.grNo, location_id: l.locationId, basis_value: n(this.basisOf(v.basis as Basis, lr[i]!)), alloc_amount: allocs[i]! });
    }
    const allocated = r2(allocs.reduce((a, b) => a + b, 0));
    return { voucher_no: voucherNo, basis: v.basis, total_charges: n(v.totalCharges), allocated, ties: Math.abs(allocated - n(v.totalCharges)) < 0.01, lines: preview };
  }

  // ── Post — maker-checker; capitalise on-hand share into the sub-ledger, expense the issued residual, book GL. ──
  async post(voucherNo: string, user: JwtUser) {
    const tenantId = this.tenant(user);
    const v = await this.header(tenantId, voucherNo);
    if (v.status === 'Posted') throw bad('ALREADY_POSTED', `Voucher ${voucherNo} is already posted`, 'ใบนี้ผ่านรายการแล้ว');
    if (v.status !== 'Draft') throw bad('NOT_DRAFT', `Voucher ${voucherNo} is ${v.status}`, 'ผ่านรายการได้เฉพาะใบที่เป็นแบบร่าง');
    // Maker-checker (SoD): the poster must differ from the preparer.
    if (v.preparedBy && v.preparedBy === user.username)
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot post a landed-cost voucher you prepared', messageTh: 'ผู้จัดทำผ่านรายการใบต้นทุนแฝงของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });

    const lines = await this.lines(tenantId, voucherNo);
    const total = n(v.totalCharges);
    const lr = lines.map((l: any) => ({ qty: n(l.qty), weight: n(l.weight), baseValue: n(l.baseValue) }));
    const allocs = this.apportion(v.basis as Basis, total, lr);

    let capTotal = 0, varTotal = 0;
    const date = v.voucherDate ?? ymd();
    for (let i = 0; i < lines.length; i++) {
      const l: any = lines[i];
      const alloc = allocs[i]!;
      const bal = await this.balanceRow(tenantId, l.itemId, l.locationId);
      if (!bal) throw bad('LANDED_UNTRACKED', `Item ${l.itemId} @ ${l.locationId} is not tracked by the perpetual inventory sub-ledger; receive it via /api/inventory/receipts before capitalising landed cost`, 'สินค้านี้ยังไม่ถูกติดตามใน perpetual sub-ledger — รับเข้าคลังก่อนจึงจะปันต้นทุนแฝงได้');
      const received = n(l.qty), onHand = n(bal.onHandQty);
      const onHandShare = received > EPS ? Math.min(onHand, received) / received : 0;
      const capitalized = r2(alloc * onHandShare);
      const variance = r2(alloc - capitalized);
      if (capitalized > EPS) await this.applyCapitalization(tenantId, bal, capitalized, voucherNo, date, user.username);
      await this.db.update(landedCostAllocations).set({ allocAmount: fx(alloc, 2), capitalizedAmount: fx(capitalized, 2), varianceAmount: fx(variance, 2) }).where(eq(landedCostAllocations.id, Number(l.id)));
      capTotal = r2(capTotal + capitalized);
      varTotal = r2(varTotal + variance);
    }

    // GL: Dr 1200 (capitalised on-hand share) + Dr 5500 (issued residual, mirrors PPV) / Cr accrual (2010).
    const glLines = [
      ...(capTotal > EPS ? [{ account_code: '1200', debit: capTotal, memo: `Landed cost ${voucherNo}` }] : []),
      ...(varTotal > EPS ? [{ account_code: postingDefault('LANDEDCOST.CAPITALIZE', 'variance'), debit: varTotal, memo: `Landed-cost variance ${voucherNo}` }] : []),
      { account_code: v.accrualAccount || postingDefault('LANDEDCOST.CAPITALIZE', 'accrual'), credit: total },
    ];
    const je = await this.ledger.postEntry({
      date, source: 'INV-LC', sourceRef: voucherNo, tenantId, viaSubledger: true,
      memo: `Landed-cost capitalisation ${voucherNo}`, createdBy: user.username, lines: glLines,
    });

    await this.db.update(landedCostVouchers).set({
      status: 'Posted', postedBy: user.username, postedAt: new Date(),
      capitalizedTotal: fx(capTotal, 2), varianceTotal: fx(varTotal, 2), glEntryNo: je?.entry_no ?? null,
    }).where(and(eq(landedCostVouchers.tenantId, tenantId), eq(landedCostVouchers.voucherNo, voucherNo)));

    return { voucher_no: voucherNo, status: 'Posted', posted_by: user.username, prepared_by: v.preparedBy, total_charges: total, capitalized_total: capTotal, variance_total: varTotal, gl_entry_no: je?.entry_no ?? null };
  }

  // Raise the item's perpetual value by `capitalized`: bump moving-average total value (and, for fifo/fefo,
  // spread it across the open cost layers pro-rata so future consumption carries the loaded cost). Writes an
  // inv_moves audit row (qty 0, value-only) linked to the voucher + JE.
  private async applyCapitalization(tenantId: number, bal: any, capitalized: number, voucherNo: string, date: string, by: string) {
    const onHand = n(bal.onHandQty);
    const method = (bal.costingMethod as string) ?? 'moving_avg';
    const newVal = r4(n(bal.totalValue) + capitalized);
    const newAvg = onHand > EPS ? r4(newVal / onHand) : n(bal.avgCost);
    if (method === 'fifo' || method === 'fefo') {
      const layers = await this.db.select().from(invCostLayers)
        .where(and(eq(invCostLayers.tenantId, tenantId), eq(invCostLayers.itemId, bal.itemId), eq(invCostLayers.locationId, bal.locationId), sql`${invCostLayers.remainingQty} > 0`))
        .orderBy(asc(invCostLayers.id));
      const openQty = layers.reduce((a: number, l: any) => a + n(l.remainingQty), 0);
      if (openQty > EPS) {
        let running = 0;
        for (let i = 0; i < layers.length; i++) {
          const lay: any = layers[i];
          const rem = n(lay.remainingQty);
          const share = i === layers.length - 1 ? r4(capitalized - running) : r4((capitalized * rem) / openQty);
          running = r4(running + share);
          const bumped = r4(n(lay.unitCost) + share / rem);
          await this.db.update(invCostLayers).set({ unitCost: fx(bumped, 4) }).where(eq(invCostLayers.id, Number(lay.id)));
        }
      }
    }
    await this.db.update(invBalances).set({ totalValue: fx(newVal, 4), avgCost: fx(newAvg, 4), updatedAt: new Date() }).where(eq(invBalances.id, Number(bal.id)));
    await this.db.insert(invMoves).values({
      tenantId, moveNo: `${voucherNo}-${bal.itemId}`, moveType: 'landed_cost', itemId: bal.itemId, itemDescription: bal.itemDescription,
      locationId: bal.locationId, qty: '0', unitCost: fx(newAvg, 4), totalCost: fx(capitalized, 4), balanceQty: fx(onHand, 4), avgCost: fx(newAvg, 4),
      // refId is per-line (inv_moves_ref_uniq is UNIQUE on tenant_id/ref_type/ref_id — a voucher may touch
      // several items, so each capitalisation move needs a distinct ref).
      refType: 'LCV', refId: `${voucherNo}:${bal.itemId}:${bal.locationId}`, reason: 'Landed-cost capitalisation', createdBy: by,
    });
  }

  private async header(tenantId: number, voucherNo: string) {
    const [v] = await this.db.select().from(landedCostVouchers)
      .where(and(eq(landedCostVouchers.tenantId, tenantId), eq(landedCostVouchers.voucherNo, voucherNo))).limit(1);
    if (!v) throw new NotFoundException({ code: 'VOUCHER_NOT_FOUND', message: `Landed-cost voucher ${voucherNo} not found`, messageTh: 'ไม่พบใบต้นทุนแฝง' });
    return v;
  }

  private async lines(tenantId: number, voucherNo: string) {
    return this.db.select().from(landedCostAllocations)
      .where(and(eq(landedCostAllocations.tenantId, tenantId), eq(landedCostAllocations.voucherNo, voucherNo))).orderBy(asc(landedCostAllocations.id));
  }

  // ── Read: single voucher (with allocations) or the tenant's voucher list ──
  async get(user: JwtUser, voucherNo?: string) {
    const tenantId = this.tenant(user);
    if (voucherNo) {
      const v = await this.header(tenantId, voucherNo);
      const lines = await this.lines(tenantId, voucherNo);
      return { voucher: this.mapHeader(v), allocations: lines.map((l: any) => this.mapLine(l)) };
    }
    const rows = await this.db.select().from(landedCostVouchers).where(eq(landedCostVouchers.tenantId, tenantId)).orderBy(desc(landedCostVouchers.id)).limit(200);
    return { vouchers: rows.map((v: any) => this.mapHeader(v)), count: rows.length };
  }

  private mapHeader(v: any) {
    return {
      voucher_no: v.voucherNo, voucher_date: v.voucherDate, basis: v.basis, currency: v.currency,
      freight: n(v.freight), duty: n(v.duty), insurance: n(v.insurance), broker: n(v.broker), total_charges: n(v.totalCharges),
      accrual_account: v.accrualAccount, status: v.status, memo: v.memo,
      capitalized_total: n(v.capitalizedTotal), variance_total: n(v.varianceTotal),
      prepared_by: v.preparedBy, posted_by: v.postedBy, gl_entry_no: v.glEntryNo,
    };
  }
  private mapLine(l: any) {
    return { gr_no: l.grNo, item_id: l.itemId, location_id: l.locationId, qty: n(l.qty), weight: n(l.weight), base_value: n(l.baseValue), alloc_amount: n(l.allocAmount), capitalized_amount: n(l.capitalizedAmount), variance_amount: n(l.varianceAmount) };
  }
}
