import { NotFoundException, BadRequestException, UnprocessableEntityException, ConflictException } from '@nestjs/common';
import { assertMakerChecker } from '../../common/control-profile';
import { sql, eq, ne, and, desc, isNull, isNotNull, or, inArray } from 'drizzle-orm';
import { isUniqueViolation } from '../../common/db-error';
import { nameSimilarity, normalizeKey } from '../../common/text-similarity';
import type { DrizzleDb } from '../../database/database.module';
import { purchaseOrders, goodsReceipts, grItems, grClaims, vendors, supplierScorecards, supplierPriceLists, vendorBankChangeRequests, vendorAddresses, vendorContacts, dataChangeLog, vendorRelationships } from '../../database/schema';
import { alias } from 'drizzle-orm/pg-core';
import { shapeChangeHistory } from '../../common/change-history';
import { isValidPostalCode, normalizeProvince } from '../../common/thai-address';
import { normalizeBank } from '../../common/thai-banks';
import { DocNumberService } from '../../common/doc-number.service';
import type { JwtUser } from '../../common/decorators';
import { n, shapeVendorRelationship, shapeVendorAddress, shapeVendorContact } from './procurement.shared';
import type { UpsertSupplierPriceDto } from './procurement.shared';

// docs/46 G4 extraction — the VENDOR MASTER governance half of the procurement facade: supplier screening
// (Phase 16), profile/party-model maintenance (addresses/contacts/parent), the 0270 bank-detail
// maker-checker, scorecards, the supplier price list (T2-D), and the match-merge/DQM steward tools.
// A plain ctor-body class (NOT DI) built by ProcurementService's constructor, exactly like the
// PR/PO/GRN sub-services — goldenmaster/writeflow construct the facade positionally with
// (db, docNo, statusLog), so this class may only depend on those injected deps.
export class ProcurementVendorService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

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
  // taxId/creditLimit/bankName/bankAccount/bankAccountName AND paymentTerms are intentionally excluded here:
  // tax ID and bank account are encrypted PII, and credit limit / bank details / payment terms are
  // payment-redirection / credit-exposure SENSITIVE fields now routed through the single-record master-data
  // change maker-checker (GRC-3, MDM-01 — POST /api/masterdata/change-requests) so a change applies only on a
  // DISTINCT user's approval. Identity fields vendor_code/name/is_supplier/is_creditor also excluded — those
  // still only come in via the /master-data bulk import.
  async updateVendorProfile(vendorId: number, dto: {
    contact?: string | null; phone?: string | null; email?: string | null; address?: string | null;
    lead_time_days?: number | null; rating?: number | null; category?: string | null; currency?: string | null; notes?: string | null;
  }, _user: JwtUser) {
    const db = this.db;
    const set: Record<string, unknown> = {};
    if (dto.contact !== undefined) set.contact = dto.contact || null;
    if (dto.phone !== undefined) set.phone = dto.phone || null;
    if (dto.email !== undefined) set.email = dto.email || null;
    if (dto.address !== undefined) set.address = dto.address || null;
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

  async approveBankChange(reqNo: string, approver: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const r = await this.bankChangeByNo(reqNo);
    await assertMakerChecker(db, { user: approver, maker: r.requestedBy, event: 'ap.vendor-bank-change.approve', ref: reqNo, reason: selfApprovalReason, code: 'SOD_VIOLATION', message: 'The requester cannot approve their own bank-detail change', messageTh: 'ผู้ขอไม่สามารถอนุมัติคำขอของตนเองได้' });
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
  // Scorecard recompute — all three dimensions are now computed from the vendor's own receipt/claim
  // history (previously on-time/quality were hard-coded 100):
  //  • on_time_pct: of this vendor's receipts whose PO carried an expected_date, the % received on/before it.
  //  • quality_pct: 100 − defect rate = 100 − sum(gr_claim.claim_qty)/sum(gr.received_qty)·100 (floored at 0).
  //  • price_var_pct: avg |actual unit_cost − active list price| / list · 100 across matched GR items.
  // No measurable data (no dated PO / no receipts) leaves the respective dimension at 100 so a brand-new
  // vendor isn't penalised for absence of evidence. Overall score = mean of the three (price as 100−var).
  async recomputeScorecard(vendorId: number, period: string, user: JwtUser) {
    const db = this.db;
    const [g] = await db.select({ c: sql<string>`count(*)` }).from(goodsReceipts).where(eq(goodsReceipts.vendorId, vendorId));
    const grCount = Number(g?.c ?? 0);

    // On-time delivery: compare each receipt's gr_date to its PO's expected_date (ISO date strings compare
    // lexicographically). Only receipts whose PO has an expected_date are measurable.
    const otRows = await db.select({ grDate: goodsReceipts.grDate, expected: purchaseOrders.expectedDate })
      .from(goodsReceipts)
      .innerJoin(purchaseOrders, eq(goodsReceipts.poNo, purchaseOrders.poNo))
      .where(and(eq(goodsReceipts.vendorId, vendorId), isNotNull(purchaseOrders.expectedDate), isNotNull(goodsReceipts.grDate)));
    let onTime = 100;
    if (otRows.length) {
      const onTimeN = otRows.filter((r: any) => String(r.grDate) <= String(r.expected)).length;
      onTime = Math.round((onTimeN / otRows.length) * 10000) / 100;
    }

    // Quality: defect rate from goods-receipt claims (EXP-12) against total received quantity.
    const [recvAgg] = await db.select({ recv: sql<string>`coalesce(sum(${grItems.receivedQty}),0)` })
      .from(grItems).innerJoin(goodsReceipts, eq(grItems.grId, goodsReceipts.id))
      .where(eq(goodsReceipts.vendorId, vendorId));
    const [claimAgg] = await db.select({ claimed: sql<string>`coalesce(sum(${grClaims.claimQty}),0)`, cnt: sql<string>`count(*)` })
      .from(grClaims).where(eq(grClaims.vendorId, vendorId));
    const recvQty = Number(recvAgg?.recv ?? 0);
    const claimedQty = Number(claimAgg?.claimed ?? 0);
    const claimCount = Number(claimAgg?.cnt ?? 0);
    let quality = 100;
    if (recvQty > 0) quality = Math.round((100 - Math.min(100, (claimedQty / recvQty) * 100)) * 100) / 100;

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
    await db.insert(supplierScorecards).values({ tenantId: user.tenantId ?? null, vendorId, period, onTimePct: String(onTime), qualityPct: String(quality), priceVarPct: String(priceVar), score: String(score), grCount, claimCount, createdBy: user.username })
      .onConflictDoUpdate({ target: [supplierScorecards.vendorId, supplierScorecards.period], set: { onTimePct: String(onTime), qualityPct: String(quality), score: String(score), grCount, claimCount, priceVarPct: String(priceVar) } });
    await db.update(vendors).set({ scorecardScore: String(score) }).where(eq(vendors.id, vendorId));
    return { vendor_id: vendorId, period, score, gr_count: grCount, on_time_pct: onTime, quality_pct: quality, claim_count: claimCount, price_var_pct: priceVar };
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
