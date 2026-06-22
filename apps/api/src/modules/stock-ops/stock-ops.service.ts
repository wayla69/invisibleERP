import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { stocktakes, stockMovements } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

export interface StocktakeLine { item_id: string; item_description?: string; uom?: string; system_qty?: number; physical_qty: number }
export interface IssueLine { item_id: string; item_description?: string; uom?: string; qty: number }

// Stocktake (count→variance→ST doc) + manual goods issue / inter-location transfer.
// Follows the V1 audit model: stock_movements is an append-only log; it does NOT
// alter stock_snapshots (current stock stays snapshot-derived). stocktakes/stock_movements
// are global audit tables (no tenant_id), matching the existing schema.
@Injectable()
export class StockOpsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

  // ── Stocktake ────────────────────────────────────────────────────────────
  async createStocktake(dto: { counted_by?: string; remarks?: string; lines: StocktakeLine[] }, user: JwtUser) {
    if (!dto.lines?.length) throw new BadRequestException({ code: 'NO_LINES', message: 'No count lines', messageTh: 'ไม่มีรายการนับ' });
    const db = this.db as any;
    const stNo = await this.docNo.nextDaily('ST');
    const stDate = ymd();
    const counter = dto.counted_by || user.username;
    const rows = dto.lines.map((l) => {
      const sys = n(l.system_qty);
      const phys = n(l.physical_qty);
      return {
        stNo, stDate, itemId: l.item_id, itemDescription: l.item_description ?? null, uom: l.uom ?? null,
        systemQty: String(sys), physicalQty: String(phys), difference: String(round2(phys - sys)),
        countedBy: counter, status: 'Draft' as const, remarks: dto.remarks ?? null,
      };
    });
    await db.insert(stocktakes).values(rows);
    const variance = rows.filter((r) => Number(r.difference) !== 0).length;
    return { st_no: stNo, st_date: stDate, lines: rows.length, variance_lines: variance, status: 'Draft' };
  }

  // Post a Draft stocktake → status Posted + an audit movement per non-zero variance line
  // (Stock In if counted high, Stock Out if counted low). Idempotent: re-posting is a no-op.
  async postStocktake(stNo: string, user: JwtUser) {
    const db = this.db as any;
    return db.transaction(async (tx: any) => {
      const lines = await tx.select().from(stocktakes).where(eq(stocktakes.stNo, stNo));
      if (!lines.length) throw new NotFoundException({ code: 'NOT_FOUND', message: `Stocktake ${stNo} not found`, messageTh: 'ไม่พบใบนับสต๊อก' });
      if (lines.every((l: any) => l.status === 'Posted')) return { st_no: stNo, status: 'Posted', already: true };
      const now = new Date();
      let movements = 0;
      for (const l of lines) {
        const diff = n(l.difference);
        if (diff !== 0) {
          await tx.insert(stockMovements).values({
            moveDate: now, docNo: stNo, moveType: diff > 0 ? 'Stock In' : 'Stock Out',
            itemId: l.itemId, itemDescription: l.itemDescription, uom: l.uom, qty: String(Math.abs(diff)),
            fromLocation: diff > 0 ? 'Count Adj' : 'Warehouse', toLocation: diff > 0 ? 'Warehouse' : 'Count Adj',
            refDoc: stNo, remarks: 'Stocktake variance', createdBy: user.username,
          });
          movements++;
        }
      }
      await tx.update(stocktakes).set({ status: 'Posted' }).where(eq(stocktakes.stNo, stNo));
      return { st_no: stNo, status: 'Posted', variance_movements: movements };
    });
  }

  async listStocktakes(limit = 50) {
    const db = this.db as any;
    const rows = await db.select().from(stocktakes).orderBy(desc(stocktakes.id)).limit(2000);
    // group by st_no (doc-level summary)
    const byDoc = new Map<string, any>();
    for (const r of rows) {
      const k = r.stNo;
      if (!byDoc.has(k)) byDoc.set(k, { st_no: k, st_date: r.stDate, counted_by: r.countedBy, status: r.status, lines: 0, variance_lines: 0 });
      const g = byDoc.get(k);
      g.lines++;
      if (n(r.difference) !== 0) g.variance_lines++;
    }
    return { stocktakes: [...byDoc.values()].slice(0, limit), count: byDoc.size };
  }

  async getStocktake(stNo: string) {
    const db = this.db as any;
    const rows = await db.select().from(stocktakes).where(eq(stocktakes.stNo, stNo));
    if (!rows.length) throw new NotFoundException({ code: 'NOT_FOUND', message: `Stocktake ${stNo} not found`, messageTh: 'ไม่พบใบนับสต๊อก' });
    return {
      st_no: stNo, st_date: rows[0].stDate, counted_by: rows[0].countedBy, status: rows[0].status,
      lines: rows.map((r: any) => ({ item_id: r.itemId, item_description: r.itemDescription, uom: r.uom, system_qty: n(r.systemQty), physical_qty: n(r.physicalQty), difference: n(r.difference) })),
    };
  }

  // ── Goods issue / inter-location transfer (audit movements) ───────────────
  async goodsIssue(dto: { ref_doc?: string; from_location?: string; remarks?: string; lines: IssueLine[] }, user: JwtUser) {
    if (!dto.lines?.length) throw new BadRequestException({ code: 'NO_LINES', message: 'No items', messageTh: 'ไม่มีรายการ' });
    const db = this.db as any;
    const docNo = await this.docNo.nextDaily('MI');
    const now = new Date();
    for (const l of dto.lines) {
      // Issue stored as a negative qty (consistent with WMS pick) — audit only, snapshot unchanged.
      await db.insert(stockMovements).values({
        moveDate: now, docNo, moveType: 'Issue', itemId: l.item_id, itemDescription: l.item_description ?? null,
        uom: l.uom ?? null, qty: String(-Math.abs(n(l.qty))), fromLocation: dto.from_location ?? 'Warehouse',
        toLocation: 'Issued', refDoc: dto.ref_doc ?? null, remarks: dto.remarks ?? null, createdBy: user.username,
      });
    }
    return { doc_no: docNo, move_type: 'Issue', lines: dto.lines.length };
  }

  async transfer(dto: { ref_doc?: string; from_location: string; to_location: string; remarks?: string; lines: IssueLine[] }, user: JwtUser) {
    if (!dto.lines?.length) throw new BadRequestException({ code: 'NO_LINES', message: 'No items', messageTh: 'ไม่มีรายการ' });
    if (dto.from_location === dto.to_location) throw new BadRequestException({ code: 'SAME_LOCATION', message: 'From and To must differ', messageTh: 'ต้นทาง/ปลายทางต้องต่างกัน' });
    const db = this.db as any;
    const docNo = this.docNo.nextStamped('TRF');
    const now = new Date();
    for (const l of dto.lines) {
      await db.insert(stockMovements).values({
        moveDate: now, docNo, moveType: 'Transfer', itemId: l.item_id, itemDescription: l.item_description ?? null,
        uom: l.uom ?? null, qty: String(Math.abs(n(l.qty))), fromLocation: dto.from_location, toLocation: dto.to_location,
        refDoc: dto.ref_doc ?? null, remarks: dto.remarks ?? null, createdBy: user.username,
      });
    }
    return { doc_no: docNo, move_type: 'Transfer', lines: dto.lines.length };
  }

  async listMovements(q: { move_type?: string; limit?: number }) {
    const db = this.db as any;
    const where = q.move_type ? eq(stockMovements.moveType, q.move_type as any) : undefined;
    const rows = await db.select().from(stockMovements).where(where).orderBy(desc(stockMovements.id)).limit(q.limit ?? 100);
    return {
      movements: rows.map((r: any) => ({
        doc_no: r.docNo, move_date: r.moveDate, move_type: r.moveType, item_id: r.itemId, item_description: r.itemDescription,
        uom: r.uom, qty: n(r.qty), from_location: r.fromLocation, to_location: r.toLocation, ref_doc: r.refDoc, created_by: r.createdBy,
      })),
      count: rows.length,
    };
  }
}
