import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { priceBooks, priceBookEntries } from '../../database/schema';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';

export interface PriceBookDto {
  id?: number; name: string; tier?: string | null; branch_id?: number | null;
  currency?: string; priority?: number; valid_from?: string | null; valid_to?: string | null;
}
export interface PriceBookEntryDto { item_id: string; unit_price: number; min_qty?: number }
export interface ResolveCtx { tier?: string | null; branchId?: number | null; at?: string; qtyByItem?: Map<string, number> }

// docs/52 Phase 4a — price-book engine. A governed, approved base-price list the POS/quote draws from,
// resolved by CUSTOMER TIER and/or BRANCH before the promo engine (PricingService) discounts. Maker-checker
// (staged PendingApproval + inactive; a DIFFERENT user activates — mirrors the price-rule G6 gate); the sale
// path reads only active/approved books. Its own bounded sub-service within the pricing context.
@Injectable()
export class PriceBookService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ── CRUD ─────────────────────────────────────────────────────────────────────
  async listBooks() {
    const db = this.db;
    const rows = await db.select().from(priceBooks).orderBy(priceBooks.priority, desc(priceBooks.id));
    return { books: rows.map(mapBook), count: rows.length };
  }
  async listPending() {
    const db = this.db;
    const rows = await db.select().from(priceBooks).where(eq(priceBooks.status, 'PendingApproval')).orderBy(desc(priceBooks.id)).limit(200);
    return { books: rows.map(mapBook), count: rows.length };
  }
  async getBook(id: number) {
    const db = this.db;
    const [b] = await db.select().from(priceBooks).where(eq(priceBooks.id, id)).limit(1);
    if (!b) throw new NotFoundException({ code: 'NOT_FOUND', message: `Price book ${id} not found`, messageTh: 'ไม่พบสมุดราคา' });
    const entries = await db.select().from(priceBookEntries).where(eq(priceBookEntries.priceBookId, id)).orderBy(priceBookEntries.itemId, priceBookEntries.minQty);
    return { ...mapBook(b), entries: entries.map(mapEntry) };
  }

  // A new/changed book is STAGED PendingApproval + inactive (the sale path reads only Active), so a base
  // price cannot go live without a second sign-off. Editing metadata re-stages it too.
  async upsertBook(dto: PriceBookDto, user: JwtUser) {
    const db = this.db;
    const vals = {
      tenantId: user.tenantId ?? null, name: dto.name, tier: dto.tier ?? null,
      branchId: dto.branch_id != null ? Number(dto.branch_id) : null, currency: dto.currency ?? 'THB',
      priority: dto.priority ?? 100, active: false, status: 'PendingApproval',
      validFrom: dto.valid_from ?? null, validTo: dto.valid_to ?? null,
    };
    if (dto.id) {
      await db.update(priceBooks).set({ ...vals, createdBy: user.username, approvedBy: null, approvedAt: null }).where(eq(priceBooks.id, dto.id));
      return { id: dto.id, updated: true, status: 'PendingApproval', pending: true };
    }
    const [r] = await db.insert(priceBooks).values({ ...vals, createdBy: user.username }).returning({ id: priceBooks.id });
    return { id: r!.id, created: true, status: 'PendingApproval', pending: true };
  }

  // Replace a book's price entries. A changed price re-stages the book (inactive/PendingApproval) — it cannot
  // go live at the till without a second sign-off either.
  async setEntries(bookId: number, entries: PriceBookEntryDto[], user: JwtUser) {
    const db = this.db;
    const [b] = await db.select().from(priceBooks).where(eq(priceBooks.id, bookId)).limit(1);
    if (!b) throw new NotFoundException({ code: 'NOT_FOUND', message: `Price book ${bookId} not found`, messageTh: 'ไม่พบสมุดราคา' });
    for (const e of entries) {
      if (!(n(e.unit_price) >= 0)) throw new BadRequestException({ code: 'BAD_PRICE', message: 'Unit price must be ≥ 0', messageTh: 'ราคาต่อหน่วยต้องไม่ติดลบ' });
      if ((e.min_qty ?? 1) < 1) throw new BadRequestException({ code: 'BAD_MIN_QTY', message: 'min_qty must be ≥ 1', messageTh: 'จำนวนขั้นต่ำต้องอย่างน้อย 1' });
    }
    await db.delete(priceBookEntries).where(eq(priceBookEntries.priceBookId, bookId));
    for (const e of entries)
      await db.insert(priceBookEntries).values({ tenantId: b.tenantId ?? null, priceBookId: bookId, itemId: String(e.item_id), unitPrice: String(e.unit_price), minQty: e.min_qty ?? 1 });
    await db.update(priceBooks).set({ active: false, status: 'PendingApproval', createdBy: user.username, approvedBy: null, approvedAt: null }).where(eq(priceBooks.id, bookId));
    return { book_id: bookId, entries: entries.length, status: 'PendingApproval', pending: true };
  }

  // Approve a staged book — a DIFFERENT user than the author activates it (self-approval → SOD_VIOLATION).
  async approveBook(id: number, user: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const [b] = await db.select().from(priceBooks).where(eq(priceBooks.id, id)).limit(1);
    if (!b) throw new NotFoundException({ code: 'NOT_FOUND', message: `Price book ${id} not found`, messageTh: 'ไม่พบสมุดราคา' });
    if (b.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Book ${id} is ${b.status}, not pending approval`, messageTh: 'สมุดราคานี้ไม่ได้รออนุมัติ' });
    await assertMakerChecker(db, { user, maker: b.createdBy, event: 'price.book.approve', ref: String(id), reason: selfApprovalReason, code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve a price book you created', messageTh: 'ผู้สร้างสมุดราคาอนุมัติเองไม่ได้ (แบ่งแยกหน้าที่)' });
    await db.update(priceBooks).set({ active: true, status: 'Active', approvedBy: user.username, approvedAt: new Date() }).where(eq(priceBooks.id, id));
    return { id, status: 'Active', active: true, approved_by: user.username, created_by: b.createdBy };
  }
  async rejectBook(id: number, user: JwtUser, reason?: string) {
    const db = this.db;
    const [b] = await db.select().from(priceBooks).where(eq(priceBooks.id, id)).limit(1);
    if (!b) throw new NotFoundException({ code: 'NOT_FOUND', message: `Price book ${id} not found`, messageTh: 'ไม่พบสมุดราคา' });
    if (b.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Book ${id} is ${b.status}, not pending approval`, messageTh: 'สมุดราคานี้ไม่ได้รออนุมัติ' });
    await db.update(priceBooks).set({ active: false, status: 'Rejected', approvedBy: user.username, approvedAt: new Date() }).where(eq(priceBooks.id, id));
    return { id, status: 'Rejected', rejected_by: user.username, reason: reason ?? null };
  }
  async deleteBook(id: number) {
    const db = this.db;
    await this.db.delete(priceBookEntries).where(eq(priceBookEntries.priceBookId, id));
    await db.delete(priceBooks).where(eq(priceBooks.id, id));
    return { id, deleted: true };
  }

  // ── Resolution (read by the sale path + the /book-price endpoint) ──────────────
  // Resolve the governed base price for each item under a (tier, branch) context. Only ACTIVE, approved books
  // whose tier/branch/validity match are considered; a book with tier/branch = NULL is a wildcard. When several
  // books match, precedence is priority (lower first) → specificity (tier+branch match) → id (newest). Within a
  // book the highest min_qty ≤ the sold qty wins. Returns only items that a book actually prices (others keep
  // their client price → byte-identical). Tenant filter is explicit (belt-and-suspenders over RLS).
  async resolvePriceMany(tenantId: number, itemIds: string[], ctx: ResolveCtx): Promise<Map<string, { unit_price: number; book_id: number; book_name: string }>> {
    const out = new Map<string, { unit_price: number; book_id: number; book_name: string }>();
    const ids = [...new Set(itemIds.map(String))];
    if (!ids.length) return out;
    const db = this.db;
    const today = ymd(ctx.at ? new Date(ctx.at) : new Date());
    const all = await db.select().from(priceBooks).where(and(eq(priceBooks.tenantId, tenantId), eq(priceBooks.active, true), eq(priceBooks.status, 'Active')));
    const candidates = all
      .filter((b: any) => (b.tier == null || b.tier === (ctx.tier ?? null))
        && (b.branchId == null || Number(b.branchId) === (ctx.branchId ?? null))
        && (b.validFrom == null || String(b.validFrom) <= today)
        && (b.validTo == null || String(b.validTo) >= today))
      .sort((a: any, b: any) => (a.priority ?? 100) - (b.priority ?? 100) || specificity(b) - specificity(a) || Number(b.id) - Number(a.id));
    if (!candidates.length) return out;
    const bookIds = candidates.map((b: any) => Number(b.id));
    const entries = await db.select().from(priceBookEntries).where(and(eq(priceBookEntries.tenantId, tenantId), inArray(priceBookEntries.priceBookId, bookIds), inArray(priceBookEntries.itemId, ids)));
    // book id → (item → sorted entries by min_qty desc)
    const byBookItem = new Map<number, Map<string, { unitPrice: number; minQty: number }[]>>();
    for (const e of entries) {
      const bm = byBookItem.get(Number(e.priceBookId)) ?? new Map();
      const arr = bm.get(String(e.itemId)) ?? [];
      arr.push({ unitPrice: n(e.unitPrice), minQty: Number(e.minQty ?? 1) });
      bm.set(String(e.itemId), arr);
      byBookItem.set(Number(e.priceBookId), bm);
    }
    for (const itemId of ids) {
      const qty = ctx.qtyByItem?.get(itemId) ?? 1;
      for (const b of candidates) {
        const arr = byBookItem.get(Number(b.id))?.get(itemId);
        if (!arr?.length) continue;
        const pick = arr.filter((x) => x.minQty <= qty).sort((x, y) => y.minQty - x.minQty)[0];
        if (!pick) continue;
        out.set(itemId, { unit_price: pick.unitPrice, book_id: Number(b.id), book_name: String(b.name) });
        break; // first (highest-precedence) book that prices this item wins
      }
    }
    return out;
  }

  // Single-item lookup for the till/quote UI to display the governed price.
  async bookPrice(tenantId: number, itemId: string, ctx: ResolveCtx) {
    const m = await this.resolvePriceMany(tenantId, [itemId], { ...ctx, qtyByItem: new Map([[String(itemId), ctx.qtyByItem?.get(String(itemId)) ?? 1]]) });
    const hit = m.get(String(itemId));
    return { item_id: String(itemId), price: hit?.unit_price ?? null, book_id: hit?.book_id ?? null, book_name: hit?.book_name ?? null };
  }
}

function specificity(b: any): number { return (b.tier != null ? 1 : 0) + (b.branchId != null ? 1 : 0); }
function mapBook(b: any) {
  return { id: b.id, name: b.name, tier: b.tier ?? null, branch_id: b.branchId != null ? Number(b.branchId) : null, currency: b.currency ?? 'THB', priority: b.priority ?? 100, active: !!b.active, status: b.status ?? 'PendingApproval', valid_from: b.validFrom ?? null, valid_to: b.validTo ?? null, created_by: b.createdBy ?? null, approved_by: b.approvedBy ?? null };
}
function mapEntry(e: any) { return { item_id: e.itemId, unit_price: n(e.unitPrice), min_qty: Number(e.minQty ?? 1) }; }
