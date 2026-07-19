import { Inject, Injectable, Optional, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { purchaseRequests, prItems, projects } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { WorkflowService } from '../workflow/workflow.service';
import { CostingService } from '../costing/costing.service';
import { WebhookService } from '../platform/webhook.service';
import { LineNotifyService } from '../messaging/line-notify.service';
import { CommitmentsService } from '../commitments/commitments.service';
import { GrPdfService, type GrPrintData } from './gr-pdf.service';
import { ProcurementGrnService } from './procurement-grn.service';
import { ProcurementPoService } from './procurement-po.service';
import { ProcurementPrService } from './procurement-pr.service';
import { ProcurementVendorService } from './procurement-vendor.service';
import { ProcurementCatalogService } from './procurement-catalog.service';
import { DocEmailService } from '../mail/doc-email.service';
import { DocumentTemplatesService } from '../document-templates/document-templates.service';
import { ImageFetchService } from './image-fetch.service';
import type { JwtUser } from '../../common/decorators';
// Re-exported so existing `import type { CreatePrDto } from './procurement.service'` callers are unchanged.
export type { CreatePrDto, CreatePoDto, CreateGrDto, UpsertSupplierPriceDto, ConvLine } from './procurement.shared';
import type { CreatePrDto, CreatePoDto, CreateGrDto, UpsertSupplierPriceDto } from './procurement.shared';


// docs/38 PR-2..4 + docs/46 G4: the procurement FACADE. All domain logic lives in the five ctor-body
// sub-services (grn / po / pr / vendor / catalog); this class only wires them together and keeps the
// public method surface stable for the controller, cross-module callers and the goldenmaster/writeflow
// harnesses (which construct it positionally with (db, docNo, statusLog) — so sub-services are built in
// the ctor BODY from the injected deps, never DI'd).
@Injectable()
export class ProcurementService {
  private readonly grn: ProcurementGrnService;
  private readonly po: ProcurementPoService;
  private readonly pr: ProcurementPrService;
  private readonly vendor: ProcurementVendorService;
  private readonly cat: ProcurementCatalogService;

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
    this.vendor = new ProcurementVendorService(db, docNo);
    this.cat = new ProcurementCatalogService(db, imageFetch, (vid, vname) => this.vendor.assertSupplierAllowed(vid, vname));
    this.grn = new ProcurementGrnService(db, docNo, statusLog, (poNo, msg) => this.notifyPoPrRequesters(poNo, msg), costing, commitments, grPdf, docEmail);
    this.po = new ProcurementPoService(db, docNo, statusLog, (vid, vname) => this.vendor.assertSupplierAllowed(vid, vname), (code) => this.resolveProjectId(code), (poNo, msg) => this.notifyPoPrRequesters(poNo, msg), workflow, webhooks, commitments, docTemplates);
    this.pr = new ProcurementPrService(db, docNo, statusLog, (code) => this.resolveProjectId(code), (u) => this.cat.lowStock(u), (itemId, dto, u) => this.cat.setPreferredVendor(itemId, dto, u), (dto, u) => this.po.createPo(dto, u), workflow, lineNotify, commitments);
  }

  // D2 — best-effort LINE push to the requester(s) of every PR linked to a PO (pr_items.po_no), closing
  // the loop when their requisition is bought/received. No-op for unlinked users; never blocks the flow.
  private async notifyPoPrRequesters(poNo: string, text: string): Promise<void> {
    if (!this.lineNotify) return;
    try {
      // purchase_requests is tenant-scoped (0387); this runs in-scope so it only sees same-tenant requesters.
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

  // ── docs/38 procurement PR-4: requisitions live in ProcurementPrService; thin delegators. ──
  async createPr(dto: CreatePrDto, user: JwtUser) { return this.pr.createPr(dto, user); }
  async approvePr(prNo: string, approve: boolean, user: JwtUser, budgetOpts?: { confirmOverBudget?: boolean; overrideBudget?: boolean; overrideReason?: string }) { return this.pr.approvePr(prNo, approve, user, budgetOpts); }
  async cancelPr(prNo: string, user: JwtUser) { return this.pr.cancelPr(prNo, user); }
  async listPrs(user: JwtUser, opts?: { limit?: number; mine?: boolean }) { return this.pr.listPrs(user, opts); }
  async reorderPr(user: JwtUser) { return this.pr.reorderPr(user); }
  async convertPrToPo(prNo: string, dto: Parameters<ProcurementPrService['convertPrToPo']>[1], user: JwtUser) { return this.pr.convertPrToPo(prNo, dto, user); }

  // ── docs/46 G4: catalog / sourcing lives in ProcurementCatalogService; thin delegators. ──
  async searchItems(q: string, limit = 8) { return this.cat.searchItems(q, limit); }
  async catalog(user: JwtUser, opts?: { q?: string; category?: string; barcode?: string; limit?: number; offset?: number }) { return this.cat.catalog(user, opts); }
  async catalogItemImage(user: JwtUser, itemId: string) { return this.cat.catalogItemImage(user, itemId); }
  async searchVendors(q: string, limit = 8) { return this.cat.searchVendors(q, limit); }
  async suggestSuppliersForItems(itemIds: string[], user: JwtUser) { return this.cat.suggestSuppliersForItems(itemIds, user); }
  async setPreferredVendor(itemId: string, dto: { vendor_id: number; unit_price?: number; uom?: string; currency?: string; remove?: boolean }, user: JwtUser) { return this.cat.setPreferredVendor(itemId, dto, user); }
  async purchaseSpend(user: JwtUser, opts?: { period?: string }) { return this.cat.purchaseSpend(user, opts); }
  async lowStock(user: JwtUser, opts?: { limit?: number }) { return this.cat.lowStock(user, opts); }
  async populateItemImages(itemIds?: string[]) { return this.cat.populateItemImages(itemIds); }
  async fetchItemImage(itemId: string): Promise<string> { return this.cat.fetchItemImage(itemId); }
  async storeItemImage(itemId: string, dataUrl: string) { return this.cat.storeItemImage(itemId, dataUrl); }

  // ── docs/46 G4: vendor master governance lives in ProcurementVendorService; thin delegators. ──
  async assertSupplierAllowed(vendorId: number | null, vendorName: string | null) { return this.vendor.assertSupplierAllowed(vendorId, vendorName); }
  async setSupplierStatus(vendorId: number, dto: { approval_status?: string; blocklisted?: boolean; reason?: string }, user: JwtUser) { return this.vendor.setSupplierStatus(vendorId, dto, user); }
  async updateVendorProfile(vendorId: number, dto: Parameters<ProcurementVendorService['updateVendorProfile']>[1], user: JwtUser) { return this.vendor.updateVendorProfile(vendorId, dto, user); }
  async setVendorParent(vendorId: number, parentVendorId: number | null, user: JwtUser) { return this.vendor.setVendorParent(vendorId, parentVendorId, user); }
  async addVendorAddress(vendorId: number, dto: Parameters<ProcurementVendorService['addVendorAddress']>[1], user: JwtUser) { return this.vendor.addVendorAddress(vendorId, dto, user); }
  async listVendorAddresses(vendorId: number, user: JwtUser) { return this.vendor.listVendorAddresses(vendorId, user); }
  async deleteVendorAddress(vendorId: number, addressId: number, user: JwtUser) { return this.vendor.deleteVendorAddress(vendorId, addressId, user); }
  async addVendorContact(vendorId: number, dto: { name: string; title?: string; phone?: string; email?: string; notes?: string; is_primary?: boolean }, user: JwtUser) { return this.vendor.addVendorContact(vendorId, dto, user); }
  async listVendorContacts(vendorId: number, user: JwtUser) { return this.vendor.listVendorContacts(vendorId, user); }
  async deleteVendorContact(vendorId: number, contactId: number, user: JwtUser) { return this.vendor.deleteVendorContact(vendorId, contactId, user); }
  async stageBankChange(vendorId: number, dto: { bank_name?: string; bank_account?: string }, user: JwtUser) { return this.vendor.stageBankChange(vendorId, dto, user); }
  async pendingBankChanges(user: JwtUser) { return this.vendor.pendingBankChanges(user); }
  async approveBankChange(reqNo: string, approver: JwtUser, selfApprovalReason?: string | null) { return this.vendor.approveBankChange(reqNo, approver, selfApprovalReason); }
  async rejectBankChange(reqNo: string, approver: JwtUser, reason?: string) { return this.vendor.rejectBankChange(reqNo, approver, reason); }
  async recomputeScorecard(vendorId: number, period: string, user: JwtUser) { return this.vendor.recomputeScorecard(vendorId, period, user); }
  async listScorecards(q: { period?: string; limit?: number }, user: JwtUser) { return this.vendor.listScorecards(q, user); }
  async upsertSupplierPrice(dto: UpsertSupplierPriceDto, user: JwtUser) { return this.vendor.upsertSupplierPrice(dto, user); }
  async listSupplierPrices(q: { vendor_id?: number; item_id?: string }, user: JwtUser) { return this.vendor.listSupplierPrices(q, user); }
  async supplierPriceHistory(vendorId: number, itemId: string, user: JwtUser) { return this.vendor.supplierPriceHistory(vendorId, itemId, user); }
  async findVendorDuplicates(user: JwtUser) { return this.vendor.findVendorDuplicates(user); }
  async mergeVendor(survivorId: number, duplicateId: number, user: JwtUser) { return this.vendor.mergeVendor(survivorId, duplicateId, user); }
  async vendorHistory(vendorId: number, user: JwtUser) { return this.vendor.vendorHistory(vendorId, user); }
  async addVendorRelationship(vendorId: number, dto: { to_vendor_id: number; rel_type: string; note?: string }, user: JwtUser) { return this.vendor.addVendorRelationship(vendorId, dto, user); }
  async listVendorRelationships(vendorId: number, user: JwtUser) { return this.vendor.listVendorRelationships(vendorId, user); }
  async deleteVendorRelationship(vendorId: number, relId: number, user: JwtUser) { return this.vendor.deleteVendorRelationship(vendorId, relId, user); }

  // ── docs/38 procurement PR-3: PO lifecycle lives in ProcurementPoService; thin delegators. ──
  async createPo(dto: CreatePoDto, user: JwtUser) { return this.po.createPo(dto, user); }
  async approvePo(poNo: string, approve: boolean, reason: string | undefined, user: JwtUser, budgetOpts?: { confirmOverBudget?: boolean; overrideBudget?: boolean; overrideReason?: string }) { return this.po.approvePo(poNo, approve, reason, user, budgetOpts); }
  async cancelPo(poNo: string, reason: string, user: JwtUser) { return this.po.cancelPo(poNo, reason, user); }
  async getPoForPrint(poNo: string, user: JwtUser): Promise<import('./po-pdf.service').PoPrintData> { return this.po.getPoForPrint(poNo, user); }

  renderGrPdf(g: GrPrintData): Promise<Buffer | null> { return this.grPdf ? this.grPdf.renderToPdf(this.grPdf.goodsReceiptHtml(g)) : Promise.resolve(null); }

  // ── docs/38 procurement PR-2: GRN (receiving) lives in ProcurementGrnService; thin delegators. ──
  async getGrForPrint(grNo: string, user: JwtUser): Promise<GrPrintData> { return this.grn.getGrForPrint(grNo, user); }
  goodsReceiptHtml(g: GrPrintData): string { return this.grn.goodsReceiptHtml(g); }
  async listGrs(user: JwtUser, limit = 50) { return this.grn.listGrs(user, limit); }
  async emailGr(grNo: string, toEmail: string | undefined, user: JwtUser) { return this.grn.emailGr(grNo, toEmail, user); }
  async createGr(dto: CreateGrDto, user: JwtUser) { return this.grn.createGr(dto, user); }
  async receiveAllRemaining(poNo: string, user: JwtUser) { return this.grn.receiveAllRemaining(poNo, user); }
  async receiveItem(poNo: string, itemId: string, qty: number, user: JwtUser) { return this.grn.receiveItem(poNo, itemId, qty, user); }
  async receiveLines(poNo: string, user: JwtUser) { return this.grn.receiveLines(poNo, user); }
  async closePoShort(poNo: string, reason: string | undefined, user: JwtUser) { return this.grn.closePoShort(poNo, reason, user); }
  async getReceivingSettings(user: JwtUser) { const s = await this.grn.getReceivingSettings(user.tenantId ?? null); return { over_receipt_weight_pct: s.overReceiptWeightPct, claim_window_hours: s.claimWindowHours }; }
  async setReceivingSettings(dto: { over_receipt_weight_pct?: number; claim_window_hours?: number }, user: JwtUser) { return this.grn.setReceivingSettings(dto, user); }
}
