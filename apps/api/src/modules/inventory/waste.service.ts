import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { wasteLog, customerInventory, custStockLog, invBalances, menuRecipes, menuRecipeLines } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { n, fx } from '../../database/queries';
import { round2, roundCurrency } from '../tax/money';
import type { JwtUser } from '../../common/decorators';

// WHY it was wasted (reason). void_fire = a cancelled/voided fired KDS ticket line whose recipe ingredients
// were already prepped/cooked and are written off.
const WASTE_REASONS = ['damage', 'expiry', 'spoilage', 'overproduction', 'prep_error', 'void_fire', 'other'] as const;
export type WasteReason = typeof WASTE_REASONS[number];
// WHAT happened to the wasted stock (disposition) — FA-style reason coding, distinct from the WHY.
const DISPOSITIONS = ['discard', 'compost', 'donate', 'staff_meal', 'rework', 'return_supplier'] as const;
export type WasteDisposition = typeof DISPOSITIONS[number];
const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;
// gross raw-consumption divisor (same formula as recipe.service.ts / food-cost.service.ts): edible qty_per
// ÷ (yield_factor − waste_factor). Guard: non-positive divisor → 1.0.
const grossDiv = (yieldFactor: any, wasteFactor: any) => {
  const ef = (Number(yieldFactor ?? 1) || 1) - (Number(wasteFactor ?? 0) || 0);
  return ef > 0 ? ef : 1;
};

export interface LogWasteDto {
  item_id: string;
  qty: number;
  reason_code: WasteReason;
  disposition?: WasteDisposition;   // default 'discard'
  unit_cost?: number;        // when given (and > 0), the waste is costed to GL (Dr 5810 / Cr 1200)
  uom?: string;
  branch_id?: number;
  ref_doc?: string;
  notes?: string;
}
export interface VoidFireDto {
  sku: string;               // the voided fired menu item
  qty: number;               // number of dishes voided
  reason_code?: WasteReason; // default 'void_fire'
  disposition?: WasteDisposition; // default 'discard'
  branch_id?: number;
  ref_doc?: string;          // the voided ticket / sale no
  notes?: string;
}
export interface ListWasteDto { from?: string; to?: string; reason?: string; disposition?: string }
export interface WasteVarianceDto { from?: string; to?: string; branch_id?: number }

