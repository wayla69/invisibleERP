import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { wasteLog, customerInventory, custStockLog, invBalances } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { n, fx } from '../../database/queries';
import { round2, roundCurrency } from '../tax/money';
import type { JwtUser } from '../../common/decorators';

const WASTE_REASONS = ['damage', 'expiry', 'spoilage', 'overproduction', 'prep_error', 'other'] as const;
export type WasteReason = typeof WASTE_REASONS[number];

export interface LogWasteDto {
  item_id: string;
  qty: number;
  reason_code: WasteReason;
  unit_cost?: number;        // when given (and > 0), the waste is costed to GL (Dr 5810 / Cr 1200)
  uom?: string;
  branch_id?: number;
  notes?: string;
}
export interface ListWasteDto { from?: string; to?: string; reason?: string }

// W1 — Waste / spoilage logging. Kitchen logs reason-coded ingredient waste; it decrements
// customer_inventory and (when a unit cost is given) posts Dr 5810 Scrap/Waste Loss / Cr 1200 Inventory —
// mirroring recipe COGS, which credits 1200 on consumption. Perpetual-tracked items (an inv_balances row)
// are NOT wasted here — they must go through the INV-07 maker-checker write-off (no GL double-handling).
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
    // Guard: a perpetual-tracked item (valued sub-ledger) must use the INV-07 write-off, never the waste log,
    // so inventory value isn't decremented twice / off-control.
    const [perp] = await db.select({ id: invBalances.id }).from(invBalances).where(and(eq(invBalances.tenantId, tenantId!), eq(invBalances.itemId, dto.item_id))).limit(1);
    if (perp) throw new BadRequestException({ code: 'USE_WRITEOFF', message: 'This item is perpetual-tracked — record shrinkage via the inventory write-off (INV-07), not the waste log', messageTh: 'สินค้านี้ใช้บัญชีสต๊อกถาวร — ให้ตัดผ่านการตัดสต๊อก (อนุมัติ) แทน' });

    const qty = round2(n(dto.qty));
    const unitCost = roundCurrency(Math.max(0, n(dto.unit_cost)), 'THB');
    const totalCost = roundCurrency(qty * unitCost, 'THB');
    const wasteNo = opts?.wasteNo ?? await this.docNo.nextDaily('WASTE');

    return await db.transaction(async (tx: any) => {
      // decrement the ingredient stock under a row lock (mirrors recipe applyDeduction; allows negative + logs).
      let [inv] = await tx.select().from(customerInventory).where(and(eq(customerInventory.tenantId, tenantId!), eq(customerInventory.itemId, dto.item_id))).for('update').limit(1);
      if (!inv) [inv] = await tx.insert(customerInventory).values({ tenantId, itemId: dto.item_id, itemDescription: dto.item_id, uom: dto.uom ?? null, currentStock: '0' }).returning();
      const after = round2(n(inv.currentStock) - qty);
      await tx.update(customerInventory).set({ currentStock: String(after), lastUpdated: new Date() }).where(eq(customerInventory.id, inv.id));
      await tx.insert(custStockLog).values({ tenantId, branchId: dto.branch_id ?? null, itemId: dto.item_id, itemDescription: inv.itemDescription ?? dto.item_id, logDate: new Date(), logType: 'Waste', qtyChange: String(-qty), balanceAfter: String(after), refDoc: wasteNo, notes: dto.reason_code, createdBy: user.username });

      // cost it to GL when a unit cost is supplied — Dr 5810 Scrap/Waste Loss / Cr 1200 Inventory.
      let journalNo: string | null = null;
      if (totalCost > 0 && !(await this.ledger.alreadyPosted('WASTE', wasteNo, tenantId, tx))) {
        const je: any = await this.ledger.postEntry({ source: 'WASTE', sourceRef: wasteNo, tenantId, memo: `Waste ${wasteNo} ${dto.item_id} (${dto.reason_code})`, createdBy: user.username, lines: [{ account_code: '5810', debit: totalCost }, { account_code: '1200', credit: totalCost }] }, tx);
        journalNo = je?.entry_no ?? null;
      }
      await tx.insert(wasteLog).values({
        tenantId, branchId: dto.branch_id ?? null, wasteNo, itemId: dto.item_id, itemDescription: inv.itemDescription ?? dto.item_id,
        qty: fx(qty, 4), uom: dto.uom ?? inv.uom ?? null, reasonCode: dto.reason_code, unitCost: fx(unitCost, 4), totalCost: fx(totalCost, 4),
        notes: dto.notes ?? null, journalNo, loggedBy: user.username,
      });
      return { waste_no: wasteNo, item_id: dto.item_id, qty, reason_code: dto.reason_code, total_cost: totalCost, journal_no: journalNo, stock_after: after };
    });
  }

  async list(dto: ListWasteDto, user: JwtUser) {
    const db = this.db;
    const conds = [eq(wasteLog.tenantId, user.tenantId as number)];
    if (dto.reason) conds.push(eq(wasteLog.reasonCode, dto.reason));
    if (dto.from) conds.push(gte(wasteLog.createdAt, new Date(dto.from + 'T00:00:00.000Z')));
    if (dto.to) conds.push(lte(wasteLog.createdAt, new Date(dto.to + 'T23:59:59.999Z')));
    const rows = await db.select().from(wasteLog).where(and(...conds)).orderBy(desc(wasteLog.createdAt)).limit(500);
    const byReason: Record<string, { qty: number; cost: number; count: number }> = {};
    let totalCost = 0, totalQty = 0;
    for (const r of rows) {
      const k = r.reasonCode;
      byReason[k] = byReason[k] ?? { qty: 0, cost: 0, count: 0 };
      byReason[k].qty = round2(byReason[k].qty + n(r.qty));
      byReason[k].cost = round2(byReason[k].cost + n(r.totalCost));
      byReason[k].count++;
      totalCost = round2(totalCost + n(r.totalCost));
      totalQty = round2(totalQty + n(r.qty));
    }
    return {
      waste: rows.map((r: any) => ({ waste_no: r.wasteNo, item_id: r.itemId, item_description: r.itemDescription, qty: n(r.qty), uom: r.uom, reason_code: r.reasonCode, unit_cost: n(r.unitCost), total_cost: n(r.totalCost), notes: r.notes, journal_no: r.journalNo, logged_by: r.loggedBy, created_at: r.createdAt })),
      count: rows.length, total_qty: totalQty, total_cost: totalCost,
      by_reason: Object.entries(byReason).map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.cost - a.cost),
    };
  }
}
