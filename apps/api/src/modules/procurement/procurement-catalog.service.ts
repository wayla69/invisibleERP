import { NotFoundException, BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { sql, eq, and, desc, asc, isNull, or, ilike, inArray, notInArray, gte, lt } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { purchaseOrders, poItems, vendors, supplierPriceLists, items, itemCategories, itemImages, invBalances } from '../../database/schema';
import { ymd } from '../../database/queries';
import { ImageFetchService } from './image-fetch.service';
import type { JwtUser } from '../../common/decorators';
import { n } from './procurement.shared';

// docs/46 G4 extraction — the CATALOG / SOURCING half of the procurement facade: item + vendor search,
// the shop catalog browse (pr_raise), supplier suggestion + preferred-vendor sourcing, spend insights,
// the low-stock reorder list, and the item-image populate/fetch/store admin tools.
// A plain ctor-body class (NOT DI) built by ProcurementService's constructor (goldenmaster/writeflow
// construct the facade positionally, so deps arrive through it): `imageFetch` may be undefined in a
// direct positional construction — the image endpoints are admin-only and never exercised there.
export class ProcurementCatalogService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly imageFetch: ImageFetchService,
    // supplier screening lives in ProcurementVendorService; the facade wires this closure to it.
    private readonly assertSupplierAllowed: (vendorId: number | null, vendorName: string | null) => Promise<void>,
  ) {}

  // Item-master search — for the PR→PO reconcile step (a free-text PR line name may be misspelt or new).
  // ILIKE on code + description; returns the best candidates so procurement can pick the real item.
  async searchItems(q: string, limit = 8) {
    const kw = (q ?? '').trim().slice(0, 100);
    if (!kw) return { items: [] };
    const rows = await this.db.select({ item_id: items.itemId, item_description: items.itemDescription, uom: items.uom, unit_price: items.unitPrice })
      .from(items).where(or(ilike(items.itemId, `%${kw}%`), ilike(items.itemDescription, `%${kw}%`))).limit(Math.min(Math.max(limit, 1), 25));
    // last purchase price per matched item — the most recent PO line's unit price (buyers reuse it).
    const ids = rows.map((r: any) => r.item_id).filter(Boolean);
    const lastPrice = new Map<string, number>();
    if (ids.length) {
      const pr = await this.db.select({ itemId: poItems.itemId, unitPrice: poItems.unitPrice, id: poItems.id })
        .from(poItems).where(inArray(poItems.itemId, ids)).orderBy(desc(poItems.id));
      for (const p of pr) if (!lastPrice.has(String(p.itemId))) lastPrice.set(String(p.itemId), n(p.unitPrice));
    }
    return { items: rows.map((r: any) => ({ item_id: r.item_id, item_description: r.item_description ?? null, uom: r.uom ?? null, unit_price: n(r.unit_price), last_price: lastPrice.has(r.item_id) ? lastPrice.get(r.item_id)! : null })) };
  }

  // Product catalog for the "shop → basket → requisition" screen (pr_raise). A read-only, PAGINATED browse
  // of the item master for a Grab/Shopee-style grid/list: an infinite-scroll page of items (offset/limit)
  // for the selected category + keyword, plus the FULL category summary (chips stay stable while paging).
  // Category label comes from item_categories (via items.category_id, RLS-scoped to the caller's tenant),
  // falling back to the free-text items.category, then "ไม่ระบุหมวด". `items` is company-wide.
  async catalog(user: JwtUser, opts?: { q?: string; category?: string; barcode?: string; limit?: number; offset?: number }) {
    const db = this.db;
    const kw = (typeof opts?.q === 'string' ? opts.q : '').trim().slice(0, 100);
    const cat = (typeof opts?.category === 'string' ? opts.category : '').trim().slice(0, 100);
    // Exact barcode match (hardware scan-to-add): a scanner types the GTIN/EAN then Enter — resolve the one
    // item whose `barcode` equals it, not a fuzzy name/code search. Composes with q/category via `and()`.
    const bc = (typeof opts?.barcode === 'string' ? opts.barcode : '').trim().slice(0, 64);
    const limit = Math.min(Math.max(opts?.limit ?? 24, 1), 100);
    const offset = Math.max(opts?.offset ?? 0, 0);
    const catLabel = (r: any) => String(r.cat_name_th || r.cat_name || r.free_category || 'ไม่ระบุหมวด');
    const catKey = (r: any) => String(r.cat_code || r.free_category || 'uncategorized');
    const kwWhere = kw ? or(ilike(items.itemId, `%${kw}%`), ilike(items.itemDescription, `%${kw}%`)) : undefined;
    const bcWhere = bc ? eq(items.barcode, bc) : undefined;

    // Category summary (+ per-category totals) — one grouped aggregate over the keyword filter (DB-side
    // count), folded into the derived category key/label. Drives the chip row and the paging total.
    const agg = await db.select({
      cat_code: itemCategories.code, cat_name: itemCategories.name, cat_name_th: itemCategories.nameTh,
      free_category: items.category, n: sql<number>`count(*)`,
    }).from(items).leftJoin(itemCategories, eq(items.categoryId, itemCategories.id))
      .where(and(kwWhere, bcWhere) ?? sql`true`)
      .groupBy(itemCategories.code, itemCategories.name, itemCategories.nameTh, items.category);
    const catMap = new Map<string, { key: string; label: string; count: number }>();
    let totalAll = 0;
    for (const r of agg) {
      const key = catKey(r); const cnt = Number(r.n ?? 0); totalAll += cnt;
      const e = catMap.get(key) ?? { key, label: catLabel(r), count: 0 }; e.count += cnt; catMap.set(key, e);
    }
    const categories = [...catMap.values()].sort((a, b) => a.label.localeCompare(b.label, 'th'));
    const total = cat ? (catMap.get(cat)?.count ?? 0) : totalAll;

    // Selected-category filter on the DERIVED key (real category code, else the free-text value, else the
    // "uncategorized" bucket = no category at all). `and()` ignores undefined, so it composes cleanly with
    // the keyword filter for the page slice (both undefined ⇒ fall back to `true`).
    const catWhere = cat === 'uncategorized'
      ? and(isNull(items.categoryId), or(isNull(items.category), eq(items.category, '')))
      : cat
        ? or(eq(itemCategories.code, cat), and(isNull(items.categoryId), eq(items.category, cat)))
        : undefined;

    const rows = await db.select({
      item_id: items.itemId, item_description: items.itemDescription, uom: items.uom,
      unit_price: items.unitPrice, image_key: items.imageKey,
      free_category: items.category, cat_name: itemCategories.name, cat_name_th: itemCategories.nameTh, cat_code: itemCategories.code,
    }).from(items).leftJoin(itemCategories, eq(items.categoryId, itemCategories.id))
      .where(and(kwWhere, bcWhere, catWhere) ?? sql`true`)
      .orderBy(asc(items.itemDescription), asc(items.itemId)).limit(limit).offset(offset);

    // Per-item context for THIS page only (bounded to `limit`): on-hand across the caller's tenant locations
    // (like lowStock) + the last purchase price (most recent PO line, like searchItems). Both nullable.
    const ids = rows.map((r) => r.item_id).filter(Boolean);
    const onHandMap = new Map<string, number>();
    const lastPriceMap = new Map<string, number>();
    if (ids.length) {
      const bal = await db.select({ itemId: invBalances.itemId, onHand: sql<string>`sum(${invBalances.onHandQty})` })
        .from(invBalances)
        .where(and(inArray(invBalances.itemId, ids), user.tenantId != null ? eq(invBalances.tenantId, user.tenantId) : undefined))
        .groupBy(invBalances.itemId);
      for (const b of bal) onHandMap.set(String(b.itemId), n(b.onHand));
      const pr = await db.select({ itemId: poItems.itemId, unitPrice: poItems.unitPrice, id: poItems.id })
        .from(poItems).where(inArray(poItems.itemId, ids)).orderBy(desc(poItems.id));
      for (const p of pr) if (!lastPriceMap.has(String(p.itemId))) lastPriceMap.set(String(p.itemId), n(p.unitPrice));
    }

    const list = rows.map((r) => ({
      item_id: r.item_id, item_description: r.item_description ?? null, uom: r.uom ?? null,
      unit_price: n(r.unit_price), image_key: r.image_key ?? null,
      category: catLabel(r), category_key: catKey(r),
      on_hand: onHandMap.has(r.item_id) ? onHandMap.get(r.item_id)! : null,
      last_price: lastPriceMap.has(r.item_id) ? lastPriceMap.get(r.item_id)! : null,
    }));
    return { items: list, categories, total, offset, limit, has_more: offset + list.length < total, count: list.length };
  }

  // Thumbnail for a catalog item (pr_raise) — returns the in-DB image data-URL so the shop grid can show it
  // as an inline <img>. Same low-risk browse duty as the catalog itself (the item-master `images` admin
  // endpoint is masterdata-gated). 404 when the item has no image.
  async catalogItemImage(_user: JwtUser, itemId: string) {
    const id = String(itemId ?? '').slice(0, 100);
    const [r] = await this.db.select({ dataUrl: itemImages.dataUrl }).from(itemImages).where(eq(itemImages.itemId, id)).limit(1);
    if (!r?.dataUrl) throw new NotFoundException({ code: 'NO_IMAGE', message: 'No image for item', messageTh: 'ไม่มีรูปสำหรับสินค้านี้' });
    return { item_id: id, data_url: r.dataUrl };
  }

  // Vendor search for the PR→PO panel — pick a real supplier (ties the PO to the vendor master, so
  // screening + scorecards apply) instead of free-typing a name. RLS scopes to the caller's tenant.
  async searchVendors(q: string, limit = 8) {
    const kw = (q ?? '').trim().slice(0, 100);
    if (!kw) return { vendors: [] };
    const rows = await this.db.select({ id: vendors.id, name: vendors.name, vendor_code: vendors.vendorCode })
      .from(vendors).where(and(ilike(vendors.name, `%${kw}%`), eq(vendors.isSupplier, true))).limit(Math.min(Math.max(limit, 1), 25));
    return { vendors: rows.map((r: any) => ({ id: Number(r.id), name: r.name, vendor_code: r.vendor_code ?? null })) };
  }

  // Suggest the supplier for each requisition line so the PR→PO screen can auto-group a PR into one PO per
  // vendor. Resolution per item (best first): (1) the tenant's PREFERRED active price-list row, (2) the
  // cheapest active price-list row, (3) the most-recent committed PO's vendor. Blocklisted / non-approved
  // vendors are never suggested (they'd be refused at PO creation anyway). Also returns every candidate
  // vendor for the item so the buyer can switch a line to a different supplier. Read-only; RLS-scoped.
  async suggestSuppliersForItems(itemIds: string[], user: JwtUser) {
    const db = this.db;
    const ids = [...new Set((itemIds ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))].slice(0, 200);
    const out: Record<string, { suggested: any; candidates: any[] }> = {};
    if (!ids.length) return { suggestions: out };
    const tenantId = user.tenantId ?? null;
    // Active price-list rows for these items (tenant's own + shared NULL-tenant), joined to the vendor master
    // so a blocklisted / unapproved supplier can be excluded from the routing.
    const priceRows = await db.select({
      itemId: supplierPriceLists.itemId, vendorId: supplierPriceLists.vendorId, unitPrice: supplierPriceLists.unitPrice,
      uom: supplierPriceLists.uom, preferred: supplierPriceLists.preferred, currency: supplierPriceLists.currency,
      vendorName: vendors.name, blocklisted: vendors.blocklisted, approvalStatus: vendors.approvalStatus,
    }).from(supplierPriceLists)
      .leftJoin(vendors, eq(supplierPriceLists.vendorId, vendors.id))
      .where(and(
        eq(supplierPriceLists.status, 'active'),
        inArray(supplierPriceLists.itemId, ids),
        tenantId != null ? or(eq(supplierPriceLists.tenantId, tenantId), isNull(supplierPriceLists.tenantId)) : undefined,
      ));
    // Most-recent committed PO vendor per item (fallback when no price list exists for the item).
    const poRows = await db.select({
      itemId: poItems.itemId, vendorId: purchaseOrders.vendorId, vendorName: purchaseOrders.vendorName,
      unitPrice: poItems.unitPrice, uom: poItems.uom, poId: purchaseOrders.id,
    }).from(poItems).innerJoin(purchaseOrders, eq(poItems.poId, purchaseOrders.id))
      .where(and(inArray(poItems.itemId, ids), notInArray(purchaseOrders.status, ['Draft', 'Cancelled'])))
      .orderBy(desc(purchaseOrders.id));
    const lastPo = new Map<string, any>();
    for (const p of poRows) { const k = String(p.itemId); if (!lastPo.has(k)) lastPo.set(k, p); }

    for (const item of ids) {
      const rows = priceRows.filter((r: any) => String(r.itemId) === item && !r.blocklisted && String(r.approvalStatus ?? 'approved') === 'approved');
      const candidates = rows.map((r: any) => ({
        vendor_id: Number(r.vendorId), vendor_name: r.vendorName ?? null, unit_price: n(r.unitPrice),
        uom: r.uom ?? null, currency: r.currency ?? 'THB', preferred: r.preferred === true, source: 'pricelist' as const,
      })).sort((a, b) => (Number(b.preferred) - Number(a.preferred)) || (a.unit_price - b.unit_price));
      type Sug = { vendor_id: number; vendor_name: string | null; unit_price: number; uom: string | null; currency: string; preferred: boolean; source: 'pricelist' | 'last_po' };
      let suggested: Sug | null = candidates[0] ?? null;
      // Fallback: no usable price list → route to the last committed PO's vendor (if any).
      if (!suggested) {
        const lp = lastPo.get(item);
        if (lp?.vendorId != null) suggested = { vendor_id: Number(lp.vendorId), vendor_name: lp.vendorName ?? null, unit_price: n(lp.unitPrice), uom: lp.uom ?? null, currency: 'THB', preferred: false, source: 'last_po' };
      }
      out[item] = { suggested, candidates };
    }
    return { suggestions: out };
  }

  // Set / clear an item's "ผู้ขายประจำ" (preferred supplier) — a sourcing decision that seeds the PR→PO
  // auto-group. Kept on the tenant-scoped supplier price list: mark ONE active row (tenant,item) preferred,
  // unsetting its siblings (the partial unique index is the backstop). If no active price row exists for the
  // chosen vendor+item yet, one is created from the supplied price (the buyer just typed it on the PO) or the
  // last PO price — so next time the price auto-fills too. Removing a preference just clears the flag.
  async setPreferredVendor(itemId: string, dto: { vendor_id: number; unit_price?: number; uom?: string; currency?: string; remove?: boolean }, user: JwtUser) {
    const db = this.db;
    const item = String(itemId ?? '').trim();
    if (!item) throw new BadRequestException({ code: 'ITEM_REQUIRED', message: 'item id required', messageTh: 'ต้องระบุรหัสสินค้า' });
    if (!(Number(dto.vendor_id) > 0)) throw new BadRequestException({ code: 'VENDOR_REQUIRED', message: 'vendor id required', messageTh: 'ต้องระบุผู้ขาย' });
    const tenantId = user.tenantId ?? null;
    const tenantCond = tenantId != null ? or(eq(supplierPriceLists.tenantId, tenantId), isNull(supplierPriceLists.tenantId)) : undefined;
    // The vendor must exist and be usable (a blocklisted / unapproved supplier cannot become the default).
    await this.assertSupplierAllowed(Number(dto.vendor_id), null);

    // Clearing a preference: just drop the flag on the item's active rows (idempotent) — no price churn.
    if (dto.remove === true) {
      await db.update(supplierPriceLists).set({ preferred: false })
        .where(and(eq(supplierPriceLists.itemId, item), eq(supplierPriceLists.status, 'active'), tenantCond));
      return { item_id: item, vendor_id: Number(dto.vendor_id), preferred: false };
    }

    // Find (or create) the active price row for this vendor+item that will carry the preferred flag.
    const existing = await db.select({ id: supplierPriceLists.id, uom: supplierPriceLists.uom })
      .from(supplierPriceLists)
      .where(and(eq(supplierPriceLists.itemId, item), eq(supplierPriceLists.vendorId, Number(dto.vendor_id)), eq(supplierPriceLists.status, 'active'), tenantCond))
      .orderBy(desc(supplierPriceLists.id)).limit(1);
    let targetId = existing[0]?.id ? Number(existing[0].id) : null;
    if (targetId == null) {
      // No price yet: seed one from the supplied price, else the last committed PO price for this vendor+item.
      let price = dto.unit_price != null && n(dto.unit_price) > 0 ? n(dto.unit_price) : null;
      let uom = dto.uom ?? null;
      if (price == null) {
        const [lp] = await db.select({ unitPrice: poItems.unitPrice, uom: poItems.uom })
          .from(poItems).innerJoin(purchaseOrders, eq(poItems.poId, purchaseOrders.id))
          .where(and(eq(poItems.itemId, item), eq(purchaseOrders.vendorId, Number(dto.vendor_id)), notInArray(purchaseOrders.status, ['Draft', 'Cancelled'])))
          .orderBy(desc(purchaseOrders.id)).limit(1);
        if (lp?.unitPrice != null) { price = n(lp.unitPrice); uom = uom ?? (lp.uom ?? null); }
      }
      if (price == null) throw new UnprocessableEntityException({ code: 'PRICE_REQUIRED', message: 'A unit price is needed to set a preferred vendor', messageTh: 'ต้องระบุราคาต่อหน่วยเพื่อตั้งผู้ขายประจำ' });
      const [row] = await db.insert(supplierPriceLists).values({
        tenantId, vendorId: Number(dto.vendor_id), itemId: item, uom: uom ?? 'EA', currency: dto.currency ?? 'THB',
        unitPrice: String(price), minQty: '1', effectiveFrom: ymd(), status: 'active', preferred: false, createdBy: user.username,
      }).returning({ id: supplierPriceLists.id });
      targetId = Number(row!.id);
    }
    // Enforce single preferred per (tenant,item): clear all active rows first, then flag the chosen one —
    // this ordering avoids tripping the uq_spl_preferred_per_item partial unique index mid-update.
    await db.update(supplierPriceLists).set({ preferred: false })
      .where(and(eq(supplierPriceLists.itemId, item), eq(supplierPriceLists.status, 'active'), tenantCond));
    await db.update(supplierPriceLists).set({ preferred: true }).where(eq(supplierPriceLists.id, targetId));
    return { item_id: item, vendor_id: Number(dto.vendor_id), preferred: true };
  }

  // D3 — purchase spend insights for a business month (Asia/Bangkok): total committed spend, the top
  // vendors by spend, and the most-bought items. Sourced from purchase_orders / po_items excluding
  // Draft/Cancelled (a committed-buy view). Read-only aggregate; purchase_orders is company-wide.
  async purchaseSpend(_user: JwtUser, opts?: { period?: string }) {
    const db = this.db;
    // Harden against parameter tampering: a query param can arrive as an array (?period=a&period=b), so
    // coerce to a string BEFORE the regex/slice — only a well-formed 'YYYY-MM' is honoured, else this month.
    const rawPeriod = typeof opts?.period === 'string' ? opts.period : '';
    const period = /^\d{4}-\d{2}$/.test(rawPeriod) ? rawPeriod : new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
    // [firstDay, nextMonthFirst) window on po_date (typed date-string bounds — portable across pg/PGlite,
    // no enum-in-text or cast/like). notInArray keeps only committed buys (excludes Draft/Cancelled).
    const y = Number(period.slice(0, 4)), m = Number(period.slice(5, 7));
    const firstDay = `${period}-01`;
    const nextMonthFirst = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const inPeriod = and(gte(purchaseOrders.poDate, firstDay), lt(purchaseOrders.poDate, nextMonthFirst), notInArray(purchaseOrders.status, ['Draft', 'Cancelled']));
    const spendExpr = sql<string>`coalesce(sum(${purchaseOrders.totalAmount}),0)`;
    const [tot] = await db.select({ total: spendExpr, cnt: sql<number>`count(*)` }).from(purchaseOrders).where(inPeriod);
    const byVendor = await db.select({ vendor: purchaseOrders.vendorName, total: spendExpr, cnt: sql<number>`count(*)` })
      .from(purchaseOrders).where(inPeriod).groupBy(purchaseOrders.vendorName).orderBy(desc(spendExpr)).limit(5);
    const itemValue = sql<string>`coalesce(sum(coalesce(${poItems.amount}, ${poItems.orderQty} * ${poItems.unitPrice})),0)`;
    const topItems = await db.select({ itemId: poItems.itemId, qty: sql<string>`coalesce(sum(${poItems.orderQty}),0)`, value: itemValue })
      .from(poItems).innerJoin(purchaseOrders, eq(poItems.poId, purchaseOrders.id)).where(inPeriod)
      .groupBy(poItems.itemId).orderBy(desc(itemValue)).limit(5);
    return {
      period, total: n(tot?.total), po_count: Number(tot?.cnt ?? 0),
      by_vendor: byVendor.map((v: any) => ({ vendor: v.vendor ?? '(ไม่ระบุผู้ขาย)', total: n(v.total), po_count: Number(v.cnt) })),
      top_items: topItems.map((i: any) => ({ item_id: i.itemId ?? '(ไม่ระบุ)', qty: n(i.qty), value: n(i.value) })),
    };
  }

  // Low-stock reorder list — items whose total on-hand has fallen to/below their reorder point
  // (`items.min_stock`). On-hand is summed from `inv_balances` across the caller's tenant locations.
  // The suggested reorder qty tops the item back up to its order-up-to level: `max_stock` when it is a
  // real configured ceiling (set below the 9999 default and above the reorder point), otherwise twice the
  // reorder point — a sane "order a lot" default the buyer can still edit before the PR is raised.
  async lowStock(user: JwtUser, opts?: { limit?: number }) {
    const db = this.db;
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
    const bal = await db.select({ itemId: invBalances.itemId, onHand: sql<string>`sum(${invBalances.onHandQty})` })
      .from(invBalances)
      .where(user.tenantId != null ? eq(invBalances.tenantId, user.tenantId) : sql`true`)
      .groupBy(invBalances.itemId);
    const onHandMap = new Map<string, number>(bal.map((b: any) => [String(b.itemId), n(b.onHand)]));
    // reorder point is on the (company-wide) item master; only items that actually carry one qualify.
    const its = await db.select({ itemId: items.itemId, description: items.itemDescription, uom: items.uom, minStock: items.minStock, maxStock: items.maxStock, unitPrice: items.unitPrice })
      .from(items).where(sql`${items.minStock} > 0`);
    const low = its
      .map((it: any) => {
        const onHand = onHandMap.get(String(it.itemId)) ?? 0;
        const minStock = n(it.minStock);
        const maxStock = n(it.maxStock);
        const target = maxStock > minStock && maxStock < 9999 ? maxStock : minStock * 2;
        const suggested = Math.max(Math.ceil(target - onHand), 1);
        return { item_id: it.itemId, item_description: it.description ?? null, uom: it.uom ?? null, on_hand: onHand, min_stock: minStock, suggested_qty: suggested, unit_price: n(it.unitPrice) };
      })
      .filter((x) => x.on_hand <= x.min_stock)
      .sort((a, b) => (a.on_hand - a.min_stock) - (b.on_hand - b.min_stock)); // most-depleted first
    return { items: low.slice(0, limit), count: low.length };
  }
  // Fetch and populate product images for catalog items (shop /order items) from the internet.
  // Fetches images based on item descriptions and stores them as data URLs in the item_images table.
  // Used by the admin endpoint to bulk-populate images for items without them.
  async populateItemImages(itemIds?: string[]) {
    const db = this.db;

    // Get items that don't have images yet
    const whereConditions = itemIds && itemIds.length > 0
      ? and(isNull(items.imageKey), inArray(items.itemId, itemIds))
      : isNull(items.imageKey);

    const itemsToFetch = await db.select({
      itemId: items.itemId,
      description: items.itemDescription,
    }).from(items)
      .where(whereConditions)
      .limit(100); // Batch to avoid timeouts

    const results = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      items: [] as Array<{ item_id: string; status: string; message: string }>,
    };

    for (const item of itemsToFetch) {
      try {
        const dataUrl = await this.imageFetch.fetchProductImage(item.description || item.itemId);

        if (dataUrl) {
          // Upsert the image — update if exists, insert if not
          await db.insert(itemImages)
            .values({
              itemId: item.itemId,
              imageKey: `img_${item.itemId}`,
              dataUrl,
              updatedAt: new Date(),
              updatedBy: 'system',
            })
            .onConflictDoUpdate({
              target: itemImages.itemId,
              set: {
                imageKey: `img_${item.itemId}`,
                dataUrl,
                updatedAt: new Date(),
                updatedBy: 'system',
              },
            });

          // Update the item's imageKey reference
          await db.update(items)
            .set({ imageKey: `img_${item.itemId}` })
            .where(eq(items.itemId, item.itemId));

          results.succeeded++;
          results.items.push({ item_id: item.itemId, status: 'success', message: 'Image fetched and stored' });
        } else {
          results.failed++;
          results.items.push({ item_id: item.itemId, status: 'failed', message: 'Could not fetch image' });
        }
      } catch (error) {
        results.failed++;
        results.items.push({ item_id: item.itemId, status: 'error', message: String(error) });
      }
      results.processed++;
    }

    return results;
  }

  // Fetch image for a single item and return as data URL
  async fetchItemImage(itemId: string): Promise<string> {
    const [item] = await this.db.select({
      description: items.itemDescription,
    }).from(items).where(eq(items.itemId, itemId)).limit(1);

    if (!item) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Item not found', messageTh: 'ไม่พบสินค้า' });

    return await this.imageFetch.fetchProductImage(item.description || itemId);
  }

  // Store a fetched image for an item
  async storeItemImage(itemId: string, dataUrl: string) {
    // Upsert the image in item_images table
    await this.db.insert(itemImages)
      .values({
        itemId,
        imageKey: `img_${itemId}`,
        dataUrl,
        updatedAt: new Date(),
        updatedBy: 'system',
      })
      .onConflictDoUpdate({
        target: itemImages.itemId,
        set: {
          imageKey: `img_${itemId}`,
          dataUrl,
          updatedAt: new Date(),
          updatedBy: 'system',
        },
      });

    // Update the item's imageKey reference
    await this.db.update(items)
      .set({ imageKey: `img_${itemId}` })
      .where(eq(items.itemId, itemId));

    return { item_id: itemId, image_key: `img_${itemId}` };
  }
}