// W1 — Waste / spoilage logging (control INV-10). Kitchen logs reason-coded ingredient waste; it decrements
// customer_inventory and (when a unit cost is given) posts Dr 5810 Scrap/Waste Loss / Cr 1200 Inventory —
// mirroring recipe COGS, which credits 1200 on consumption. Perpetual-tracked items (an inv_balances row)
// are NOT wasted here — they must go through the INV-07 maker-checker write-off (no GL double-handling).
//
// POS-5a (INV-15) extends this ONE ledger (not a parallel one) with: a reason + disposition taxonomy,
// void-fired-item capture (voidFire — a cancelled fired ticket explodes its recipe to ingredient waste),
// and a theoretical-vs-actual usage-variance report (recipe COGS deduction vs actual depletion).
@Injectable()
export class WasteService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * @param opts.wasteNo  Reuse an EXISTING document number instead of minting one — used by the
   *   store-hub replay (`POST /api/hub/ingest-waste`, BRANCH-06) so the hub's `WASTE-…` number is the
   *   same on both ledgers. Idempotent: a waste_no already present for the tenant returns the stored
   *   row untouched (`duplicate: true`), so a re-push can never decrement stock or post GL twice.
   */
  async logWaste(dto: LogWasteDto, user: JwtUser, opts?: { wasteNo?: string }) {
    const db = this.db;
    const tenantId = user.tenantId ?? null;
    if (opts?.wasteNo) {
      const [seen] = await db.select().from(wasteLog).where(and(eq(wasteLog.tenantId, tenantId!), eq(wasteLog.wasteNo, opts.wasteNo))).limit(1);
      if (seen) return { waste_no: seen.wasteNo, item_id: seen.itemId, qty: n(seen.qty), reason_code: seen.reasonCode, total_cost: n(seen.totalCost), journal_no: seen.journalNo, stock_after: null, duplicate: true as const };
    }
    if (n(dto.qty) <= 0) throw new BadRequestException({ code: 'BAD_QTY', message: 'qty must be positive', messageTh: 'จำนวนต้องมากกว่าศูนย์' });
    if (!WASTE_REASONS.includes(dto.reason_code)) throw new BadRequestException({ code: 'BAD_REASON', message: 'invalid reason_code', messageTh: 'เหตุผลไม่ถูกต้อง' });
    const disposition = dto.disposition ?? 'discard';
    if (!DISPOSITIONS.includes(disposition)) throw new BadRequestException({ code: 'BAD_DISPOSITION', message: 'invalid disposition', messageTh: 'ปลายทางของเสียไม่ถูกต้อง' });
    // Guard: a perpetual-tracked item (valued sub-ledger) must use the INV-07 write-off, never the waste log,
    // so inventory value isn't decremented twice / off-control.
    const [perp] = await db.select({ id: invBalances.id }).from(invBalances).where(and(eq(invBalances.tenantId, tenantId!), eq(invBalances.itemId, dto.item_id))).limit(1);
    if (perp) throw new BadRequestException({ code: 'USE_WRITEOFF', message: 'This item is perpetual-tracked — record shrinkage via the inventory write-off (INV-07), not the waste log', messageTh: 'สินค้านี้ใช้บัญชีสต๊อกถาวร — ให้ตัดผ่านการตัดสต๊อก (อนุมัติ) แทน' });

    const qty = round2(n(dto.qty));
    const unitCost = roundCurrency(Math.max(0, n(dto.unit_cost)), 'THB');
    const totalCost = roundCurrency(qty * unitCost, 'THB');
    const wasteNo = opts?.wasteNo ?? await this.docNo.nextDaily('WASTE');

    return await db.transaction(async (tx: any) => {
      const after = await this.deductIngredient(tx, tenantId, dto.item_id, qty, dto.uom ?? null, dto.branch_id ?? null, dto.reason_code, wasteNo, user);
      const journalNo = totalCost > 0 ? await this.costToGl(tx, tenantId, wasteNo, dto.item_id, dto.reason_code, totalCost, user) : null;
      await tx.insert(wasteLog).values({
        tenantId, branchId: dto.branch_id ?? null, wasteNo, itemId: dto.item_id, itemDescription: after.itemDescription,
        qty: fx(qty, 4), uom: dto.uom ?? after.uom ?? null, reasonCode: dto.reason_code, disposition, source: 'manual', refDoc: dto.ref_doc ?? null,
        unitCost: fx(unitCost, 4), totalCost: fx(totalCost, 4), notes: dto.notes ?? null, journalNo, loggedBy: user.username,
      });
      return { waste_no: wasteNo, item_id: dto.item_id, qty, reason_code: dto.reason_code, disposition, total_cost: totalCost, journal_no: journalNo, stock_after: after.balance };
    });
  }

  // POS-5a — void-fired-item capture. A cancelled/voided fired ticket line was already prepped/cooked, so its
  // recipe ingredients are wasted: explode the recipe, write each ingredient to THIS waste ledger (reason
  // void_fire), decrement the ingredient stock, and post ONE aggregated Dr 5810 / Cr 1200 for the batch.
  async voidFire(dto: VoidFireDto, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId ?? null;
    const dishes = round2(n(dto.qty));
    if (dishes <= 0) throw new BadRequestException({ code: 'BAD_QTY', message: 'qty must be positive', messageTh: 'จำนวนต้องมากกว่าศูนย์' });
    const reason = dto.reason_code ?? 'void_fire';
    if (!WASTE_REASONS.includes(reason)) throw new BadRequestException({ code: 'BAD_REASON', message: 'invalid reason_code', messageTh: 'เหตุผลไม่ถูกต้อง' });
    const disposition = dto.disposition ?? 'discard';
    if (!DISPOSITIONS.includes(disposition)) throw new BadRequestException({ code: 'BAD_DISPOSITION', message: 'invalid disposition', messageTh: 'ปลายทางของเสียไม่ถูกต้อง' });

    // explode the recipe (tenant-scoped explicitly; an HQ/Admin checkout runs app.bypass_rls='on').
    const [rec] = await db.select().from(menuRecipes).where(and(eq(menuRecipes.tenantId, tenantId!), eq(menuRecipes.sku, dto.sku), eq(menuRecipes.active, true))).limit(1);
    if (!rec) throw new BadRequestException({ code: 'NO_RECIPE', message: `No active recipe for ${dto.sku}`, messageTh: 'ไม่พบสูตรอาหารที่ใช้งานอยู่' });
    const lines = await db.select().from(menuRecipeLines).where(eq(menuRecipeLines.recipeId, Number(rec.id)));
    if (!lines.length) throw new BadRequestException({ code: 'NO_RECIPE_LINES', message: `Recipe ${dto.sku} has no ingredient lines`, messageTh: 'สูตรอาหารไม่มีรายการวัตถุดิบ' });
    const yld = Math.max(n(rec.yieldQty), 1);
    const wasteNo = await this.docNo.nextDaily('WASTE');

    return await db.transaction(async (tx: any) => {
      const ingredients: any[] = [];
      let totalCost = 0;
      for (const l of lines) {
        const qty = round4((n(l.qtyPer) / grossDiv(l.yieldFactor, l.wasteFactor) / yld) * dishes);
        if (qty <= 0) continue;
        const unitCost = roundCurrency(n(l.unitCost), 'THB');
        const lineCost = roundCurrency(qty * unitCost, 'THB');
        const after = await this.deductIngredient(tx, tenantId, l.ingredientItemId, qty, l.uom ?? null, dto.branch_id ?? null, reason, wasteNo, user, l.ingredientDescription ?? null);
        await tx.insert(wasteLog).values({
          tenantId, branchId: dto.branch_id ?? null, wasteNo, itemId: l.ingredientItemId, itemDescription: after.itemDescription,
          qty: fx(qty, 4), uom: l.uom ?? after.uom ?? null, reasonCode: reason, disposition, source: 'void_fire', refDoc: dto.ref_doc ?? null,
          unitCost: fx(unitCost, 4), totalCost: fx(lineCost, 4), notes: dto.notes ?? `void ${dto.sku}`, journalNo: null, loggedBy: user.username,
        });
        totalCost = roundCurrency(totalCost + lineCost, 'THB');
        ingredients.push({ item_id: l.ingredientItemId, qty, unit_cost: unitCost, total_cost: lineCost, stock_after: after.balance });
      }
      // one aggregated GL posting for the whole voided dish (mirrors recipe COGS).
      const journalNo = totalCost > 0 ? await this.costToGl(tx, tenantId, wasteNo, dto.sku, `void_fire ${dto.sku}`, totalCost, user) : null;
      if (journalNo) await tx.update(wasteLog).set({ journalNo }).where(and(eq(wasteLog.tenantId, tenantId!), eq(wasteLog.wasteNo, wasteNo)));
      return { waste_no: wasteNo, sku: dto.sku, dishes, reason_code: reason, disposition, total_cost: totalCost, journal_no: journalNo, lines: ingredients.length, ingredients };
    });
  }

  // shared ingredient decrement (mirrors recipe applyDeduction; allows negative + logs a 'Waste' stock move).
  private async deductIngredient(tx: any, tenantId: number | null, itemId: string, qty: number, uom: string | null, branchId: number | null, reason: string, wasteNo: string, user: JwtUser, desc: string | null = null) {
    let [inv] = await tx.select().from(customerInventory).where(and(eq(customerInventory.tenantId, tenantId!), eq(customerInventory.itemId, itemId))).for('update').limit(1);
    if (!inv) [inv] = await tx.insert(customerInventory).values({ tenantId, itemId, itemDescription: desc ?? itemId, uom: uom ?? null, currentStock: '0' }).returning();
    const balance = round4(n(inv.currentStock) - qty);
    await tx.update(customerInventory).set({ currentStock: String(balance), lastUpdated: new Date() }).where(eq(customerInventory.id, inv.id));
    await tx.insert(custStockLog).values({ tenantId, branchId, itemId, itemDescription: inv.itemDescription ?? desc ?? itemId, logDate: new Date(), logType: 'Waste', qtyChange: String(-qty), balanceAfter: String(balance), refDoc: wasteNo, notes: reason, createdBy: user.username });
    return { balance, itemDescription: inv.itemDescription ?? desc ?? itemId, uom: inv.uom ?? uom ?? null };
  }

  // cost the waste to GL — Dr 5810 Scrap/Waste Loss / Cr 1200 Inventory (idempotent per WASTE- doc).
  private async costToGl(tx: any, tenantId: number | null, wasteNo: string, itemRef: string, reason: string, totalCost: number, user: JwtUser): Promise<string | null> {
    if (await this.ledger.alreadyPosted('WASTE', wasteNo, tenantId, tx)) return null;
    const je: any = await this.ledger.postEntry({ source: 'WASTE', sourceRef: wasteNo, tenantId, memo: `Waste ${wasteNo} ${itemRef} (${reason})`, createdBy: user.username, lines: [{ account_code: '5810', debit: totalCost }, { account_code: '1200', credit: totalCost }] }, tx);
    return je?.entry_no ?? null;
  }

  async list(dto: ListWasteDto, user: JwtUser) {
    const db = this.db;
    const conds = [eq(wasteLog.tenantId, user.tenantId as number)];
    if (dto.reason) conds.push(eq(wasteLog.reasonCode, dto.reason));
    if (dto.disposition) conds.push(eq(wasteLog.disposition, dto.disposition));
    if (dto.from) conds.push(gte(wasteLog.createdAt, new Date(dto.from + 'T00:00:00.000Z')));
    if (dto.to) conds.push(lte(wasteLog.createdAt, new Date(dto.to + 'T23:59:59.999Z')));
    const rows = await db.select().from(wasteLog).where(and(...conds)).orderBy(desc(wasteLog.createdAt)).limit(500);
    const byReason: Record<string, { qty: number; cost: number; count: number }> = {};
    const byDisposition: Record<string, { qty: number; cost: number; count: number }> = {};
    let totalCost = 0, totalQty = 0;
    for (const r of rows) {
      const k = r.reasonCode;
      byReason[k] = byReason[k] ?? { qty: 0, cost: 0, count: 0 };
      byReason[k].qty = round2(byReason[k].qty + n(r.qty));
      byReason[k].cost = round2(byReason[k].cost + n(r.totalCost));
      byReason[k].count++;
      const d = r.disposition ?? 'discard';
      byDisposition[d] = byDisposition[d] ?? { qty: 0, cost: 0, count: 0 };
      byDisposition[d].qty = round2(byDisposition[d].qty + n(r.qty));
      byDisposition[d].cost = round2(byDisposition[d].cost + n(r.totalCost));
      byDisposition[d].count++;
      totalCost = round2(totalCost + n(r.totalCost));
      totalQty = round2(totalQty + n(r.qty));
    }
    return {
      waste: rows.map((r: any) => ({ waste_no: r.wasteNo, item_id: r.itemId, item_description: r.itemDescription, qty: n(r.qty), uom: r.uom, reason_code: r.reasonCode, disposition: r.disposition ?? 'discard', source: r.source, ref_doc: r.refDoc, unit_cost: n(r.unitCost), total_cost: n(r.totalCost), notes: r.notes, journal_no: r.journalNo, logged_by: r.loggedBy, created_at: r.createdAt })),
      count: rows.length, total_qty: totalQty, total_cost: totalCost,
      by_reason: Object.entries(byReason).map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.cost - a.cost),
      by_disposition: Object.entries(byDisposition).map(([disposition, v]) => ({ disposition, ...v })).sort((a, b) => b.cost - a.cost),
    };
  }

  // POS-5a (INV-15) — theoretical-vs-actual USAGE variance (recipe COGS vs actual depletion). Closes the loop
  // between the food-cost recipe theoretical (cust_stock_log 'Consume' rows written by the recipe deduction on
  // every sale) and the ACTUAL depletion (theoretical + logged waste). Per ingredient it shows the waste-
  // explained gap between what the recipe SAID should have been used and what actually left stock, valued at
  // cost, so a manager sees the baht impact and % of the kitchen's usage that is waste — actionable by reason.
  async usageVariance(dto: WasteVarianceDto, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId as number;
    const conds = [eq(custStockLog.tenantId, tenantId)];
    if (dto.branch_id != null) conds.push(eq(custStockLog.branchId, dto.branch_id));
    if (dto.from) conds.push(gte(custStockLog.logDate, new Date(dto.from + 'T00:00:00.000Z')));
    if (dto.to) conds.push(lte(custStockLog.logDate, new Date(dto.to + 'T23:59:59.999Z')));
    const logs = await db.select().from(custStockLog).where(and(...conds));

    // unit cost per ingredient from the waste ledger (first costed row), tenant-scoped.
    const wl = await db.select({ itemId: wasteLog.itemId, unitCost: wasteLog.unitCost }).from(wasteLog).where(eq(wasteLog.tenantId, tenantId));
    const costByItem = new Map<string, number>();
    for (const w of wl) { const k = String(w.itemId); if (!costByItem.has(k) && n(w.unitCost) > 0) costByItem.set(k, n(w.unitCost)); }

    const byItem = new Map<string, { item_id: string; description: string | null; theoretical_use: number; waste_use: number }>();
    for (const l of logs) {
      const t = String(l.logType ?? '');
      if (t !== 'Consume' && t !== 'Waste') continue;
      const k = String(l.itemId);
      const e = byItem.get(k) ?? { item_id: k, description: l.itemDescription ?? null, theoretical_use: 0, waste_use: 0 };
      const mag = Math.abs(n(l.qtyChange));
      if (t === 'Consume') e.theoretical_use = round4(e.theoretical_use + mag);
      else e.waste_use = round4(e.waste_use + mag);
      byItem.set(k, e);
    }
    const items = [...byItem.values()].map((e) => {
      const unit_cost = costByItem.get(e.item_id) ?? 0;
      const actual_use = round4(e.theoretical_use + e.waste_use);
      const variance_qty = e.waste_use; // the depletion beyond recipe theoretical that the waste ledger explains
      const theoretical_cost = round2(e.theoretical_use * unit_cost);
      const actual_cost = round2(actual_use * unit_cost);
      const variance_cost = round2(variance_qty * unit_cost);
      const variance_pct = e.theoretical_use !== 0 ? round2((variance_qty / e.theoretical_use) * 100) : (variance_qty > 0 ? 100 : 0);
      return { item_id: e.item_id, description: e.description, unit_cost, theoretical_use: e.theoretical_use, waste_use: e.waste_use, actual_use, variance_qty, theoretical_cost, actual_cost, variance_cost, variance_pct, anomaly: variance_pct >= 10 ? 'High' : variance_pct >= 5 ? 'Medium' : 'Normal' };
    }).sort((a, b) => b.variance_cost - a.variance_cost);

    const theoreticalCost = round2(items.reduce((a, i) => a + i.theoretical_cost, 0));
    const actualCost = round2(items.reduce((a, i) => a + i.actual_cost, 0));
    const varianceCost = round2(items.reduce((a, i) => a + i.variance_cost, 0));
    return {
      from: dto.from ?? null, to: dto.to ?? null,
      summary: {
        items: items.length,
        theoretical_cost: theoreticalCost,
        actual_cost: actualCost,
        variance_cost: varianceCost,                        // + = waste-explained usage above recipe theoretical
        variance_pct: theoreticalCost !== 0 ? round2((varianceCost / theoreticalCost) * 100) : 0,
        anomalies: items.filter((i) => i.anomaly !== 'Normal').length,
      },
      items,
    };
  }
}
