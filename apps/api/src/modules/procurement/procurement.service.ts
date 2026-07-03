import { Inject, Injectable, Optional, NotFoundException, ForbiddenException, BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { sql, eq, and, desc, asc, isNull, or } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { purchaseRequests, prItems, purchaseOrders, poItems, goodsReceipts, grItems, lotLedger, stockMovements, vendors, supplierScorecards, supplierPriceLists, items } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { WorkflowService } from '../workflow/workflow.service';
import { CostingService } from '../costing/costing.service';
import { WebhookService } from '../platform/webhook.service';
import { ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const n = (v: unknown) => Number(v ?? 0);

export interface CreatePrDto { items: { item_id: string; item_description?: string; request_qty: number; uom?: string; required_date?: string; reason?: string }[]; remarks?: string; priority?: string; amount?: number }
export interface CreatePoDto { vendor_id?: number; vendor_name?: string; expected_date?: string; remarks?: string; currency?: string; fx_rate?: number; items: { item_id: string; item_description?: string; order_qty: number; unit_price: number; uom?: string; is_capital?: boolean }[] }
export interface CreateGrDto { po_no: string; remarks?: string; items: { item_id: string; received_qty: number; lot_no?: string; expiry_date?: string; unit_cost?: number; uom?: string }[] }
export interface UpsertSupplierPriceDto { vendor_id: number; item_id: string; item_description?: string; uom?: string; currency?: string; unit_price: number; min_qty?: number; effective_from: string; effective_to?: string; notes?: string }

@Injectable()
export class ProcurementService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly statusLog: StatusLogService,
    // @Optional + last so harnesses that construct this service directly (writeflow) without the engine still work
    @Optional() private readonly workflow?: WorkflowService,
    @Optional() private readonly costing?: CostingService, // Phase 17A — inventory costing (opt-in per item)
    @Optional() private readonly webhooks?: WebhookService, // Phase 8 — outbound webhook fan-out (best-effort)
  ) {}

  // ── PR ──────────────────────────────────────────────────────────────
  async createPr(dto: CreatePrDto, user: JwtUser) {
    const db = this.db;
    if (!dto.items?.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No items', messageTh: 'ไม่มีรายการ' });
    const prNo = await this.docNo.nextDaily('PR');
    await db.transaction(async (tx: any) => {
      const [h] = await tx.insert(purchaseRequests).values({
        prNo, prDate: ymd(), requestedBy: user.username, status: 'Pending', remarks: dto.remarks ?? null, priority: dto.priority ?? 'Normal',
      }).returning({ id: purchaseRequests.id });
      await tx.insert(prItems).values(dto.items.map((it) => ({
        prId: Number(h.id), itemId: it.item_id, itemDescription: it.item_description ?? null,
        requestQty: String(n(it.request_qty)), uom: it.uom ?? null, requiredDate: it.required_date ?? null,
        reason: it.reason ?? null, status: 'Open',
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
    const byPr = new Map<number, any[]>();
    for (const l of lines) { const k = Number(l.prId); (byPr.get(k) ?? byPr.set(k, []).get(k)!).push(l); }
    return {
      can_approve: canSeeAll,
      prs: heads.map((h: any) => ({
        pr_no: h.prNo, pr_date: h.prDate, requested_by: h.requestedBy, status: h.status, priority: h.priority,
        approved_by: h.approvedBy ?? null,
        lines: (byPr.get(Number(h.id)) ?? []).map((l: any) => ({ item_id: l.itemId, request_qty: n(l.requestQty), uom: l.uom ?? null, reason: l.reason ?? null })),
      })),
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
    const total = dto.items.reduce((a, it) => a + n(it.order_qty) * n(it.unit_price), 0);
    const poNo = await this.docNo.nextDaily('PO');
    await db.transaction(async (tx: any) => {
      const [h] = await tx.insert(purchaseOrders).values({
        poNo, poDate: ymd(), vendorId, vendorName, status: 'Pending', totalAmount: String(total),
        createdBy: user.username, expectedDate: dto.expected_date ?? null, remarks: dto.remarks ?? null,
        currency: dto.currency ?? 'THB', fxRate: String(dto.fx_rate ?? 1),
      }).returning({ id: purchaseOrders.id });
      await tx.insert(poItems).values(dto.items.map((it) => ({
        poId: Number(h.id), itemId: it.item_id, itemDescription: it.item_description ?? null,
        orderQty: String(n(it.order_qty)), unitPrice: String(n(it.unit_price)), uom: it.uom ?? null,
        amount: String(n(it.order_qty) * n(it.unit_price)), receivedQty: '0', isCapital: it.is_capital === true, status: 'Open',
      })));
    });
    await this.statusLog.log('PO', poNo, '', 'Pending', user.username);
    // route into the approval engine (no active PO definition → autoApproved, legacy passthrough). The vendor
    // is supplied as dimension context so a workflow can route e.g. a specific vendor to a special approver.
    await this.workflow?.start({ docType: 'PO', docNo: poNo, amount: total, createdBy: user.username, tenantId: user.tenantId ?? null, context: { vendor: vendorName ?? '' } });
    return { po_no: poNo, status: 'Pending', total_amount: total };
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
    return { po_no: poNo, status: 'Cancelled' };
  }

  // ── GR ── (received_qty++ ; stock_movement ; lot_ledger ; auto-close PO)
  async createGr(dto: CreateGrDto, user: JwtUser) {
    const db = this.db;
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNo, dto.po_no)).limit(1);
    if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found', messageTh: 'ไม่พบ PO' });
    // EXP-03 — a PO must clear its approval (maker-checker + DoA thresholds, enforced by the workflow engine)
    // BEFORE goods can be received against it; otherwise an unapproved/cancelled PO could trigger a GR and an
    // AP liability, defeating the 3-way match. Receivable = past approval (Approved or a part-received/closed
    // state); block the not-yet-approved / dead states.
    if (['Pending', 'Draft', 'Rejected', 'Cancelled'].includes(String(po.status))) {
      throw new ForbiddenException({ code: 'PO_NOT_APPROVED', message: `Cannot receive against a '${po.status}' PO — it must be approved first`, messageTh: `รับสินค้าไม่ได้: PO สถานะ '${po.status}' ต้องได้รับอนุมัติก่อน` });
    }
    const lines = (dto.items ?? []).filter((it) => n(it.received_qty) > 0);
    if (!lines.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No received qty', messageTh: 'ไม่มีจำนวนรับ' });

    const grNo = await this.docNo.nextDaily('GR');
    const today = ymd();
    const now = new Date();
    const costingLines: any[] = []; // Phase 17A — capitalize configured items (Dr 1200 / Cr 2000)

    await db.transaction(async (tx: any) => {
      const [gh] = await tx.insert(goodsReceipts).values({
        grNo, grDate: today, poNo: dto.po_no, vendorId: po.vendorId, vendorName: po.vendorName, receivedBy: user.username, remarks: dto.remarks ?? null,
        currency: po.currency ?? 'THB', fxRate: po.fxRate ?? '1.000000',
      }).returning({ id: goodsReceipts.id });

      for (const it of lines) {
        const recv = n(it.received_qty);
        const [poi] = await tx.select().from(poItems).where(and(eq(poItems.poId, po.id), eq(poItems.itemId, it.item_id))).limit(1);
        // FA-10: a capital line (PO-line override, else item-master flag) is routed to the asset register
        // (Dr 1500 via the registration maker-checker) — NOT capitalised into inventory (Dr 1200) here, or it
        // would double-count. We still record the GR line + stock movement for the receipt audit trail.
        let isCapital = poi?.isCapital === true;
        if (!isCapital) {
          const [im] = await tx.select({ f: items.isFixedAsset }).from(items).where(eq(items.itemId, it.item_id)).limit(1);
          isCapital = im?.f === true;
        }
        await tx.insert(grItems).values({
          grId: Number(gh.id), poNo: dto.po_no, itemId: it.item_id, itemDescription: poi?.itemDescription ?? null,
          poQty: poi?.orderQty ?? null, receivedQty: String(recv), uom: it.uom ?? poi?.uom ?? null,
          lotNo: it.lot_no ?? null, expiryDate: it.expiry_date ?? null, unitCost: it.unit_cost != null ? String(it.unit_cost) : (poi?.unitPrice ?? null),
          isCapital,
        });
        if (poi) await tx.update(poItems).set({ receivedQty: sql`${poItems.receivedQty} + ${recv}` }).where(eq(poItems.id, poi.id));
        // Phase 17A — build cost basis (FIFO layer / AVG running cost) for configured items (capital goods excluded)
        if (this.costing && user.tenantId != null && !isCapital) {
          const actualCost = Number(it.unit_cost ?? poi?.unitPrice ?? 0);
          const c = await this.costing.onReceipt(tx, { tenantId: user.tenantId, itemId: it.item_id, qty: recv, unitCost: actualCost, grNo, date: today });
          if (c.active) costingLines.push({ itemId: it.item_id, qty: recv, actualCost, method: c.method, standardCost: c.standardCost ?? 0 });
        }
        // stock movement (audit log; ไม่ปรับ snapshot — คง model V1)
        await tx.insert(stockMovements).values({
          moveDate: now, docNo: grNo, moveType: 'GR', itemId: it.item_id, itemDescription: poi?.itemDescription ?? null,
          uom: it.uom ?? poi?.uom ?? null, qty: String(recv), fromLocation: 'Supplier', toLocation: 'Warehouse', refDoc: dto.po_no, createdBy: user.username,
        });
        // lot ledger (เฉพาะมี lot_no)
        if (it.lot_no) {
          await tx.insert(lotLedger).values({
            lotNo: it.lot_no, itemId: it.item_id, itemDescription: poi?.itemDescription ?? null, uom: it.uom ?? poi?.uom ?? null,
            locationId: 'WH-MAIN', grNo, qtyIn: String(recv), qtyOut: '0', balance: String(recv),
            expiryDate: it.expiry_date ?? null, status: 'Active', moveDate: now, refDoc: grNo, createdBy: user.username,
          });
        }
      }
    });

    // auto-close: Closed ถ้าทุก line received >= order; else Received
    const allItems = await db.select().from(poItems).where(eq(poItems.poId, po.id));
    const fullyReceived = allItems.every((i: any) => n(i.receivedQty) >= n(i.orderQty));
    const newStatus = fullyReceived ? 'Closed' : 'Received';
    await db.update(purchaseOrders).set({ status: newStatus }).where(eq(purchaseOrders.id, po.id));
    await this.statusLog.log('GR', grNo, '', 'Open', user.username);
    await this.statusLog.log('PO', dto.po_no, po.status ?? '', newStatus, user.username, `GR ${grNo}`);

    // Phase 17A — capitalize inventory for configured items (after the GR tx; idempotent on GRV/grNo)
    if (this.costing && costingLines.length) await this.costing.postReceiptGl({ tenantId: user.tenantId as number, grNo, date: today, lines: costingLines, createdBy: user.username });

    return { gr_no: grNo, po_no: dto.po_no, po_status: newStatus, lines: lines.length, costed: costingLines.length > 0 };
  }
}
