import { Inject, Injectable } from '@nestjs/common';
import { eq, and, sql, asc, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { customerInventory, replenishmentSuggestions } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { ProcurementService } from '../procurement/procurement.service';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// Min-max replenishment over tenant-scoped customer_inventory: suggest when on_hand <= reorder_point,
// qty = reorder_qty. Suggested rows convert to ONE consolidated PR via ProcurementService.createPr.
@Injectable()
export class ReplenishmentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly procurement: ProcurementService,
  ) {}

  private urgency(onHand: number, rop: number): string {
    if (onHand <= 0) return 'critical';
    if (onHand <= rop * 0.5) return 'warning';
    return 'ok';
  }

  // recompute Suggested rows from current stock (PR_Created/Dismissed rows are terminal, left intact)
  async suggest(user: JwtUser, _limit = 50) {
    const db = this.db as any;
    const tenantId = user.tenantId as number;
    const rows = await db.select().from(customerInventory).where(eq(customerInventory.tenantId, tenantId)).orderBy(asc(customerInventory.itemId));
    const candidates = rows.filter((r: any) => n(r.reorderPoint) > 0 && n(r.currentStock) <= n(r.reorderPoint));
    // drop prior open suggestions for this tenant; rebuild from current state (idempotent)
    await db.delete(replenishmentSuggestions).where(and(eq(replenishmentSuggestions.tenantId, tenantId), eq(replenishmentSuggestions.status, 'Suggested')));
    const out: any[] = [];
    for (const r of candidates) {
      const onHand = n(r.currentStock), rop = n(r.reorderPoint), qty = n(r.reorderQty);
      if (qty <= 0) continue; // nothing to order
      const suggestionNo = await this.docNo.nextDaily('RPL');
      await db.insert(replenishmentSuggestions).values({ tenantId, suggestionNo, itemId: r.itemId, onHand: String(onHand), reorderPoint: String(rop), suggestedQty: String(qty), urgency: this.urgency(onHand, rop), status: 'Suggested' });
      out.push({ suggestion_no: suggestionNo, item_id: r.itemId, on_hand: onHand, reorder_point: rop, suggested_qty: qty, urgency: this.urgency(onHand, rop) });
    }
    return { suggestions: out, count: out.length };
  }

  async list(user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(replenishmentSuggestions).where(eq(replenishmentSuggestions.tenantId, user.tenantId as number)).orderBy(asc(replenishmentSuggestions.itemId));
    return { suggestions: rows.map((r: any) => ({ suggestion_no: r.suggestionNo, item_id: r.itemId, on_hand: n(r.onHand), reorder_point: n(r.reorderPoint), suggested_qty: n(r.suggestedQty), urgency: r.urgency, status: r.status, pr_no: r.prNo })) };
  }

  // turn all Suggested rows into one consolidated PR; stamp them PR_Created (idempotent — terminal rows skip)
  async autoPr(dto: { item_ids?: string[] }, user: JwtUser) {
    const db = this.db as any;
    const tenantId = user.tenantId as number;
    let q = and(eq(replenishmentSuggestions.tenantId, tenantId), eq(replenishmentSuggestions.status, 'Suggested'));
    const rows = await db.select().from(replenishmentSuggestions).where(q);
    const picked = (dto.item_ids?.length ? rows.filter((r: any) => dto.item_ids!.includes(r.itemId)) : rows).filter((r: any) => n(r.suggestedQty) > 0);
    if (!picked.length) return { pr_no: null, lines: 0 };
    const pr = await this.procurement.createPr({ items: picked.map((r: any) => ({ item_id: r.itemId, request_qty: n(r.suggestedQty), reason: 'Auto-replenishment' })) } as any, user);
    await db.update(replenishmentSuggestions).set({ status: 'PR_Created', prNo: pr.pr_no }).where(inArray(replenishmentSuggestions.id, picked.map((r: any) => Number(r.id))));
    return { pr_no: pr.pr_no, lines: picked.length };
  }
}
