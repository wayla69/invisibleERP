import { Inject, Injectable, Optional, NotFoundException, ForbiddenException, BadRequestException, UnprocessableEntityException, ConflictException } from '@nestjs/common';
import { sql, eq, ne, and, desc, asc, isNull, or, ilike, inArray, notInArray, gte, lt } from 'drizzle-orm';
import { isUniqueViolation } from '../../common/db-error';
import { nameSimilarity, normalizeKey } from '../../common/text-similarity';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { purchaseRequests, prItems, purchaseOrders, poItems, goodsReceipts, grItems, lotLedger, stockMovements, vendors, supplierScorecards, supplierPriceLists, items, itemCategories, itemImages, invBalances, projects, tenants, vendorBankChangeRequests, vendorAddresses, vendorContacts, dataChangeLog, vendorRelationships } from '../../database/schema';
import { alias } from 'drizzle-orm/pg-core';
import { shapeChangeHistory } from '../../common/change-history';
import { isValidPostalCode, normalizeProvince } from '../../common/thai-address';
import { normalizeBank } from '../../common/thai-banks';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { WorkflowService } from '../workflow/workflow.service';
import { CostingService } from '../costing/costing.service';
import { WebhookService } from '../platform/webhook.service';
import { LineNotifyService } from '../messaging/line-notify.service';
import { CommitmentsService } from '../commitments/commitments.service';
import { ymd } from '../../database/queries';
import { GrPdfService, type GrPrintData } from './gr-pdf.service';
import { ProcurementGrnService } from './procurement-grn.service';
import { DocEmailService } from '../mail/doc-email.service';
import { sellerParty } from '../../common/doc-party';
import { normalizeA4Template } from '../../common/a4-template';
import { DocumentTemplatesService } from '../document-templates/document-templates.service';
import { ImageFetchService } from './image-fetch.service';
import type { JwtUser } from '../../common/decorators';
import { n, shapeVendorRelationship, shapeVendorAddress, shapeVendorContact } from './procurement.shared';
// Re-exported so existing `import type { CreatePrDto } from './procurement.service'` callers are unchanged.
export type { CreatePrDto, CreatePoDto, CreateGrDto, UpsertSupplierPriceDto, ConvLine } from './procurement.shared';
import type { CreatePrDto, CreatePoDto, CreateGrDto, UpsertSupplierPriceDto, ConvLine } from './procurement.shared';


