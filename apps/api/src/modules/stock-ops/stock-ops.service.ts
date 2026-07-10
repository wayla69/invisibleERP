import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { stocktakes, stockMovements } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { InventoryLedgerService } from '../inventory/inventory-ledger.service';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

export interface StocktakeLine { item_id: string; item_description?: string; uom?: string; system_qty?: number; physical_qty: number }
export interface IssueLine { item_id: string; item_description?: string; uom?: string; qty: number }

// Stocktake (count→variance→ST doc) + manual goods issue / inter-location transfer.
// Follows the V1 audit model: stock_movements is an append-only log; it does NOT
// alter stock_snapshots (current stock stays snapshot-derived). stocktakes/stock_movements
// are global audit tables (no tenant_id), matching the existing schema.
//
// Perpetual-valued bridge: when an item is under perpetual valuation (it has an inv_balances row,
// established by a valued goods-receipt), the same stock-ops action ALSO posts a valued move through
// the perpetual sub-ledger (COGS/variance GL + balance update). Legacy snapshot-only items are
// unaffected — they keep the audit-only path. This is additive; the audit movement always records.
@Injectable()
export class StockOpsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly invLedger: InventoryLedgerService,
  ) {}

  // ── Stocktake ────────────────────────────────────────────────────────────
  // 0299: stocktakes/stock_movements gained a tenant_id. RLS now scopes them, but every query threads an
  // explicit tenant too — a write path must never depend on RLS alone (and an HQ/god bypass session would
  // otherwise read or post across tenants by document number).
  private tid(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'User is not bound to a tenant', messageTh: 'ผู้ใช้ไม่ได้ผูกกับร้าน/บริษัท' });
    return Number(user.tenantId);
  }

  async createStocktake(dto: { counted_by?: string; remarks?: string; lines: StocktakeLine[] }, user: JwtUser) {
    if (!dto.lines?.length) throw new BadRequestException({ code: 'NO_LINES', message: 'No count lines', messageTh: 'ไม่มีรายการนับ' });
    const db = this.db;
    const tenantId = this.tid(user);
    const stNo = await this.docNo.nextDaily('ST');
    const stDate = ymd();
    const counter = dto.counted_by || user.username;
    const rows = dto.lines.map((l) => {
      const sys = n(l.system_qty);
      const phys = n(l.physical_qty);
      return {
        tenantId, stNo, stDate, itemId: l.item_id, itemDescription: l.item_description ?? null, uom: l.uom ?? null,
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
    const db = this.db;
    const tenantId = this.tid(user);
    const res = await db.transaction(async (tx: any) => {
      const lines = await tx.select().from(stocktakes).where(and(eq(stocktakes.tenantId, tenantId), eq(stocktakes.stNo, stNo)));
      if (!lines.length) throw new NotFoundException({ code: 'NOT_FOUND', message: `Stocktake ${stNo} not found`, messageTh: 'ไม่พบใบนับสต๊อก' });
      if (lines.every((l: any) => l.status === 'Posted')) return { already: true, lines, movements: 0 };
      // INV-04 — variance review maker-checker (SoD R11): the person who COUNTED may not post/approve their
      // own count, so the variance is independently reviewed before it adjusts stock + GL. The poster IS the
      // approver; the audit_log records them. (Posting is permission-gated at the controller.)
      const counter = lines[0]?.countedBy;
      if (counter && counter === user.username) {
        throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'The counter cannot approve/post their own stocktake — an independent reviewer must post the variance', messageTh: 'ผู้นับสต๊อกไม่สามารถอนุมัติ/โพสต์ใบนับของตนเองได้ (ต้องมีผู้ตรวจทานอิสระ)' });
      }
      const now = new Date();
      let movements = 0;
      for (const l of lines) {
        const diff = n(l.difference);
        if (diff !== 0) {
          await tx.insert(stockMovements).values({ tenantId,
            moveDate: now, docNo: stNo, moveType: diff > 0 ? 'Stock In' : 'Stock Out',
            itemId: l.itemId, itemDescription: l.itemDescription, uom: l.uom, qty: String(Math.abs(diff)),
            fromLocation: diff > 0 ? 'Count Adj' : 'Warehouse', toLocation: diff > 0 ? 'Warehouse' : 'Count Adj',
            refDoc: stNo, remarks: 'Stocktake variance', createdBy: user.username,
          });
          movements++;
        }
      }
      await tx.update(stocktakes).set({ status: 'Posted', postedBy: user.username, postedAt: new Date() }).where(and(eq(stocktakes.tenantId, tenantId), eq(stocktakes.stNo, stNo)));
      return { already: false, lines, movements };
    });
    if (res.already) return { st_no: stNo, status: 'Posted', already: true };
    // Perpetual-valued variance: for tracked items, bring valued on-hand to the counted qty + book the
    // value variance to GL (no-op for legacy snapshot-only items). Runs in the same request transaction.
    let valued = 0;
    for (const l of res.lines) {
      const r = await this.invLedger.postCountVariance({ item_id: l.itemId, physical_qty: n(l.physicalQty), doc_no: stNo }, user);
      if (r.valued) valued++;
    }
    return { st_no: stNo, status: 'Posted', variance_movements: res.movements, valued_lines: valued };
  }

  /**
   * Store-hub replay of a POSTED count sheet (control BRANCH-07, docs/41 Phase 2c-2).
   *
   * The hub already ran the R11 maker-checker with two real humans; the cloud posts as the machine
   * principal `hub-sync`, which would silently erase that evidence. So the document must NAME both
   * humans and the cloud REFUSES it when they are the same person (`STOCKTAKE_NOT_SEGREGATED`) — the
   * replay can never launder a self-approved count into the central ledger. Both names are persisted
   * (`counted_by` / `posted_by`, 0304) so the segregation is evidenced on either ledger.
   *
   * Idempotent on (tenant, st_no): a re-push returns the stored document and creates no second movement.
   * Variance movements are created exactly as a native post creates them.
   */
  async ingestHubStocktake(doc: { st_no: string; st_date: string; counted_by: string; posted_by: string; remarks?: string; lines: { item_id: string; item_description?: string; uom?: string; system_qty: number; physical_qty: number }[] }, tenantId: number) {
    if (!doc.lines?.length) throw new BadRequestException({ code: 'NO_LINES', message: 'No count lines', messageTh: 'ไม่มีรายการนับ' });
    if (!doc.counted_by || !doc.posted_by) throw new BadRequestException({ code: 'STOCKTAKE_NOT_SEGREGATED', message: 'A replayed stocktake must name both the counter and the poster', messageTh: 'ใบนับที่ส่งเข้าระบบต้องระบุทั้งผู้นับและผู้โพสต์' });
    if (doc.counted_by === doc.posted_by) throw new ForbiddenException({ code: 'STOCKTAKE_NOT_SEGREGATED', message: 'The counter cannot be the poster — SoD R11 (the hub must have an independent reviewer)', messageTh: 'ผู้นับกับผู้โพสต์ต้องเป็นคนละคน (SoD R11)' });

    const db = this.db;
    const existing = await db.select().from(stocktakes).where(and(eq(stocktakes.tenantId, tenantId), eq(stocktakes.stNo, doc.st_no))).limit(1);
    if (existing.length) return { st_no: doc.st_no, status: 'Posted', duplicate: true as const, movements: 0 };

    return await db.transaction(async (tx: any) => {
      const now = new Date();
      let movements = 0;
      for (const l of doc.lines) {
        const sys = n(l.system_qty), phys = n(l.physical_qty);
        const diff = round2(phys - sys);
        await tx.insert(stocktakes).values({
          tenantId, stNo: doc.st_no, stDate: doc.st_date, itemId: l.item_id, itemDescription: l.item_description ?? null,
          uom: l.uom ?? null, systemQty: String(sys), physicalQty: String(phys), difference: String(diff),
          countedBy: doc.counted_by, postedBy: doc.posted_by, postedAt: now, status: 'Posted' as const, remarks: doc.remarks ?? null,
        });
        if (diff !== 0) {
          await tx.insert(stockMovements).values({
            tenantId, moveDate: now, docNo: doc.st_no, moveType: diff > 0 ? 'Stock In' : 'Stock Out',
            itemId: l.item_id, itemDescription: l.item_description ?? null, uom: l.uom ?? null, qty: String(Math.abs(diff)),
            fromLocation: diff > 0 ? 'Count Adj' : 'Warehouse', toLocation: diff > 0 ? 'Warehouse' : 'Count Adj',
            refDoc: doc.st_no, remarks: 'Stocktake variance (hub replay)', createdBy: doc.posted_by,
          });
          movements++;
        }
      }
      return { st_no: doc.st_no, status: 'Posted', duplicate: false as const, movements };
    });
  }

  async listStocktakes(limit = 50, user?: JwtUser) {
    const db = this.db;
    const rows = user
      ? await db.select().from(stocktakes).where(eq(stocktakes.tenantId, this.tid(user))).orderBy(desc(stocktakes.id)).limit(2000)
      : await db.select().from(stocktakes).orderBy(desc(stocktakes.id)).limit(2000);
    // group by st_no (doc-level summary)
    const byDoc = new Map<string, any>();
    for (const r of rows) {
      const k = r.stNo!;
      if (!byDoc.has(k)) byDoc.set(k, { st_no: k, st_date: r.stDate, counted_by: r.countedBy, status: r.status, lines: 0, variance_lines: 0 });
      const g = byDoc.get(k);
      g.lines++;
      if (n(r.difference) !== 0) g.variance_lines++;
    }
    return { stocktakes: [...byDoc.values()].slice(0, limit), count: byDoc.size };
  }

  async getStocktake(stNo: string, user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(stocktakes).where(and(eq(stocktakes.tenantId, this.tid(user)), eq(stocktakes.stNo, stNo)));
    if (!rows.length) throw new NotFoundException({ code: 'NOT_FOUND', message: `Stocktake ${stNo} not found`, messageTh: 'ไม่พบใบนับสต๊อก' });
    return {
      st_no: stNo, st_date: rows[0]!.stDate, counted_by: rows[0]!.countedBy, status: rows[0]!.status,
      lines: rows.map((r: any) => ({ item_id: r.itemId, item_description: r.itemDescription, uom: r.uom, system_qty: n(r.systemQty), physical_qty: n(r.physicalQty), difference: n(r.difference) })),
    };
  }

  // ── Goods issue / inter-location transfer (audit movements) ───────────────
  async goodsIssue(dto: { ref_doc?: string; from_location?: string; remarks?: string; lines: IssueLine[] }, user: JwtUser) {
    if (!dto.lines?.length) throw new BadRequestException({ code: 'NO_LINES', message: 'No items', messageTh: 'ไม่มีรายการ' });
    const db = this.db;
    const tenantId = this.tid(user);
    const docNo = await this.docNo.nextDaily('MI');
    const now = new Date();
    for (const l of dto.lines) {
      // Issue stored as a negative qty (consistent with WMS pick) — audit only, snapshot unchanged.
      await db.insert(stockMovements).values({ tenantId,
        moveDate: now, docNo, moveType: 'Issue', itemId: l.item_id, itemDescription: l.item_description ?? null,
        uom: l.uom ?? null, qty: String(-Math.abs(n(l.qty))), fromLocation: dto.from_location ?? 'Warehouse',
        toLocation: 'Issued', refDoc: dto.ref_doc ?? null, remarks: dto.remarks ?? null, createdBy: user.username,
      });
    }
    // Tracked items also relieve valued stock + book COGS (Dr 5000 / Cr 1200) at moving-average.
    let valued = 0;
    for (const l of dto.lines) {
      const r = await this.invLedger.issueIfTracked({ item_id: l.item_id, location_id: dto.from_location ?? 'WH-MAIN', qty: n(l.qty) }, user);
      if (r.valued) valued++;
    }
    return { doc_no: docNo, move_type: 'Issue', lines: dto.lines.length, valued_lines: valued };
  }

  async transfer(dto: { ref_doc?: string; from_location: string; to_location: string; remarks?: string; lines: IssueLine[] }, user: JwtUser) {
    if (!dto.lines?.length) throw new BadRequestException({ code: 'NO_LINES', message: 'No items', messageTh: 'ไม่มีรายการ' });
    if (dto.from_location === dto.to_location) throw new BadRequestException({ code: 'SAME_LOCATION', message: 'From and To must differ', messageTh: 'ต้นทาง/ปลายทางต้องต่างกัน' });
    const db = this.db;
    const tenantId = this.tid(user);
    const docNo = this.docNo.nextStamped('TRF');
    const now = new Date();
    for (const l of dto.lines) {
      await db.insert(stockMovements).values({ tenantId,
        moveDate: now, docNo, moveType: 'Transfer', itemId: l.item_id, itemDescription: l.item_description ?? null,
        uom: l.uom ?? null, qty: String(Math.abs(n(l.qty))), fromLocation: dto.from_location, toLocation: dto.to_location,
        refDoc: dto.ref_doc ?? null, remarks: dto.remarks ?? null, createdBy: user.username,
      });
    }
    // Tracked items also move qty + value between the two locations at average cost (value-neutral, no GL).
    let valued = 0;
    for (const l of dto.lines) {
      const r = await this.invLedger.transferIfTracked({ item_id: l.item_id, from_location: dto.from_location, to_location: dto.to_location, qty: n(l.qty) }, user);
      if (r.valued) valued++;
    }
    return { doc_no: docNo, move_type: 'Transfer', lines: dto.lines.length, valued_lines: valued };
  }

  async listMovements(q: { move_type?: string; limit?: number }, user?: JwtUser) {
    const db = this.db;
    const conds: any[] = [];
    if (user) conds.push(eq(stockMovements.tenantId, this.tid(user)));
    if (q.move_type) conds.push(eq(stockMovements.moveType, q.move_type as NonNullable<typeof stockMovements.$inferSelect.moveType>));
    const where = conds.length ? and(...conds) : undefined;
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