@Injectable()
export class ProcurementService {
  private readonly grn: ProcurementGrnService;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly statusLog: StatusLogService,
    private readonly imageFetch: ImageFetchService,
    // @Optional + last so harnesses that construct this service directly (writeflow) without the engine still work
    @Optional() private readonly workflow?: WorkflowService,
    @Optional() private readonly costing?: CostingService, // Phase 17A — inventory costing (opt-in per item)
    @Optional() private readonly webhooks?: WebhookService, // Phase 8 — outbound webhook fan-out (best-effort)
    @Optional() private readonly lineNotify?: LineNotifyService, // D2 — close-the-loop LINE pushes to the PR requester
    @Optional() private readonly commitments?: CommitmentsService, // M1 (PROJ-12) — BoQ-line budget encumbrance
    @Optional() private readonly grPdf?: GrPdfService,             // ใบรับสินค้า renderer
    @Optional() private readonly docEmail?: DocEmailService,        // @Global MailModule
    @Optional() private readonly docTemplates?: DocumentTemplatesService, // no-code PO template (presentation)
  ) {
    // docs/38 procurement PR-2: built in the ctor BODY (not DI) — goldenmaster/writeflow construct this
    // facade positionally with (db, docNo, statusLog), so sub-services must come from the injected deps.
    this.grn = new ProcurementGrnService(db, docNo, statusLog, (poNo, msg) => this.notifyPoPrRequesters(poNo, msg), costing, commitments, grPdf, docEmail);
  }

  // D2 — best-effort LINE push to the requester(s) of every PR linked to a PO (pr_items.po_no), closing
  // the loop when their requisition is bought/received. No-op for unlinked users; never blocks the flow.
  private async notifyPoPrRequesters(poNo: string, text: string): Promise<void> {
    if (!this.lineNotify) return;
    try {
      // purchase_requests is a company-wide doc (no tenant_id) — notifyUser resolves each user's own tenant.
      const rows = await this.db.select({ requestedBy: purchaseRequests.requestedBy })
        .from(prItems).innerJoin(purchaseRequests, eq(prItems.prId, purchaseRequests.id)).where(eq(prItems.poNo, poNo));
      const seen = new Set<string>();
      for (const r of rows) {
        const who = String(r.requestedBy ?? '');
        if (!who || seen.has(who)) continue;
        seen.add(who);
        await this.lineNotify.notifyUser(who, null, text);
      }
    } catch { /* best-effort — a push failure never blocks buying/receiving */ }
  }

  // Resolve a project_code to its id (M0, docs/32). Unknown code → 404 so a typo can't silently drop the
  // project dimension. Returns null when no code is supplied (a non-project buy).
  private async resolveProjectId(code?: string): Promise<number | null> {
    const c = code?.trim();
    if (!c) return null;
    const [p] = await this.db.select({ id: projects.id }).from(projects).where(eq(projects.projectCode, c)).limit(1);
    if (!p) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: `Project ${c} not found`, messageTh: 'ไม่พบโครงการ' });
    return Number(p.id);
  }

  // ── PR ──────────────────────────────────────────────────────────────
  async createPr(dto: CreatePrDto, user: JwtUser) {
    const db = this.db;
    if (!dto.items?.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No items', messageTh: 'ไม่มีรายการ' });
    const projectId = await this.resolveProjectId(dto.project_code); // M0 — project dimension (nullable)
    const prNo = await this.docNo.nextDaily('PR');
    await db.transaction(async (tx: any) => {
      const [h] = await tx.insert(purchaseRequests).values({
        prNo, prDate: ymd(), requestedBy: user.username, status: 'Pending', remarks: dto.remarks ?? null, priority: dto.priority ?? 'Normal', projectId,
      }).returning({ id: purchaseRequests.id });
      await tx.insert(prItems).values(dto.items.map((it) => ({
        prId: Number(h.id), itemId: it.item_id, itemDescription: it.item_description ?? null,
        requestQty: String(n(it.request_qty)), uom: it.uom ?? null, requiredDate: it.required_date ?? null,
        reason: it.reason ?? null, status: 'Open', boqLineId: it.boq_line_id ?? null,
      })));
    });
    await this.statusLog.log('PR', prNo, '', 'Pending', user.username);
    // route into the approval engine (no active PR definition → autoApproved, legacy passthrough)
    await this.workflow?.start({ docType: 'PR', docNo: prNo, amount: n(dto.amount), createdBy: user.username, tenantId: user.tenantId ?? null });
    return { pr_no: prNo, status: 'Pending', lines: dto.items.length };
  }

  async approvePr(prNo: string, approve: boolean, user: JwtUser) {
    const db = this.db;
    const [pr] = await db.select().from(purchaseRequests).where(eq(purchaseRequests.prNo, prNo)).limit(1);
    if (!pr) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PR not found', messageTh: 'ไม่พบ PR' });
    // if a workflow is configured (a live instance exists), route the decision through the engine —
    // maker-checker + multi-level + SoD all enforced there. Otherwise fall back to the legacy Admin-only flip.
    const inst = this.workflow ? await this.workflow.pendingInstanceFor('PR', prNo) : null;
    if (inst) {
      await this.workflow!.act(Number(inst.id), { decision: approve ? 'approve' : 'reject' }, user);
      const cleared = await this.workflow!.canTransition('PR', prNo);
      const newStatus = approve ? (cleared ? 'Approved' : 'Pending') : 'Rejected'; // 'Pending' = more steps remain
      await db.update(purchaseRequests).set({ status: newStatus, approvedBy: user.username, approvedAt: new Date() }).where(eq(purchaseRequests.id, pr.id));
      if (newStatus !== pr.status) await this.statusLog.log('PR', prNo, pr.status ?? '', newStatus, user.username);
      return { pr_no: prNo, status: newStatus };
    }
    if (user.role !== 'Admin') throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Admin only', messageTh: 'เฉพาะผู้ดูแล' });
    const newStatus = approve ? 'Approved' : 'Rejected';
    await db.update(purchaseRequests).set({ status: newStatus, approvedBy: user.username, approvedAt: new Date() }).where(eq(purchaseRequests.id, pr.id));
    await this.statusLog.log('PR', prNo, pr.status ?? '', newStatus, user.username);
    return { pr_no: prNo, status: newStatus };
  }

  // Requester withdraws their own still-Pending PR (0228 — also reachable from the LINE chat `cancel`
  // command). Own-doc only (Admin may cancel any); the pending workflow instance is closed alongside so
  // the approval queue carries no orphan. A decided (Approved/Rejected) PR cannot be cancelled.
  async cancelPr(prNo: string, user: JwtUser) {
    const db = this.db;
    const [pr] = await db.select().from(purchaseRequests).where(eq(purchaseRequests.prNo, prNo)).limit(1);
    if (!pr) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PR not found', messageTh: 'ไม่พบ PR' });
    if (pr.requestedBy !== user.username && user.role !== 'Admin') {
      throw new ForbiddenException({ code: 'PR_NOT_YOURS', message: 'Only the requester can cancel their PR', messageTh: 'ยกเลิกได้เฉพาะคำขอของตนเอง' });
    }
    if (pr.status !== 'Pending') {
      throw new BadRequestException({ code: 'PR_NOT_PENDING', message: `Cannot cancel a '${pr.status}' PR`, messageTh: `ยกเลิกไม่ได้: PR สถานะ '${pr.status}'` });
    }
    await db.update(purchaseRequests).set({ status: 'Cancelled' }).where(eq(purchaseRequests.id, pr.id));
    await this.statusLog.log('PR', prNo, pr.status ?? '', 'Cancelled', user.username);
    await this.workflow?.cancel('PR', prNo);
    return { pr_no: prNo, status: 'Cancelled' };
  }

  // List recent PRs (header + lines) for the web requisitions screen. `mine` scopes to the caller's own
  // requests (the default for a plain pr_raise holder); procurement/planner/exec see every PR so they can
  // approve. Newest first. purchase_requests has no tenant_id (company-wide document), so no tenant filter.
  async listPrs(user: JwtUser, opts?: { limit?: number; mine?: boolean }) {
    const db = this.db;
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    const canSeeAll = (user.permissions ?? []).some((p) => ['procurement', 'planner', 'exec'].includes(p)) || user.role === 'Admin';
    const scopeMine = opts?.mine ?? !canSeeAll;
    const heads = await db.select().from(purchaseRequests)
      .where(scopeMine ? eq(purchaseRequests.requestedBy, user.username ?? '') : sql`true`)
      .orderBy(desc(purchaseRequests.id)).limit(limit);
    if (!heads.length) return { prs: [], can_approve: canSeeAll };
    const ids = heads.map((h: any) => Number(h.id));
    const lines = await db.select().from(prItems).where(sql`${prItems.prId} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
    // Enrich the display name: pr_items.item_description is captured at raise-time (shop checkout / manual),
    // but a chat-raised line may only carry the code — backfill the name from the item master so every line
    // shows a human name, not just a code (the reported "ดึงชื่อสินค้ามาด้วย"). Company-wide `items`, one lookup.
    const lineItemIds = [...new Set(lines.map((l: any) => l.itemId).filter(Boolean) as string[])];
    const nameMap = new Map<string, string>();
    if (lineItemIds.length) {
      const im = await db.select({ itemId: items.itemId, desc: items.itemDescription }).from(items).where(inArray(items.itemId, lineItemIds));
      for (const r of im) if (r.desc) nameMap.set(String(r.itemId), String(r.desc));
    }
    const byPr = new Map<number, any[]>();
    for (const l of lines) { const k = Number(l.prId); (byPr.get(k) ?? byPr.set(k, []).get(k)!).push(l); }
    return {
      can_approve: canSeeAll,
      prs: heads.map((h: any) => ({
        pr_no: h.prNo, pr_date: h.prDate, requested_by: h.requestedBy, status: h.status, priority: h.priority,
        approved_by: h.approvedBy ?? null,
        lines: (byPr.get(Number(h.id)) ?? []).map((l: any) => ({
          id: Number(l.id), item_id: l.itemId, item_description: l.itemDescription ?? nameMap.get(String(l.itemId)) ?? null,
          request_qty: n(l.requestQty), uom: l.uom ?? null, reason: l.reason ?? null,
          po_no: l.poNo ?? null, line_status: l.status ?? null,
        })),
      })),
    };
  }

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

  // One-tap reorder — raise a SINGLE PR covering every low-stock item at its suggested top-up qty (the
  // LINE chat `reorder` command + the web "เปิด PR เติมของ" button both land here). Runs the ordinary
  // createPr path, so numbering / status-log / approval workflow are unchanged. No low-stock item → 422.
  async reorderPr(user: JwtUser) {
    const low = (await this.lowStock(user)).items;
    if (!low.length) throw new UnprocessableEntityException({ code: 'NOTHING_LOW', message: 'No item is at/below its reorder point', messageTh: 'ไม่มีสินค้าที่ถึงจุดสั่งซื้อ' });
    const res = await this.createPr({
      remarks: 'เติมสต็อกสินค้าใกล้หมด (อัตโนมัติ)', priority: 'Normal',
      items: low.map((x) => ({ item_id: x.item_id, item_description: x.item_description ?? undefined, request_qty: x.suggested_qty, uom: x.uom ?? undefined, reason: 'ต่ำกว่าจุดสั่งซื้อ' })),
    }, user);
    return { pr_no: res.pr_no, status: res.status, lines: res.lines, items: low.map((x) => ({ item_id: x.item_id, qty: x.suggested_qty })) };
  }

  // Convert an APPROVED PR into one OR MORE POs. Each line arrives reconciled by procurement: an existing
  // item_id (picked from searchItems) OR a brand-new code to open (create_item:true → an items-master row).
  //
  // Two shapes, because "1 PO = 1 supplier" ⇒ a PR with lines for several suppliers must fan out:
  //  • LEGACY (`{ vendor, lines }`) — one PO for all lines; every PR line is stamped with it and the PR is
  //    marked Converted. Unchanged behaviour (the LINE-chat convert + older callers rely on it exactly).
  //  • SPLIT (`{ pos: [{ vendor, lines }, …] }`) — one PO per supplier group; each line is linked to its
  //    OWN PO by pr_line_id (precise) or item_id (fallback). The PR becomes 'Converted' only when every line
  //    is on a PO, else 'PartiallyConverted' so the remaining lines can be ordered in a later pass. A line
  //    may carry set_preferred:true to also record its group's vendor as the item's default (setPreferredVendor).
  // A Pending/Rejected PR 422s; a PartiallyConverted PR may be converted again (to place the rest).
  async convertPrToPo(prNo: string, dto: {
    vendor_id?: number; vendor_name?: string; expected_date?: string; remarks?: string; currency?: string; fx_rate?: number;
    lines?: ConvLine[];
    pos?: { vendor_id?: number; vendor_name?: string; expected_date?: string; remarks?: string; currency?: string; fx_rate?: number; lines: ConvLine[] }[];
  }, user: JwtUser) {
    const db = this.db;
    const pr = prNo.toUpperCase();
    const [head] = await db.select().from(purchaseRequests).where(eq(purchaseRequests.prNo, pr)).limit(1);
    if (!head) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PR not found', messageTh: 'ไม่พบคำขอซื้อ' });
    if (head.status !== 'Approved' && head.status !== 'PartiallyConverted') throw new UnprocessableEntityException({ code: 'PR_NOT_APPROVED', message: `PR must be Approved to convert (is '${head.status}')`, messageTh: `ต้องอนุมัติ PR ก่อนแปลงเป็น PO (สถานะปัจจุบัน '${head.status}')` });

    const legacy = !(dto.pos && dto.pos.length);
    const groups = legacy
      ? [{ vendor_id: dto.vendor_id, vendor_name: dto.vendor_name, expected_date: dto.expected_date, remarks: dto.remarks, currency: dto.currency, fx_rate: dto.fx_rate, lines: dto.lines ?? [] }]
      : dto.pos!;
    const allLines = groups.flatMap((g) => g.lines ?? []);
    if (!allLines.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No lines', messageTh: 'ไม่มีรายการ' });
    for (const g of groups) if (!(g.lines?.length)) throw new BadRequestException({ code: 'EMPTY_PO', message: 'Each PO needs at least one line', messageTh: 'ใบสั่งซื้อทุกใบต้องมีอย่างน้อย 1 รายการ' });
    for (const l of allLines) {
      if (!l.item_id?.trim()) throw new BadRequestException({ code: 'ITEM_REQUIRED', message: 'Each line needs a resolved item id', messageTh: 'ทุกบรรทัดต้องเลือกหรือเปิดรหัสสินค้า' });
      if (!(n(l.order_qty) > 0)) throw new BadRequestException({ code: 'BAD_QTY', message: `Bad qty for ${l.item_id}`, messageTh: `จำนวนไม่ถูกต้อง: ${l.item_id}` });
    }
    // Open any brand-new item codes first (idempotent — a code that already exists is left as-is).
    const created: string[] = [];
    for (const l of allLines.filter((x) => x.create_item)) {
      const code = l.item_id.trim();
      const [exists] = await db.select({ id: items.id }).from(items).where(eq(items.itemId, code)).limit(1);
      if (!exists) {
        await db.insert(items).values({ itemId: code, itemDescription: l.item_description ?? code, uom: l.uom ?? null, unitPrice: String(n(l.unit_price)) }).onConflictDoNothing();
        created.push(code);
      }
    }

    // Raise one PO per group through the normal path (vendor screening + workflow), then link the PR lines.
    const createdPos: { po_no: string; status: string; total_amount: number; vendor_id: number | null; vendor_name: string | null; line_count: number }[] = [];
    for (const g of groups) {
      // Resolve the group vendor id up front (for set_preferred); createPo re-resolves for the PO row itself.
      let gVendorId = g.vendor_id ?? null;
      if (!gVendorId && g.vendor_name?.trim()) { const [v] = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.name, g.vendor_name.trim())).limit(1); gVendorId = v?.id ?? null; }
      const po = await this.createPo({
        vendor_id: gVendorId ?? undefined, vendor_name: g.vendor_name, expected_date: g.expected_date,
        remarks: g.remarks ?? `จาก ${pr}`, currency: g.currency, fx_rate: g.fx_rate,
        items: g.lines.map((l) => ({ item_id: l.item_id.trim(), item_description: l.item_description, order_qty: n(l.order_qty), unit_price: n(l.unit_price), uom: l.uom, is_capital: l.is_capital })),
      }, user);
      createdPos.push({ po_no: po.po_no, status: po.status, total_amount: po.total_amount, vendor_id: gVendorId, vendor_name: g.vendor_name ?? null, line_count: g.lines.length });

      if (legacy) {
        // Preserve the historical behaviour exactly: blanket-stamp every PR line with the single PO number.
        await db.update(prItems).set({ poNo: po.po_no }).where(eq(prItems.prId, Number(head.id)));
      } else {
        // Split: link each group line to THIS PO precisely — by pr_line_id, else the first still-unlinked
        // PR line with the same item code. Only stamp rows not already on a PO (idempotent across passes).
        for (const l of g.lines) {
          if (l.pr_line_id != null) {
            await db.update(prItems).set({ poNo: po.po_no, status: 'Converted' })
              .where(and(eq(prItems.id, Number(l.pr_line_id)), eq(prItems.prId, Number(head.id)), isNull(prItems.poNo)));
          } else {
            const [cand] = await db.select({ id: prItems.id }).from(prItems)
              .where(and(eq(prItems.prId, Number(head.id)), eq(prItems.itemId, l.item_id.trim()), isNull(prItems.poNo))).limit(1);
            if (cand) await db.update(prItems).set({ poNo: po.po_no, status: 'Converted' }).where(eq(prItems.id, Number(cand.id)));
          }
          // Learn the item's default supplier when the buyer asks to (best-effort; never fails the convert).
          if (l.set_preferred && gVendorId) {
            try { await this.setPreferredVendor(l.item_id.trim(), { vendor_id: gVendorId, unit_price: n(l.unit_price), uom: l.uom }, user); } catch { /* preference is a nicety, not a gate */ }
          }
        }
      }
    }

    // PR status: legacy always fully closes; split closes only when no line remains unlinked.
    let newStatus = 'Converted';
    if (!legacy) {
      const remaining = await db.select({ id: prItems.id }).from(prItems).where(and(eq(prItems.prId, Number(head.id)), isNull(prItems.poNo)));
      newStatus = remaining.length === 0 ? 'Converted' : 'PartiallyConverted';
    }
    await db.update(purchaseRequests).set({ status: newStatus }).where(eq(purchaseRequests.id, head.id));
    if (newStatus !== head.status) await this.statusLog.log('PR', pr, head.status ?? '', newStatus, user.username);
    // D2 — tell the requester their requisition is now on purchase order(s) (best-effort LINE push).
    if (head.requestedBy && head.requestedBy !== user.username) {
      const poList = createdPos.map((p) => p.po_no).join(', ');
      await this.lineNotify?.notifyUser(String(head.requestedBy), null, `🛒 คำขอซื้อ ${pr} ของคุณออกใบสั่งซื้อแล้ว → ${poList}${newStatus === 'PartiallyConverted' ? ' (ยังมีรายการค้างรอสั่งเพิ่ม)' : ''}`);
    }
    const first = createdPos[0];
    return {
      pr_no: pr, pr_status: newStatus,
      po_no: first?.po_no ?? null, po_status: first?.status ?? null, // legacy fields (first PO)
      total_amount: createdPos.reduce((a, p) => a + n(p.total_amount), 0),
      pos: createdPos, created_items: created,
    };
  }

  // ── Supplier screening (Phase 16) ───────────────────────────────────
  // blocklisted or non-approved vendor → 422; unknown/freeform vendor (no master row) → allowed.
  async assertSupplierAllowed(vendorId: number | null, vendorName: string | null) {
    const db = this.db;
    // fail-CLOSED + check EVERY matching row: a blocklisted vendor must not be evadable via a duplicate-name
    // twin (no unique on vendors.name) or a freeform name. Only a genuinely-unknown vendor (no row) is allowed.
    let rows: any[] = [];
    if (vendorId) rows = await db.select().from(vendors).where(eq(vendors.id, vendorId)).limit(1);
    else if (vendorName) rows = await db.select().from(vendors).where(eq(vendors.name, vendorName));
    const bad = rows.find((v: any) => v.blocklisted || String(v.approvalStatus) !== 'approved');
    if (bad) throw new UnprocessableEntityException({ code: 'SUPPLIER_BLOCKED', message: `Supplier ${bad.name} is ${bad.blocklisted ? 'blocklisted' : bad.approvalStatus}`, messageTh: `ผู้ขายถูกระงับ (${bad.name})` });
  }
  async setSupplierStatus(vendorId: number, dto: { approval_status?: string; blocklisted?: boolean; reason?: string }, _user: JwtUser) {
    const db = this.db;
    const set: any = {};
    if (dto.approval_status != null) set.approvalStatus = dto.approval_status;
    if (dto.blocklisted != null) { set.blocklisted = dto.blocklisted; set.blocklistReason = dto.reason ?? null; }
    if (!Object.keys(set).length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No fields to update', messageTh: 'ไม่มีข้อมูลให้แก้ไข' });
    // RLS-scoped: a non-HQ tenant only sees/writes its own vendor rows (vendor_tenant_write, migration 0034),
    // so mutating another tenant's vendor — or a shared NULL-tenant master — updates 0 rows. Surface that as a
    // clean 404 rather than echoing a success that never happened (this is what closes the cross-tenant DoS).
    const updated = await db.update(vendors).set(set).where(eq(vendors.id, vendorId)).returning({ id: vendors.id });
    if (!updated.length) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Vendor not found', messageTh: 'ไม่พบผู้ขาย' });
    return { vendor_id: vendorId, approval_status: dto.approval_status, blocklisted: dto.blocklisted };
  }

  // Direct-edit vendor master fields (master-data audit Phase 2) — non-payment-redirection fields with no
  // fraud-relevant "who changed it" concern, so unlike bank details (0270) they don't need a maker-checker.
  // taxId/creditLimit/bankName/bankAccount are intentionally excluded here: tax ID and bank account are
  // encrypted PII, and credit limit is flagged `sensitive` in the bulk-import registry (master-registry.ts) —
  // both warrant their own dual-control design rather than a quick direct-edit path, so they stay out of
  // scope for this endpoint (identity fields vendor_code/name/is_supplier/is_creditor also excluded — those
  // still only come in via the /master-data bulk import).
  async updateVendorProfile(vendorId: number, dto: {
    contact?: string | null; phone?: string | null; email?: string | null; address?: string | null; payment_terms?: string | null;
    lead_time_days?: number | null; rating?: number | null; category?: string | null; currency?: string | null; notes?: string | null;
  }, _user: JwtUser) {
    const db = this.db;
    const set: Record<string, unknown> = {};
    if (dto.contact !== undefined) set.contact = dto.contact || null;
    if (dto.phone !== undefined) set.phone = dto.phone || null;
    if (dto.email !== undefined) set.email = dto.email || null;
    if (dto.address !== undefined) set.address = dto.address || null;
    if (dto.payment_terms !== undefined) set.paymentTerms = dto.payment_terms || null;
    if (dto.lead_time_days !== undefined) set.leadTimeDays = dto.lead_time_days;
    if (dto.rating !== undefined) set.rating = String(dto.rating);
    if (dto.category !== undefined) set.category = dto.category || null;
    if (dto.currency !== undefined) set.currency = dto.currency || null;
    if (dto.notes !== undefined) set.notes = dto.notes || null;
    if (!Object.keys(set).length) throw new BadRequestException({ code: 'NO_FIELDS', message: 'No fields to update', messageTh: 'ไม่มีข้อมูลให้แก้ไข' });
    const [row] = await db.update(vendors).set(set).where(eq(vendors.id, vendorId)).returning({ id: vendors.id });
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Vendor not found', messageTh: 'ไม่พบผู้ขาย' });
    return { vendor_id: vendorId, ...dto };
  }

  // ── Party-model depth (master-data audit Phase 4): multi-address / multi-contact / parent company ──
  private async vendorById(vendorId: number) {
    const [v] = await this.db.select().from(vendors).where(eq(vendors.id, vendorId)).limit(1);
    if (!v) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Vendor not found', messageTh: 'ไม่พบผู้ขาย' });
    return v;
  }

  async setVendorParent(vendorId: number, parentVendorId: number | null, _user: JwtUser) {
    const db = this.db;
    const v = await this.vendorById(vendorId);
    if (parentVendorId === vendorId) throw new BadRequestException({ code: 'SELF_PARENT', message: 'A vendor cannot be its own parent', messageTh: 'ผู้ขายไม่สามารถเป็นบริษัทแม่ของตัวเองได้' });
    if (parentVendorId != null) await this.vendorById(parentVendorId); // validates it exists
    await db.update(vendors).set({ parentVendorId }).where(eq(vendors.id, Number(v.id)));
    return { vendor_id: vendorId, parent_vendor_id: parentVendorId };
  }

  async addVendorAddress(vendorId: number, dto: {
    address_type?: string; address_line1?: string; address_line2?: string; sub_district?: string; district?: string; province?: string; postal_code?: string; is_primary?: boolean;
  }, user: JwtUser) {
    const db = this.db;
    const v = await this.vendorById(vendorId);
    // Thai address standardization (Phase 7): 5-digit postal code; province canonicalised when recognised.
    if (dto.postal_code && !isValidPostalCode(dto.postal_code)) throw new BadRequestException({ code: 'POSTAL_INVALID', message: 'Postal code must be 5 digits', messageTh: 'รหัสไปรษณีย์ต้องเป็นตัวเลข 5 หลัก' });
    const province = dto.province ? (normalizeProvince(dto.province) ?? dto.province) : null;
    if (dto.is_primary) await db.update(vendorAddresses).set({ isPrimary: false }).where(eq(vendorAddresses.vendorId, Number(v.id)));
    const [row] = await db.insert(vendorAddresses).values({
      tenantId: v.tenantId ?? null, vendorId: Number(v.id), addressType: dto.address_type ?? 'other',
      addressLine1: dto.address_line1 ?? null, addressLine2: dto.address_line2 ?? null,
      subDistrict: dto.sub_district ?? null, district: dto.district ?? null, province, postalCode: dto.postal_code ?? null,
      isPrimary: dto.is_primary ?? false, createdBy: user.username,
    }).returning();
    return shapeVendorAddress(row);
  }

  async listVendorAddresses(vendorId: number, _user: JwtUser) {
    const rows = await this.db.select().from(vendorAddresses).where(eq(vendorAddresses.vendorId, vendorId)).orderBy(desc(vendorAddresses.isPrimary), desc(vendorAddresses.id));
    return { addresses: rows.map(shapeVendorAddress), count: rows.length };
  }

  async deleteVendorAddress(vendorId: number, addressId: number, _user: JwtUser) {
    const del = await this.db.delete(vendorAddresses).where(and(eq(vendorAddresses.id, addressId), eq(vendorAddresses.vendorId, vendorId))).returning({ id: vendorAddresses.id });
    if (!del.length) throw new NotFoundException({ code: 'ADDRESS_NOT_FOUND', message: 'Address not found', messageTh: 'ไม่พบที่อยู่นี้' });
    return { deleted: true };
  }

  async addVendorContact(vendorId: number, dto: { name: string; title?: string; phone?: string; email?: string; notes?: string; is_primary?: boolean }, user: JwtUser) {
    const db = this.db;
    const v = await this.vendorById(vendorId);
    if (dto.is_primary) await db.update(vendorContacts).set({ isPrimary: false }).where(eq(vendorContacts.vendorId, Number(v.id)));
    const [row] = await db.insert(vendorContacts).values({
      tenantId: v.tenantId ?? null, vendorId: Number(v.id), name: dto.name, title: dto.title ?? null,
      phone: dto.phone ?? null, email: dto.email ?? null, notes: dto.notes ?? null, isPrimary: dto.is_primary ?? false, createdBy: user.username,
    }).returning();
    return shapeVendorContact(row);
  }

  async listVendorContacts(vendorId: number, _user: JwtUser) {
    const rows = await this.db.select().from(vendorContacts).where(eq(vendorContacts.vendorId, vendorId)).orderBy(desc(vendorContacts.isPrimary), desc(vendorContacts.id));
    return { contacts: rows.map(shapeVendorContact), count: rows.length };
  }

  async deleteVendorContact(vendorId: number, contactId: number, _user: JwtUser) {
    const del = await this.db.delete(vendorContacts).where(and(eq(vendorContacts.id, contactId), eq(vendorContacts.vendorId, vendorId))).returning({ id: vendorContacts.id });
    if (!del.length) throw new NotFoundException({ code: 'CONTACT_NOT_FOUND', message: 'Contact not found', messageTh: 'ไม่พบผู้ติดต่อนี้' });
    return { deleted: true };
  }

  // ── Vendor bank-detail maker-checker (0270 — closes a BEC/vendor-payment-fraud gap: a single md_vendor
  // user could otherwise redirect a supplier's payee bank details with no second check). Mirrors the G15
  // tenant PromptPay/tax-id pattern exactly: a change is staged PendingApproval and applied to `vendors`
  // only when a DISTINCT approver releases it (403 SOD_VIOLATION on self-approval). ──
  async stageBankChange(vendorId: number, dto: { bank_name?: string; bank_account?: string }, user: JwtUser) {
    const db = this.db;
    if (dto.bank_name === undefined && dto.bank_account === undefined) {
      throw new BadRequestException({ code: 'NO_FIELDS', message: 'No bank fields to change', messageTh: 'ไม่มีข้อมูลบัญชีธนาคารให้เปลี่ยน' });
    }
    const [v] = await db.select().from(vendors).where(eq(vendors.id, vendorId)).limit(1);
    if (!v) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Vendor not found', messageTh: 'ไม่พบผู้ขาย' });
    // Supersede any earlier still-open request for this vendor so the queue holds only the latest.
    await db.update(vendorBankChangeRequests).set({ status: 'Superseded' })
      .where(and(eq(vendorBankChangeRequests.vendorId, vendorId), eq(vendorBankChangeRequests.status, 'PendingApproval')));
    // Governed bank master (Phase 9): canonicalise a recognised bank name to its official form (unknown kept).
    const bankName = dto.bank_name ? (normalizeBank(dto.bank_name) ?? dto.bank_name) : (dto.bank_name ?? null);
    const reqNo = await this.docNo.nextDaily('VBC');
    await db.insert(vendorBankChangeRequests).values({
      tenantId: v.tenantId ?? null, vendorId, reqNo,
      bankName, bankAccount: dto.bank_account ?? null,
      prevBankName: v.bankName ?? null, prevBankAccount: v.bankAccount ?? null,
      status: 'PendingApproval', requestedBy: user.username,
    });
    return { req_no: reqNo, vendor_id: vendorId, status: 'PendingApproval' };
  }

  async pendingBankChanges(user: JwtUser) {
    const db = this.db;
    const rows = await db.select({
      reqNo: vendorBankChangeRequests.reqNo, vendorId: vendorBankChangeRequests.vendorId,
      vendorName: vendors.name, bankName: vendorBankChangeRequests.bankName, bankAccount: vendorBankChangeRequests.bankAccount,
      prevBankName: vendorBankChangeRequests.prevBankName, prevBankAccount: vendorBankChangeRequests.prevBankAccount,
      requestedBy: vendorBankChangeRequests.requestedBy, requestedAt: vendorBankChangeRequests.requestedAt,
    }).from(vendorBankChangeRequests)
      .innerJoin(vendors, eq(vendors.id, vendorBankChangeRequests.vendorId))
      .where(eq(vendorBankChangeRequests.status, 'PendingApproval'))
      .orderBy(desc(vendorBankChangeRequests.id));
    return {
      pending: rows.map((r: any) => ({
        req_no: r.reqNo, vendor_id: Number(r.vendorId), vendor_name: r.vendorName,
        bank_name: r.bankName, bank_account: r.bankAccount, prev_bank_name: r.prevBankName, prev_bank_account: r.prevBankAccount,
        requested_by: r.requestedBy, requested_at: r.requestedAt,
      })),
      count: rows.length,
    };
  }

  private async bankChangeByNo(reqNo: string) {
    const db = this.db;
    const [r] = await db.select().from(vendorBankChangeRequests).where(eq(vendorBankChangeRequests.reqNo, reqNo)).limit(1);
    if (!r || r.status !== 'PendingApproval') throw new NotFoundException({ code: 'NO_PENDING_BANK_CHANGE', message: 'No bank-detail change pending approval', messageTh: 'ไม่พบคำขอเปลี่ยนบัญชีธนาคารที่รออนุมัติ' });
    return r;
  }

  async approveBankChange(reqNo: string, approver: JwtUser) {
    const db = this.db;
    const r = await this.bankChangeByNo(reqNo);
    if (r.requestedBy && r.requestedBy === approver.username) {
      throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'The requester cannot approve their own bank-detail change', messageTh: 'ผู้ขอไม่สามารถอนุมัติคำขอของตนเองได้' });
    }
    const set: any = {};
    if (r.bankName !== null) set.bankName = r.bankName;
    if (r.bankAccount !== null) set.bankAccount = r.bankAccount;
    if (Object.keys(set).length) await db.update(vendors).set(set).where(eq(vendors.id, Number(r.vendorId)));
    await db.update(vendorBankChangeRequests).set({ status: 'Approved', approvedBy: approver.username, approvedAt: new Date() }).where(eq(vendorBankChangeRequests.id, Number(r.id)));
    return { req_no: reqNo, status: 'Approved', approved_by: approver.username, requested_by: r.requestedBy, vendor_id: Number(r.vendorId) };
  }

  async rejectBankChange(reqNo: string, approver: JwtUser, reason?: string) {
    const db = this.db;
    await this.bankChangeByNo(reqNo);
    await db.update(vendorBankChangeRequests).set({ status: 'Rejected', rejectReason: reason ?? null }).where(eq(vendorBankChangeRequests.reqNo, reqNo));
    return { req_no: reqNo, status: 'Rejected', rejected_by: approver.username };
  }
  // Scorecard recompute: on-time/quality remain at 100 (placeholder until claims feed them).
  // price_var_pct: for each GR item received from this vendor, compare unit_cost vs the active
  // list price (supplier_price_lists) for that item+uom. avg(abs(actual − list) / list * 100).
  async recomputeScorecard(vendorId: number, period: string, user: JwtUser) {
    const db = this.db;
    const [g] = await db.select({ c: sql<string>`count(*)` }).from(goodsReceipts).where(eq(goodsReceipts.vendorId, vendorId));
    const grCount = Number(g?.c ?? 0);
    const onTime = 100, quality = 100;

    // Compute price variance: join GR items with active price-list entries for this vendor
    const priceRows = await db.select({
      actualCost: grItems.unitCost,
      listPrice: supplierPriceLists.unitPrice,
    }).from(grItems)
      .innerJoin(goodsReceipts, eq(grItems.grId, goodsReceipts.id))
      .innerJoin(supplierPriceLists, and(
        eq(supplierPriceLists.vendorId, vendorId),
        eq(supplierPriceLists.itemId, grItems.itemId),
        eq(supplierPriceLists.status, 'active'),
      ))
      .where(eq(goodsReceipts.vendorId, vendorId));
    let priceVar = 0;
    if (priceRows.length) {
      const variances = priceRows
        .map((r: any) => { const list = Number(r.listPrice); return list > 0 ? Math.abs(Number(r.actualCost ?? 0) - list) / list * 100 : 0; })
        .filter((v: number) => isFinite(v));
      if (variances.length) priceVar = Math.round((variances.reduce((a: number, b: number) => a + b, 0) / variances.length) * 100) / 100;
    }

    const score = Math.round(((onTime + quality + (100 - Math.min(priceVar, 100))) / 3) * 100) / 100;
    await db.insert(supplierScorecards).values({ tenantId: user.tenantId ?? null, vendorId, period, onTimePct: String(onTime), qualityPct: String(quality), priceVarPct: String(priceVar), score: String(score), grCount, claimCount: 0, createdBy: user.username })
      .onConflictDoUpdate({ target: [supplierScorecards.vendorId, supplierScorecards.period], set: { score: String(score), grCount, priceVarPct: String(priceVar) } });
    await db.update(vendors).set({ scorecardScore: String(score) }).where(eq(vendors.id, vendorId));
    return { vendor_id: vendorId, period, score, gr_count: grCount, price_var_pct: priceVar };
  }

  // Supplier-performance register: scorecards for the caller's tenant ranked by score. With ?period → that
  // period; without → the LATEST scorecard per vendor (current standing). Tenant-scoped explicitly. Returns
  // the ranking + avg score + count of underperformers (< 70) for at-a-glance vendor management.
  async listScorecards(q: { period?: string; limit?: number }, user: JwtUser) {
    const db = this.db;
    const conds: any[] = [];
    if (user.tenantId != null) conds.push(eq(supplierScorecards.tenantId, user.tenantId));
    if (q.period) conds.push(eq(supplierScorecards.period, q.period));
    const rows = await db.select({
      vendorId: supplierScorecards.vendorId, vendorName: vendors.name, period: supplierScorecards.period,
      onTimePct: supplierScorecards.onTimePct, qualityPct: supplierScorecards.qualityPct, priceVarPct: supplierScorecards.priceVarPct,
      score: supplierScorecards.score, grCount: supplierScorecards.grCount, claimCount: supplierScorecards.claimCount,
    }).from(supplierScorecards).leftJoin(vendors, eq(supplierScorecards.vendorId, vendors.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(supplierScorecards.period), desc(supplierScorecards.score)).limit(q.limit ?? 200);
    // No period filter → keep only each vendor's latest scorecard (rows are period-desc, so first wins).
    let list = rows;
    if (!q.period) { const seen = new Set<number>(); list = rows.filter((r: any) => { const v = Number(r.vendorId); if (seen.has(v)) return false; seen.add(v); return true; }); }
    const scorecards = list
      .map((r: any) => ({ vendor_id: Number(r.vendorId), vendor_name: r.vendorName, period: r.period, on_time_pct: Number(r.onTimePct ?? 0), quality_pct: Number(r.qualityPct ?? 0), price_var_pct: Number(r.priceVarPct ?? 0), score: Number(r.score ?? 0), gr_count: Number(r.grCount ?? 0), claim_count: Number(r.claimCount ?? 0) }))
      .sort((a: any, b: any) => b.score - a.score);
    const avg = scorecards.length ? Math.round((scorecards.reduce((s: number, r: any) => s + r.score, 0) / scorecards.length) * 100) / 100 : 0;
    return { scorecards, count: scorecards.length, avg_score: avg, underperformers: scorecards.filter((r: any) => r.score < 70).length };
  }

  // ── Supplier price-list versioning (T2-D, migration 0174) ──────────
  // Upsert: creates a new 'active' price row, supersedes any existing active row for the same
  // (tenant, vendor, item, uom). Returns the new row id + the prior version id if superseded.
  async upsertSupplierPrice(dto: UpsertSupplierPriceDto, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId ?? null;
    const uom = dto.uom ?? 'EA';
    // supersede any existing active version for this vendor+item+uom in this tenant
    const superseded = await db.update(supplierPriceLists)
      .set({ status: 'superseded', effectiveTo: dto.effective_from })
      .where(and(
        tenantId != null ? eq(supplierPriceLists.tenantId, tenantId) : isNull(supplierPriceLists.tenantId),
        eq(supplierPriceLists.vendorId, dto.vendor_id),
        eq(supplierPriceLists.itemId, dto.item_id),
        eq(supplierPriceLists.uom, uom),
        eq(supplierPriceLists.status, 'active'),
      ))
      .returning({ id: supplierPriceLists.id });
    const [row] = await db.insert(supplierPriceLists).values({
      tenantId, vendorId: dto.vendor_id, itemId: dto.item_id,
      itemDescription: dto.item_description ?? null,
      uom, currency: dto.currency ?? 'THB',
      unitPrice: String(dto.unit_price),
      minQty: String(dto.min_qty ?? 1),
      effectiveFrom: dto.effective_from,
      effectiveTo: dto.effective_to ?? null,
      status: 'active', notes: dto.notes ?? null, createdBy: user.username,
    }).returning({ id: supplierPriceLists.id });
    return { id: Number(row!.id), superseded_id: superseded[0] ? Number(superseded[0].id) : null };
  }

  // List active supplier prices. Optionally filter by vendor_id. Returns newest effective_from first.
  async listSupplierPrices(q: { vendor_id?: number; item_id?: string }, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId;
    const conds: any[] = [eq(supplierPriceLists.status, 'active')];
    if (tenantId != null) conds.push(or(eq(supplierPriceLists.tenantId, tenantId), isNull(supplierPriceLists.tenantId))!);
    if (q.vendor_id) conds.push(eq(supplierPriceLists.vendorId, q.vendor_id));
    if (q.item_id) conds.push(eq(supplierPriceLists.itemId, q.item_id));
    const rows = await db.select({
      id: supplierPriceLists.id, vendorId: supplierPriceLists.vendorId, vendorName: vendors.name,
      itemId: supplierPriceLists.itemId, itemDescription: supplierPriceLists.itemDescription,
      uom: supplierPriceLists.uom, currency: supplierPriceLists.currency,
      unitPrice: supplierPriceLists.unitPrice, minQty: supplierPriceLists.minQty,
      effectiveFrom: supplierPriceLists.effectiveFrom, effectiveTo: supplierPriceLists.effectiveTo,
      notes: supplierPriceLists.notes,
    }).from(supplierPriceLists)
      .leftJoin(vendors, eq(supplierPriceLists.vendorId, vendors.id))
      .where(and(...conds))
      .orderBy(desc(supplierPriceLists.effectiveFrom));
    return {
      prices: rows.map((r: any) => ({
        id: Number(r.id), vendor_id: Number(r.vendorId), vendor_name: r.vendorName,
        item_id: r.itemId, item_description: r.itemDescription,
        uom: r.uom, currency: r.currency,
        unit_price: Number(r.unitPrice), min_qty: Number(r.minQty),
        effective_from: r.effectiveFrom, effective_to: r.effectiveTo, notes: r.notes,
      })),
      count: rows.length,
    };
  }

  // Full version history for a vendor+item pair (all statuses, newest first).
  async supplierPriceHistory(vendorId: number, itemId: string, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId;
    const conds: any[] = [eq(supplierPriceLists.vendorId, vendorId), eq(supplierPriceLists.itemId, itemId)];
    if (tenantId != null) conds.push(or(eq(supplierPriceLists.tenantId, tenantId), isNull(supplierPriceLists.tenantId))!);
    const rows = await db.select({
      id: supplierPriceLists.id, uom: supplierPriceLists.uom, currency: supplierPriceLists.currency,
      unitPrice: supplierPriceLists.unitPrice, minQty: supplierPriceLists.minQty,
      effectiveFrom: supplierPriceLists.effectiveFrom, effectiveTo: supplierPriceLists.effectiveTo,
      status: supplierPriceLists.status, notes: supplierPriceLists.notes,
      createdBy: supplierPriceLists.createdBy, createdAt: supplierPriceLists.createdAt,
    }).from(supplierPriceLists)
      .where(and(...conds))
      .orderBy(desc(supplierPriceLists.effectiveFrom));
    return {
      vendor_id: vendorId, item_id: itemId,
      history: rows.map((r: any) => ({
        id: Number(r.id), uom: r.uom, currency: r.currency,
        unit_price: Number(r.unitPrice), min_qty: Number(r.minQty),
        effective_from: r.effectiveFrom, effective_to: r.effectiveTo,
        status: r.status, notes: r.notes, created_by: r.createdBy, created_at: r.createdAt,
      })),
    };
  }

  // ── PO ──────────────────────────────────────────────────────────────
  async createPo(dto: CreatePoDto, user: JwtUser) {
    const db = this.db;
    if (!dto.items?.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No items', messageTh: 'ไม่มีรายการ' });
    let vendorId = dto.vendor_id ?? null;
    let vendorName = dto.vendor_name ?? null;
    if (!vendorId && vendorName) {
      const [v] = await db.select().from(vendors).where(eq(vendors.name, vendorName)).limit(1);
      vendorId = v?.id ?? null;
    } else if (vendorId && !vendorName) {
      const [v] = await db.select().from(vendors).where(eq(vendors.id, vendorId)).limit(1);
      vendorName = v?.name ?? null;
    }
    await this.assertSupplierAllowed(vendorId, vendorName); // Phase 16 — blocklisted/unapproved vendor → 422
    // M0/M2 — project dimension (nullable). project_id may be passed directly (PMR auto-draft) or resolved from a code.
    const projectId = dto.project_id ?? await this.resolveProjectId(dto.project_code);
    const isDraft = dto.draft === true; // M2 — PMR auto-draft opens as Draft (skips the approval workflow)
    const total = dto.items.reduce((a, it) => a + n(it.order_qty) * n(it.unit_price), 0);
    const poNo = await this.docNo.nextDaily('PO');
    await db.transaction(async (tx: any) => {
      const [h] = await tx.insert(purchaseOrders).values({
        poNo, poDate: ymd(), vendorId, vendorName, status: isDraft ? 'Draft' : 'Pending', totalAmount: String(total),
        createdBy: user.username, expectedDate: dto.expected_date ?? null, remarks: dto.remarks ?? null,
        currency: dto.currency ?? 'THB', fxRate: String(dto.fx_rate ?? 1), projectId,
      }).returning({ id: purchaseOrders.id });
      await tx.insert(poItems).values(dto.items.map((it) => ({
        poId: Number(h.id), itemId: it.item_id, itemDescription: it.item_description ?? null,
        orderQty: String(n(it.order_qty)), unitPrice: String(n(it.unit_price)), uom: it.uom ?? null,
        amount: String(n(it.order_qty) * n(it.unit_price)), receivedQty: '0', isCapital: it.is_capital === true, status: 'Open',
        projectId, boqLineId: it.boq_line_id ?? null,
      })));
      // M1 (PROJ-12) — a project PO line tagged to a BoQ line ENCUMBERS that line's budget. reserve() locks the
      // BoQ line (FOR UPDATE) and throws BUDGET_EXCEEDED if the line's open+consumed commitments would exceed
      // its budget — inside this tx, so an over-budget line rolls the whole PO back (nothing is created).
      if (this.commitments && projectId != null) {
        for (const it of dto.items) {
          if (it.boq_line_id == null) continue;
          await this.commitments.reserve(tx, {
            projectId, boqLineId: it.boq_line_id, amount: n(it.order_qty) * n(it.unit_price), qty: n(it.order_qty),
            sourceDocType: 'PO', sourceDocNo: poNo, createdBy: user.username, tenantId: user.tenantId ?? null,
            allowOver: dto.authorized_over_budget === true, // M2 — an approved over-budget PMR authorises the overage
          });
        }
      }
    });
    // A Draft PO (PMR auto-draft) is not yet committed — it does NOT enter the approval workflow; procurement
    // reviews and submits it. A normal PO opens Pending and routes into the approval engine.
    await this.statusLog.log('PO', poNo, '', isDraft ? 'Draft' : 'Pending', user.username);
    if (!isDraft) await this.workflow?.start({ docType: 'PO', docNo: poNo, amount: total, createdBy: user.username, tenantId: user.tenantId ?? null, context: { vendor: vendorName ?? '' } });
    return { po_no: poNo, status: isDraft ? 'Draft' : 'Pending', total_amount: total };
  }

  async approvePo(poNo: string, approve: boolean, reason: string | undefined, user: JwtUser) {
    const db = this.db;
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNo, poNo)).limit(1);
    if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found', messageTh: 'ไม่พบ PO' });
    // route through the approval engine when a workflow is configured (maker-checker + multi-level + SoD +
    // dimension routing all enforced there); otherwise fall back to the legacy Admin-only flip.
    const inst = this.workflow ? await this.workflow.pendingInstanceFor('PO', poNo) : null;
    if (inst) {
      await this.workflow!.act(Number(inst.id), { decision: approve ? 'approve' : 'reject' }, user);
      const cleared = await this.workflow!.canTransition('PO', poNo);
      const newStatus = approve ? (cleared ? 'Approved' : 'Pending') : 'Cancelled';
      await db.update(purchaseOrders).set({ status: newStatus, approvedBy: user.username, approvedAt: new Date(), remarks: approve ? po.remarks : `Rejected: ${reason ?? ''}` }).where(eq(purchaseOrders.id, po.id));
      if (newStatus !== po.status) await this.statusLog.log('PO', poNo, po.status ?? '', newStatus, user.username);
      await this.emitPo(newStatus, poNo, po, reason, user);
      return { po_no: poNo, status: newStatus };
    }
    if (user.role !== 'Admin') throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Admin only', messageTh: 'เฉพาะผู้ดูแล' });
    const newStatus = approve ? 'Approved' : 'Cancelled';
    await db.update(purchaseOrders).set({
      status: newStatus, approvedBy: user.username, approvedAt: new Date(),
      remarks: approve ? po.remarks : `Rejected: ${reason ?? ''}`,
    }).where(eq(purchaseOrders.id, po.id));
    await this.statusLog.log('PO', poNo, po.status ?? '', newStatus, user.username);
    await this.emitPo(newStatus, poNo, po, reason, user);
    return { po_no: poNo, status: newStatus };
  }

  // Fan out the PO approval/rejection to outbound webhooks (best-effort; only on a terminal decision).
  private async emitPo(newStatus: string, poNo: string, po: any, reason: string | undefined, user: JwtUser) {
    const event = newStatus === 'Approved' ? 'po.approved' : (newStatus === 'Cancelled' ? 'po.rejected' : null);
    if (!event) return;
    await this.webhooks?.emit(event, { po_no: poNo, vendor: po.vendorName ?? po.vendorCode ?? null, total_amount: Number(po.total ?? 0), status: newStatus, reason: reason ?? null, decided_by: user.username }, user);
    // D2 — close the loop: tell the requester(s) of any PR linked to this PO that it's approved / rejected.
    if (newStatus === 'Approved') await this.notifyPoPrRequesters(poNo, `✅ ใบสั่งซื้อ ${poNo} (จากคำขอซื้อของคุณ) อนุมัติแล้ว — กำลังสั่งซื้อ`);
    else if (newStatus === 'Cancelled') await this.notifyPoPrRequesters(poNo, `❌ ใบสั่งซื้อ ${poNo} (จากคำขอซื้อของคุณ) ถูกยกเลิก${reason ? ` — ${reason}` : ''}`);
  }

  async cancelPo(poNo: string, reason: string, user: JwtUser) {
    const db = this.db;
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNo, poNo)).limit(1);
    if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found', messageTh: 'ไม่พบ PO' });
    // parity: ถ้ามี GR แล้วและไม่ใช่ Admin → ปิดไม่ได้
    const [gr] = await db.select({ id: goodsReceipts.id }).from(goodsReceipts).where(eq(goodsReceipts.poNo, poNo)).limit(1);
    if (gr && user.role !== 'Admin') throw new ForbiddenException({ code: 'FORBIDDEN', message: 'PO has GR — must close via Admin', messageTh: 'มีการรับของแล้ว ต้องปิดผ่าน Admin' });
    if (!reason) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Cancel reason required', messageTh: 'ต้องระบุเหตุผล' });
    await db.update(purchaseOrders).set({ status: 'Cancelled', remarks: reason }).where(eq(purchaseOrders.id, po.id));
    await this.statusLog.log('PO', poNo, po.status ?? '', 'Cancelled', user.username, reason);
    // M1 (PROJ-12) — a cancelled PO releases the BoQ-line budget it encumbered (frees it for other draws).
    if (this.commitments) await this.commitments.release(db, 'PO', poNo);
    return { po_no: poNo, status: 'Cancelled' };
  }

  // Assemble the printable PO (header + lines + supplier + our-company/buyer block) for the PDF renderer.
  // The buyer block is the caller's tenant (the company raising the PO); the vendor block is the supplier.
  // VAT is shown as an ESTIMATE at the buyer tenant's VAT rate only when the tenant is VAT-registered — a PO
  // is a commitment, not a tax document (the ใบกำกับภาษี is issued by the supplier on delivery), so the row
  // is suppressed for non-VAT buyers rather than fabricating tax.
  async getPoForPrint(poNo: string, user: JwtUser): Promise<import('./po-pdf.service').PoPrintData> {
    const db = this.db;
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNo, poNo)).limit(1);
    if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found', messageTh: 'ไม่พบ PO' });
    const lineRows = await db.select().from(poItems).where(eq(poItems.poId, Number(po.id))).orderBy(asc(poItems.id));
    const vendorRow = po.vendorId ? (await db.select().from(vendors).where(eq(vendors.id, Number(po.vendorId))).limit(1))[0] : null;

    // Buyer = the caller's tenant (our company). HQ/bypass callers may have no tenantId → generic fallback.
    let t: any = null;
    if (user.tenantId != null) [t] = await db.select().from(tenants).where(eq(tenants.id, Number(user.tenantId))).limit(1);
    const buyerAddress = t
      ? [t.addressLine1, t.addressLine2, t.subDistrict, t.district, t.province, t.postalCode].filter(Boolean).join(' ')
      : '';

    const lines = lineRows.map((l: any) => ({
      item_id: l.itemId ?? null, description: l.itemDescription ?? null, qty: n(l.orderQty), uom: l.uom ?? null,
      unit_price: n(l.unitPrice), amount: n(l.amount ?? n(l.orderQty) * n(l.unitPrice)),
    }));
    const subtotal = lines.reduce((a, l) => a + l.amount, 0);
    const vatRate = t?.vatRegistered ? n(t.vatRate ?? 0.07) : 0;
    const vatAmount = Math.round(subtotal * vatRate * 100) / 100;
    // Resolve the tenant's active PO template (presentation only); a lookup failure never blocks the doc.
    let template = normalizeA4Template({});
    try { if (this.docTemplates) template = normalizeA4Template(await this.docTemplates.resolveActive('purchase_order')); } catch { /* keep default */ }

    return {
      po_no: po.poNo, po_date: po.poDate ?? null, expected_date: po.expectedDate ?? null, status: String(po.status ?? ''),
      remarks: po.remarks ?? null, currency: po.currency ?? 'THB', created_by: po.createdBy ?? null,
      approved_by: po.approvedBy ?? null, approved_at: po.approvedAt ? new Date(po.approvedAt).toISOString() : null,
      buyer: {
        name: t?.legalName || t?.name || 'บริษัทของฉัน', address: buyerAddress || (t?.address ?? '-'),
        tax_id: t?.taxId ?? null, branch_label: t?.branchLabelTh ?? 'สำนักงานใหญ่', phone: t?.phone ?? null,
        logo_url: t?.logoUrl ?? null,
      },
      vendor: {
        code: vendorRow?.vendorCode ?? null, name: vendorRow?.name ?? po.vendorName ?? '-', address: vendorRow?.address ?? null, tax_id: vendorRow?.taxId ?? null,
        contact: vendorRow?.contact ?? null, phone: vendorRow?.phone ?? null, payment_terms: vendorRow?.paymentTerms ?? null,
      },
      lines, subtotal, vat_rate: vatRate, vat_amount: vatAmount, grand_total: Math.round((subtotal + vatAmount) * 100) / 100, template,
    };
  }

  renderGrPdf(g: GrPrintData): Promise<Buffer | null> { return this.grPdf ? this.grPdf.renderToPdf(this.grPdf.goodsReceiptHtml(g)) : Promise.resolve(null); }





  // Fetch and populate product images for catalog items (shop /order items) from the internet.
  // Fetches images based on item descriptions and stores them as data URLs in the item_images table.
  // ── docs/38 procurement PR-2: GRN (receiving) lives in ProcurementGrnService; thin delegators. ──
  async getGrForPrint(grNo: string, user: JwtUser): Promise<GrPrintData> { return this.grn.getGrForPrint(grNo, user); }
  goodsReceiptHtml(g: GrPrintData): string { return this.grn.goodsReceiptHtml(g); }
  async listGrs(user: JwtUser, limit = 50) { return this.grn.listGrs(user, limit); }
  async emailGr(grNo: string, toEmail: string | undefined, user: JwtUser) { return this.grn.emailGr(grNo, toEmail, user); }
  async createGr(dto: CreateGrDto, user: JwtUser) { return this.grn.createGr(dto, user); }
  async receiveAllRemaining(poNo: string, user: JwtUser) { return this.grn.receiveAllRemaining(poNo, user); }
  async receiveItem(poNo: string, itemId: string, qty: number, user: JwtUser) { return this.grn.receiveItem(poNo, itemId, qty, user); }

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

  // ── Match-merge / DQM (master-data audit Phase 5) ────────────────────────────────────────────────
  // Detect probable duplicate vendors within the tenant: exact tax-id/email/phone signals + fuzzy name
  // similarity (app-side trigram — pg_trgm isn't enabled here). Read-only steward review queue.
  async findVendorDuplicates(user: JwtUser) {
    const db = this.db;
    const conds = [ne(vendors.active, false)];
    if (user.tenantId != null) conds.push(eq(vendors.tenantId, user.tenantId));
    const rows = await db.select().from(vendors).where(and(...conds)).orderBy(desc(vendors.id)).limit(1000);
    const used = new Set<number>();
    const groups: any[] = [];
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i]; if (!a || used.has(Number(a.id))) continue;
      const dups: any[] = [];
      for (let j = i + 1; j < rows.length; j++) {
        const b = rows[j]; if (!b || used.has(Number(b.id))) continue;
        const reasons: string[] = [];
        if (a.taxId && b.taxId && normalizeKey(a.taxId) === normalizeKey(b.taxId)) reasons.push('tax_id');
        if (a.email && b.email && normalizeKey(a.email) === normalizeKey(b.email)) reasons.push('email');
        if (a.phone && b.phone && normalizeKey(a.phone) === normalizeKey(b.phone)) reasons.push('phone');
        const score = nameSimilarity(a.name, b.name);
        if (score >= 0.6) reasons.push('name');
        if (reasons.length) { dups.push({ vendor_id: Number(b.id), vendor_code: b.vendorCode, name: b.name, score: Math.round(score * 100) / 100, reasons }); used.add(Number(b.id)); }
      }
      if (dups.length) { used.add(Number(a.id)); groups.push({ primary: { vendor_id: Number(a.id), vendor_code: a.vendorCode, name: a.name }, duplicates: dups }); }
    }
    return { groups, count: groups.length };
  }

  // Merge a duplicate vendor INTO a survivor: repoint the duplicate's child rows (POs, AP txns, addresses,
  // contacts, price-lists, …) to the survivor, fill blank survivor fields from the duplicate (survivorship),
  // and soft-retire the duplicate (active=false + merged_into/by/at). Atomic — a unique-key collision rolls
  // back and surfaces MERGE_CONFLICT for manual steward resolution. Gated to md_vendor/masterdata/exec.
  async mergeVendor(survivorId: number, duplicateId: number, user: JwtUser) {
    if (survivorId === duplicateId) throw new BadRequestException({ code: 'SELF_MERGE', message: 'Cannot merge a vendor into itself', messageTh: 'ไม่สามารถรวมผู้ขายเข้ากับตัวเองได้' });
    const survivor = await this.vendorById(survivorId);
    const dup = await this.vendorById(duplicateId);
    if (dup.active === false && dup.mergedInto != null) throw new BadRequestException({ code: 'ALREADY_MERGED', message: 'Duplicate is already merged', messageTh: 'ผู้ขายรายนี้ถูกรวมไปแล้ว' });
    const db = this.db;
    try {
      await db.transaction(async (tx: any) => {
        await tx.execute(sql`SELECT md_merge_repoint('vendor_id', 'vendors', ${survivorId}, ${duplicateId})`);
        // re-parent any subsidiaries that pointed at the duplicate
        await tx.update(vendors).set({ parentVendorId: survivorId }).where(eq(vendors.parentVendorId, duplicateId));
        const fill: Record<string, unknown> = {};
        const pick = (k: string, s: unknown, d: unknown) => { if ((s === null || s === undefined || s === '') && d !== null && d !== undefined && d !== '') fill[k] = d; };
        pick('contact', survivor.contact, dup.contact); pick('phone', survivor.phone, dup.phone); pick('email', survivor.email, dup.email);
        pick('address', survivor.address, dup.address); pick('taxId', survivor.taxId, dup.taxId); pick('paymentTerms', survivor.paymentTerms, dup.paymentTerms);
        pick('category', survivor.category, dup.category); pick('currency', survivor.currency, dup.currency); pick('notes', survivor.notes, dup.notes);
        if (Object.keys(fill).length) await tx.update(vendors).set(fill).where(eq(vendors.id, survivorId));
        await tx.update(vendors).set({ active: false, mergedInto: survivorId, mergedBy: user.username, mergedAt: new Date() }).where(eq(vendors.id, duplicateId));
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException({ code: 'MERGE_CONFLICT', message: 'Survivor and duplicate both own a row with the same key — resolve manually', messageTh: 'ผู้ขายทั้งสองมีรายการที่ซ้ำกัน กรุณาแก้ไขก่อนรวม' });
      throw e;
    }
    return { survivor_id: survivorId, merged_id: duplicateId, merged: true };
  }

  // ── Change history (master-data audit Phase 6) — the append-only field-level trail (ITGC-AC-14) for this
  // vendor + its address/contact children, captured by the DB trigger (0274). Read-only, tenant-scoped.
  async vendorHistory(vendorId: number, user: JwtUser) {
    const db = this.db;
    await this.vendorById(vendorId);
    const vid = String(vendorId);
    const conds = [
      or(
        and(eq(dataChangeLog.tableName, 'vendors'), eq(dataChangeLog.rowPk, vid)),
        and(inArray(dataChangeLog.tableName, ['vendor_addresses', 'vendor_contacts']),
          sql`coalesce(${dataChangeLog.newValue}->>'vendor_id', ${dataChangeLog.oldValue}->>'vendor_id') = ${vid}`),
      ),
    ];
    if (user.tenantId != null) conds.push(eq(dataChangeLog.tenantRef, user.tenantId));
    const rows = await db.select().from(dataChangeLog).where(and(...conds)).orderBy(desc(dataChangeLog.ts)).limit(200);
    return { vendor_id: vendorId, history: shapeChangeHistory(rows), count: rows.length };
  }

  // ── Typed party relationships (master-data audit Phase 8) ────────────────────────────────────────
  async addVendorRelationship(vendorId: number, dto: { to_vendor_id: number; rel_type: string; note?: string }, user: JwtUser) {
    const db = this.db;
    const from = await this.vendorById(vendorId);
    if (dto.to_vendor_id === vendorId) throw new BadRequestException({ code: 'SELF_RELATION', message: 'A vendor cannot relate to itself', messageTh: 'ผู้ขายไม่สามารถเชื่อมโยงกับตัวเองได้' });
    const to = await this.vendorById(dto.to_vendor_id);
    try {
      const [row] = await db.insert(vendorRelationships).values({
        tenantId: from.tenantId ?? null, fromVendorId: vendorId, toVendorId: dto.to_vendor_id,
        relType: dto.rel_type, note: dto.note ?? null, createdBy: user.username,
      }).returning();
      return shapeVendorRelationship(row, { vendor_id: dto.to_vendor_id, name: to.name }, 'outgoing');
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException({ code: 'RELATION_EXISTS', message: 'This relationship already exists', messageTh: 'มีความสัมพันธ์นี้อยู่แล้ว' });
      throw e;
    }
  }

  async listVendorRelationships(vendorId: number, _user: JwtUser) {
    const db = this.db;
    await this.vendorById(vendorId);
    const toV = alias(vendors, 'to_v');
    const fromV = alias(vendors, 'from_v');
    const outgoing = await db.select({ r: vendorRelationships, name: toV.name })
      .from(vendorRelationships).innerJoin(toV, eq(vendorRelationships.toVendorId, toV.id))
      .where(eq(vendorRelationships.fromVendorId, vendorId)).orderBy(desc(vendorRelationships.id));
    const incoming = await db.select({ r: vendorRelationships, name: fromV.name })
      .from(vendorRelationships).innerJoin(fromV, eq(vendorRelationships.fromVendorId, fromV.id))
      .where(eq(vendorRelationships.toVendorId, vendorId)).orderBy(desc(vendorRelationships.id));
    return {
      vendor_id: vendorId,
      relationships: [
        ...outgoing.map((x: any) => shapeVendorRelationship(x.r, { vendor_id: Number(x.r.toVendorId), name: x.name }, 'outgoing')),
        ...incoming.map((x: any) => shapeVendorRelationship(x.r, { vendor_id: Number(x.r.fromVendorId), name: x.name }, 'incoming')),
      ],
    };
  }

  async deleteVendorRelationship(vendorId: number, relId: number, _user: JwtUser) {
    const del = await this.db.delete(vendorRelationships)
      .where(and(eq(vendorRelationships.id, relId), or(eq(vendorRelationships.fromVendorId, vendorId), eq(vendorRelationships.toVendorId, vendorId))))
      .returning({ id: vendorRelationships.id });
    if (!del.length) throw new NotFoundException({ code: 'RELATION_NOT_FOUND', message: 'Relationship not found', messageTh: 'ไม่พบความสัมพันธ์นี้' });
    return { deleted: true };
  }
}
