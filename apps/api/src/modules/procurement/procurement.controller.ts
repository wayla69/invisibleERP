import { Controller, Get, Post, Put, Patch, Delete, Param, Query, Body, Res } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { ProcurementService, type CreatePrDto, type CreatePoDto, type CreateGrDto, type UpsertSupplierPriceDto } from './procurement.service';
import { AttachmentsService, type AddAttachmentDto } from './attachments.service';
import { PoPdfService } from './po-pdf.service';

const AttachmentBody = z.object({
  doc_type: z.string().min(1), doc_no: z.string().min(1), data_url: z.string().min(1),
  kind: z.enum(['invoice', 'receipt', 'other']).optional(), filename: z.string().max(200).optional(), note: z.string().max(500).optional(),
});

const PrBody = z.object({
  remarks: z.string().optional(), priority: z.string().optional(),
  amount: z.number().nonnegative().optional(), // estimated value → drives approval-threshold routing
  project_code: z.string().optional(), // M0 (docs/32) — raise the requisition against a project's BoQ
  items: z.array(z.object({ item_id: z.string().min(1), item_description: z.string().optional(), request_qty: z.number().positive(), uom: z.string().optional(), required_date: z.string().optional(), reason: z.string().optional(), boq_line_id: z.number().int().positive().optional() })).min(1),
});
const PoBody = z.object({
  vendor_id: z.number().optional(), vendor_name: z.string().optional(), expected_date: z.string().optional(), remarks: z.string().optional(),
  project_code: z.string().optional(), // M0 (docs/32) — project PO commits material against the project's BoQ
  items: z.array(z.object({ item_id: z.string().min(1), item_description: z.string().optional(), order_qty: z.number().positive(), unit_price: z.number().nonnegative(), uom: z.string().optional(), is_capital: z.boolean().optional(), boq_line_id: z.number().int().positive().optional() })).min(1),
});
const GrBody = z.object({
  po_no: z.string().min(1), remarks: z.string().optional(),
  items: z.array(z.object({ item_id: z.string().min(1), received_qty: z.number().positive(), lot_no: z.string().optional(), expiry_date: z.string().optional(), unit_cost: z.number().optional(), uom: z.string().optional() })).min(1),
});
// FIN-3 (BUD-02): confirm_over_budget acknowledges a 'warn'-policy overage; override_budget +
// override_reason is the exec over-budget authorisation under the 'block' policy (audited).
const ApproveBody = z.object({
  approve: z.boolean().default(true), reason: z.string().optional(),
  confirm_over_budget: z.boolean().optional(), override_budget: z.boolean().optional(), override_reason: z.string().optional(),
});
// PR → PO conversion: each line is reconciled to a real item (existing code, or create_item:true to open a
// new one) + priced. pr_line_id links a line back to the exact pr_items row (precise stamping in the split
// path); set_preferred also records the chosen vendor as the item's default supplier.
const PrToPoLine = z.object({
  pr_line_id: z.number().int().positive().optional(), item_id: z.string().min(1), item_description: z.string().optional(),
  create_item: z.boolean().optional(), order_qty: z.number().positive(), unit_price: z.number().nonnegative(),
  uom: z.string().optional(), is_capital: z.boolean().optional(), set_preferred: z.boolean().optional(),
});
// Two shapes: legacy `{ vendor, lines }` (one PO for all lines) OR `{ pos: [{ vendor, lines }, …] }`
// (one PO per supplier — "1 PO = 1 supplier", so 1 PR fans out into many POs). At least one must be present.
const PrToPoBody = z.object({
  vendor_id: z.number().optional(), vendor_name: z.string().optional(), expected_date: z.string().optional(), remarks: z.string().optional(),
  currency: z.string().optional(), fx_rate: z.number().optional(),
  lines: z.array(PrToPoLine).optional(),
  pos: z.array(z.object({
    vendor_id: z.number().optional(), vendor_name: z.string().optional(), expected_date: z.string().optional(),
    remarks: z.string().optional(), currency: z.string().optional(), fx_rate: z.number().optional(),
    lines: z.array(PrToPoLine).min(1),
  })).optional(),
}).refine((b) => (b.lines?.length ?? 0) > 0 || (b.pos?.length ?? 0) > 0, { message: 'lines or pos required', path: ['lines'] });
// Set/clear an item's preferred supplier. remove:true clears; else the vendor becomes the default (a price
// row is seeded from unit_price / the last PO price when none exists yet).
const PreferredVendorBody = z.object({
  vendor_id: z.number().int().positive(), unit_price: z.number().nonnegative().optional(),
  uom: z.string().optional(), currency: z.string().optional(), remove: z.boolean().optional(),
});
const CancelBody = z.object({ reason: z.string().min(1) });
// to_email optional — defaults to the vendor's email on file (master data) when omitted.
const DocEmailBody = z.object({ to_email: z.string().email().optional() });
// D4 — receive a partial qty of one PO line.
const ReceiveItemBody = z.object({ item_id: z.string().min(1), qty: z.number().positive() });
// EXP-12 — close a part-received PO short (shortage never coming) / receiving tolerances.
const CloseShortBody = z.object({ reason: z.string().max(500).optional() });
const ReceivingSettingsBody = z.object({ over_receipt_weight_pct: z.number().min(0).max(100).optional(), claim_window_hours: z.number().int().positive().optional() });
const SupplierStatusBody = z.object({ approval_status: z.enum(['approved', 'pending', 'blocked']).optional(), blocklisted: z.boolean().optional(), reason: z.string().optional() });
// Direct-edit vendor master fields (master-data audit Phase 2) — excludes tax_id/credit_limit/bank details
// AND payment_terms (GRC-3): these payment-redirection / credit-exposure fields are sensitive and now route
// through the single-record master-data change maker-checker (POST /api/masterdata/change-requests, MDM-01)
// so a change is applied only on a DISTINCT user's approval. This endpoint keeps the low-risk profile fields.
const VendorProfileBody = z.object({
  contact: z.string().trim().max(200).nullish(), phone: z.string().trim().max(50).nullish(),
  email: z.union([z.string().trim().email(), z.literal('')]).nullish(),
  address: z.string().trim().max(500).nullish(),
  lead_time_days: z.number().int().nonnegative().nullish(), rating: z.number().min(0).max(5).nullish(),
  category: z.string().trim().max(50).nullish(), currency: z.string().trim().max(10).nullish(), notes: z.string().trim().max(2000).nullish(),
});
// Party-model depth (master-data audit Phase 4) — a vendor can carry more than one address/contact, plus
// an optional pointer at its parent company for consolidated scorecards/reporting.
const VendorAddressBody = z.object({
  address_type: z.enum(['billing', 'shipping', 'registered', 'other']).default('other'),
  address_line1: z.string().optional(), address_line2: z.string().optional(),
  sub_district: z.string().optional(), district: z.string().optional(), province: z.string().optional(), postal_code: z.string().optional(),
  is_primary: z.boolean().optional(),
});
const VendorContactBody = z.object({
  name: z.string().min(1), title: z.string().optional(), phone: z.string().optional(), email: z.string().optional(),
  notes: z.string().optional(), is_primary: z.boolean().optional(),
});
const VendorParentBody = z.object({ parent_vendor_id: z.number().int().positive().nullable() });
const VendorMergeBody = z.object({ duplicate_vendor_id: z.number().int().positive() });
const VENDOR_REL_TYPES = ['related_party', 'subsidiary', 'franchisee', 'subcontractor', 'parent', 'other'] as const;
const VendorRelationshipBody = z.object({
  to_vendor_id: z.number().int().positive(),
  rel_type: z.enum(VENDOR_REL_TYPES).default('related_party'),
  note: z.string().optional(),
});
// Vendor bank-detail maker-checker (0270) — stages a change; never applied directly.
const VendorBankChangeBody = z.object({ bank_name: z.string().optional(), bank_account: z.string().optional() });
const RejectBody = z.object({ reason: z.string().optional() });
const ScorecardBody = z.object({ period: z.string().min(1) });
// T2-D: Supplier price-list versioning — create/version a purchase price; list active; history.
const SupplierPriceBody = z.object({
  vendor_id: z.number().int().positive(),
  item_id: z.string().min(1),
  item_description: z.string().optional(),
  uom: z.string().optional(),
  currency: z.string().optional(),
  unit_price: z.number().positive(),
  min_qty: z.number().positive().optional(),
  effective_from: z.string().min(1), // YYYY-MM-DD
  effective_to: z.string().optional(),
  notes: z.string().optional(),
});

@Controller('api/procurement')
export class ProcurementController {
  constructor(private readonly svc: ProcurementService, private readonly attachments: AttachmentsService, private readonly poPdf: PoPdfService) {}

  // ── Document attachments (0228) — invoice/receipt photos on a PO (evidence for the 3-way match). ──
  // Upload: the people who handle the paper — buyer (procurement), AP clerk (creditors), receiver
  // (wh_receive). View adds planner/exec. Delete is service-enforced to uploader-or-Admin.
  @Post('attachments') @Permissions('procurement', 'creditors', 'wh_receive')
  addAttachment(@Body(new ZodValidationPipe(AttachmentBody)) b: AddAttachmentDto, @CurrentUser() u: JwtUser) { return this.attachments.add(b, u); }
  @Get('attachments') @Permissions('procurement', 'creditors', 'wh_receive', 'planner', 'exec')
  listAttachments(@Query('doc_type') docType: string, @Query('doc_no') docNo: string, @CurrentUser() u: JwtUser) { return this.attachments.list(docType ?? 'PO', docNo ?? '', u); }
  @Get('attachments/:id') @Permissions('procurement', 'creditors', 'wh_receive', 'planner', 'exec')
  getAttachment(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.attachments.get(+id, u); }
  @Delete('attachments/:id') @Permissions('procurement', 'creditors', 'wh_receive')
  removeAttachment(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.attachments.remove(+id, u); }

  // PR = a request anyone in the company can raise (pr_raise). It is NOT a commitment — approval + PO
  // remain procurement-only. 'procurement'/'planner' imply pr_raise, so buyers/planners still qualify.
  @Post('prs') @Permissions('pr_raise', 'procurement', 'planner')
  createPr(@Body(new ZodValidationPipe(PrBody)) b: CreatePrDto, @CurrentUser() u: JwtUser) { return this.svc.createPr(b, u); }

  // List recent PRs (header + lines) for the requisitions screen. pr_raise holders see their own; a
  // procurement/planner/exec holder sees every PR (can_approve:true) so they can decide from the table.
  @Get('prs') @Permissions('pr_raise', 'procurement', 'planner', 'exec')
  listPrs(@CurrentUser() u: JwtUser, @Query('limit') limit?: string, @Query('mine') mine?: string) {
    return this.svc.listPrs(u, { limit: limit ? Number(limit) : undefined, mine: mine === 'true' ? true : mine === 'false' ? false : undefined });
  }

  @Patch('prs/:prNo/approve') @Permissions('procurement')
  approvePr(@Param('prNo') prNo: string, @Body(new ZodValidationPipe(ApproveBody)) b: z.infer<typeof ApproveBody>, @CurrentUser() u: JwtUser) {
    return this.svc.approvePr(prNo, b.approve, u, { confirmOverBudget: b.confirm_over_budget, overrideBudget: b.override_budget, overrideReason: b.override_reason });
  }

  // Requester withdraws their own still-Pending PR (own-doc only; Admin may cancel any) — 0228.
  @Patch('prs/:prNo/cancel') @Permissions('pr_raise', 'procurement', 'planner')
  cancelPr(@Param('prNo') prNo: string, @CurrentUser() u: JwtUser) { return this.svc.cancelPr(prNo, u); }

  // Item-master search for the PR→PO reconcile step (match a free-text PR name to a real item + last price).
  @Get('items/search') @Permissions('pr_raise', 'procurement', 'planner', 'exec')
  searchItems(@Query('q') q: string, @Query('limit') limit?: string) { return this.svc.searchItems(q ?? '', limit ? Number(limit) : undefined); }

  // Product catalog for the shop/basket requisition screen (/shop) — read-only item-master browse grouped
  // by product category, so staff can pick items into a basket and check out a PR. Same low-risk pr_raise
  // duty as raising the PR itself. Paginated (offset/limit) for the Grab/Shopee-style infinite-scroll grid;
  // optional q (code/description) + category-key filter. Returns the item page + the full category summary.
  @Get('catalog') @Permissions('pr_raise', 'procurement', 'planner', 'exec')
  catalog(@CurrentUser() u: JwtUser, @Query('q') q?: string, @Query('category') category?: string, @Query('barcode') barcode?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.svc.catalog(u, { q, category, barcode, limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined });
  }

  // Catalog item thumbnail (pr_raise) — the in-DB image data-URL for a shop-grid <img>. 404 if none.
  @Get('catalog/items/:itemId/image') @Permissions('pr_raise', 'procurement', 'planner', 'exec')
  catalogItemImage(@Param('itemId') itemId: string, @CurrentUser() u: JwtUser) { return this.svc.catalogItemImage(u, itemId); }

  // Populate product images for catalog items — fetches images from the internet based on item descriptions
  // and stores them as data URLs. Gated to md_item duty (master-data admin). Optionally filters by item IDs.
  @Post('catalog/populate-images') @Permissions('md_item')
  populateItemImages(@Body() b: { item_ids?: string[] }) { return this.svc.populateItemImages(b?.item_ids); }

  // Fetch image for a single item from the internet and return as data URL
  @Get('catalog/items/:itemId/fetch-image') @Permissions('md_item')
  async fetchItemImage(@Param('itemId') itemId: string) { return { image_data_url: await this.svc.fetchItemImage(itemId) }; }

  // Store a fetched image for an item
  @Post('catalog/items/:itemId/store-image') @Permissions('md_item')
  storeItemImage(@Param('itemId') itemId: string, @Body() b: { data_url: string }) { return this.svc.storeItemImage(itemId, b.data_url); }

  // Vendor search for the PR→PO panel (pick a real supplier from the master).
  @Get('vendors/search') @Permissions('pr_raise', 'procurement', 'planner', 'exec')
  searchVendors(@Query('q') q: string, @Query('limit') limit?: string) { return this.svc.searchVendors(q ?? '', limit ? Number(limit) : undefined); }

  // Suggest a supplier per requisition line (preferred price list → cheapest active → last PO vendor) so the
  // PR→PO screen can auto-group a PR into one PO per vendor. `item_ids` = comma-separated codes. Read-only.
  @Get('items/suppliers') @Permissions('pr_raise', 'procurement', 'planner', 'exec')
  itemSuppliers(@Query('item_ids') itemIds: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.suggestSuppliersForItems((itemIds ?? '').split(',').map((s) => s.trim()).filter(Boolean), u);
  }

  // Set/clear an item's "ผู้ขายประจำ" (preferred supplier). Sourcing decision: price maintenance is md_vendor,
  // buying is procurement/planner (SoD-consistent with upsertSupplierPrice). Seeds a price row when none exists.
  @Put('items/:itemId/preferred-vendor') @Permissions('md_vendor', 'procurement', 'planner')
  setPreferredVendor(@Param('itemId') itemId: string, @Body(new ZodValidationPipe(PreferredVendorBody)) b: any, @CurrentUser() u: JwtUser) {
    return this.svc.setPreferredVendor(itemId, b, u);
  }

  // Low-stock reorder list — items at/below their reorder point (on-hand vs items.min_stock), with a
  // suggested top-up qty. Feeds the "สินค้าใกล้หมด" web card + the LINE chat `low` command.
  @Get('low-stock') @Permissions('pr_raise', 'procurement', 'planner', 'exec')
  lowStock(@CurrentUser() u: JwtUser, @Query('limit') limit?: string) { return this.svc.lowStock(u, { limit: limit ? Number(limit) : undefined }); }

  // One-tap reorder — raise a single PR covering all low-stock items (chat `reorder` + web button).
  @Post('reorder-pr') @Permissions('pr_raise', 'procurement', 'planner')
  reorderPr(@CurrentUser() u: JwtUser) { return this.svc.reorderPr(u); }

  // D3 — purchase spend insights for a business month: total + top vendors + most-bought items.
  @Get('spend-summary') @Permissions('procurement', 'planner', 'exec', 'dashboard')
  spendSummary(@CurrentUser() u: JwtUser, @Query('period') period?: string) { return this.svc.purchaseSpend(u, { period }); }

  // Convert an approved PR → PO (procurement duty). Lines arrive reconciled (existing item_id or a new
  // code to open); the PO routes through the normal createPo path and the PR is linked + marked Converted.
  @Post('prs/:prNo/to-po') @Permissions('procurement')
  convertPrToPo(@Param('prNo') prNo: string, @Body(new ZodValidationPipe(PrToPoBody)) b: any, @CurrentUser() u: JwtUser) {
    return this.svc.convertPrToPo(prNo, b, u);
  }

  // Receive ALL outstanding qty on an approved PO in one shot (LINE chat `receive` + web "รับครบ").
  @Post('pos/:poNo/receive-all') @Permissions('wh_receive', 'warehouse', 'procurement')
  receiveAll(@Param('poNo') poNo: string, @CurrentUser() u: JwtUser) { return this.svc.receiveAllRemaining(poNo, u); }

  // EXP-12 — the PO's lines for the receiving screen (ordered / already received / outstanding per line),
  // so the receiver counts the actual delivery against the order (blind-count) instead of keying free lines.
  @Get('pos/:poNo/receive-lines') @Permissions('wh_receive', 'warehouse', 'procurement')
  receiveLines(@Param('poNo') poNo: string, @CurrentUser() u: JwtUser) { return this.svc.receiveLines(poNo, u); }

  // EXP-12 — close a part-received PO short: the shortage is never coming; releases open commitments.
  @Post('pos/:poNo/close-short') @Permissions('wh_receive', 'warehouse', 'procurement')
  closePoShort(@Param('poNo') poNo: string, @Body(new ZodValidationPipe(CloseShortBody)) b: z.infer<typeof CloseShortBody>, @CurrentUser() u: JwtUser) {
    return this.svc.closePoShort(poNo, b.reason, u);
  }

  // EXP-12 — receiving tolerances (weight over-receipt % + claim window hours). Change is restricted to
  // procurement/exec (the receiver can read but not loosen their own gate — mirrors EXP-04).
  @Get('receiving-settings') @Permissions('wh_receive', 'warehouse', 'procurement', 'exec')
  getReceivingSettings(@CurrentUser() u: JwtUser) { return this.svc.getReceivingSettings(u); }
  @Put('receiving-settings') @Permissions('procurement', 'exec')
  setReceivingSettings(@Body(new ZodValidationPipe(ReceivingSettingsBody)) b: z.infer<typeof ReceivingSettingsBody>, @CurrentUser() u: JwtUser) {
    return this.svc.setReceivingSettings(b, u);
  }

  // D4 — receive a partial qty of ONE item on an approved PO (LINE chat `receive <PO> <item> <qty>`).
  @Post('pos/:poNo/receive-item') @Permissions('wh_receive', 'warehouse', 'procurement')
  receiveItem(@Param('poNo') poNo: string, @Body(new ZodValidationPipe(ReceiveItemBody)) b: z.infer<typeof ReceiveItemBody>, @CurrentUser() u: JwtUser) {
    return this.svc.receiveItem(poNo, b.item_id, b.qty, u);
  }

  // ── supplier screening (Phase 16) ── vendor-master duty = md_vendor (segregated from AP payment).
  // Legacy 'masterdata' holders still pass (it implies md_vendor/md_item/md_config).
  @Patch('suppliers/:id/status') @Permissions('md_vendor')
  setSupplierStatus(@Param('id') id: string, @Body(new ZodValidationPipe(SupplierStatusBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.setSupplierStatus(+id, b, u); }
  // Direct-edit vendor master profile (master-data audit Phase 2) — contact/address/terms/rating/category/
  // currency/notes; excludes tax_id/credit_limit/bank details (see VendorProfileBody comment).
  @Patch('vendors/:id/profile') @Permissions('md_vendor')
  updateVendorProfile(@Param('id') id: string, @Body(new ZodValidationPipe(VendorProfileBody)) b: z.infer<typeof VendorProfileBody>, @CurrentUser() u: JwtUser) { return this.svc.updateVendorProfile(+id, b, u); }
  // ── Party-model depth (master-data audit Phase 4): multi-address / multi-contact / parent company ──
  @Patch('vendors/:id/parent') @Permissions('md_vendor')
  setVendorParent(@Param('id') id: string, @Body(new ZodValidationPipe(VendorParentBody)) b: z.infer<typeof VendorParentBody>, @CurrentUser() u: JwtUser) { return this.svc.setVendorParent(+id, b.parent_vendor_id, u); }
  @Post('vendors/:id/addresses') @Permissions('md_vendor')
  addVendorAddress(@Param('id') id: string, @Body(new ZodValidationPipe(VendorAddressBody)) b: z.infer<typeof VendorAddressBody>, @CurrentUser() u: JwtUser) { return this.svc.addVendorAddress(+id, b, u); }
  @Get('vendors/:id/addresses') @Permissions('md_vendor', 'procurement', 'exec')
  listVendorAddresses(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.listVendorAddresses(+id, u); }
  @Delete('vendors/:id/addresses/:addressId') @Permissions('md_vendor')
  deleteVendorAddress(@Param('id') id: string, @Param('addressId') addressId: string, @CurrentUser() u: JwtUser) { return this.svc.deleteVendorAddress(+id, +addressId, u); }
  @Post('vendors/:id/contacts') @Permissions('md_vendor')
  addVendorContact(@Param('id') id: string, @Body(new ZodValidationPipe(VendorContactBody)) b: z.infer<typeof VendorContactBody>, @CurrentUser() u: JwtUser) { return this.svc.addVendorContact(+id, b, u); }
  @Get('vendors/:id/contacts') @Permissions('md_vendor', 'procurement', 'exec')
  listVendorContacts(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.listVendorContacts(+id, u); }
  @Get('vendors/:id/history') @Permissions('md_vendor', 'procurement', 'exec')
  vendorHistory(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.vendorHistory(+id, u); }
  @Post('vendors/:id/relationships') @Permissions('md_vendor')
  addVendorRelationship(@Param('id') id: string, @Body(new ZodValidationPipe(VendorRelationshipBody)) b: z.infer<typeof VendorRelationshipBody>, @CurrentUser() u: JwtUser) { return this.svc.addVendorRelationship(+id, b, u); }
  @Get('vendors/:id/relationships') @Permissions('md_vendor', 'procurement', 'exec')
  listVendorRelationships(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.listVendorRelationships(+id, u); }
  @Delete('vendors/:id/relationships/:relId') @Permissions('md_vendor')
  deleteVendorRelationship(@Param('id') id: string, @Param('relId') relId: string, @CurrentUser() u: JwtUser) { return this.svc.deleteVendorRelationship(+id, +relId, u); }
  @Delete('vendors/:id/contacts/:contactId') @Permissions('md_vendor')
  deleteVendorContact(@Param('id') id: string, @Param('contactId') contactId: string, @CurrentUser() u: JwtUser) { return this.svc.deleteVendorContact(+id, +contactId, u); }
  // ── Match-merge / DQM (master-data audit Phase 5): detect + merge duplicate vendors ──
  @Get('vendors/duplicates') @Permissions('md_vendor', 'procurement', 'exec')
  findVendorDuplicates(@CurrentUser() u: JwtUser) { return this.svc.findVendorDuplicates(u); }
  @Post('vendors/:id/merge') @Permissions('md_vendor', 'masterdata', 'exec')
  mergeVendor(@Param('id') id: string, @Body(new ZodValidationPipe(VendorMergeBody)) b: z.infer<typeof VendorMergeBody>, @CurrentUser() u: JwtUser) { return this.svc.mergeVendor(+id, b.duplicate_vendor_id, u); }
  @Post('suppliers/:id/scorecard') @Permissions('procurement')
  scorecard(@Param('id') id: string, @Body(new ZodValidationPipe(ScorecardBody)) b: { period: string }, @CurrentUser() u: JwtUser) { return this.svc.recomputeScorecard(+id, b.period, u); }

  // ── Vendor bank-detail maker-checker (0270) — closes a BEC/vendor-payment-fraud gap: md_vendor stages a
  // change, a DISTINCT exec/approvals user releases it (SoD; self-approval → 403 SOD_VIOLATION). ──
  @Patch('vendors/:id/bank') @Permissions('md_vendor')
  stageBankChange(@Param('id') id: string, @Body(new ZodValidationPipe(VendorBankChangeBody)) b: { bank_name?: string; bank_account?: string }, @CurrentUser() u: JwtUser) { return this.svc.stageBankChange(+id, b, u); }
  @Get('vendor-bank-changes') @Permissions('md_vendor', 'exec', 'approvals')
  pendingBankChanges(@CurrentUser() u: JwtUser) { return this.svc.pendingBankChanges(u); }
  @Post('vendor-bank-changes/:reqNo/approve') @Permissions('exec', 'approvals')
  approveBankChange(@Param('reqNo') reqNo: string, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) { return this.svc.approveBankChange(reqNo, u, b?.self_approval_reason); }
  @Post('vendor-bank-changes/:reqNo/reject') @Permissions('exec', 'approvals')
  rejectBankChange(@Param('reqNo') reqNo: string, @Body(new ZodValidationPipe(RejectBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) { return this.svc.rejectBankChange(reqNo, u, b.reason); }

  // Supplier-performance register — scorecards ranked by score (with ?period; default = latest per vendor).
  @Get('scorecards') @Permissions('procurement', 'exec')
  scorecards(@CurrentUser() u: JwtUser, @Query('period') period?: string, @Query('limit') limit?: string) {
    return this.svc.listScorecards({ period, limit: limit ? Math.min(Number(limit) || 200, 500) : 200 }, u);
  }

  // T2-D: Supplier price-list versioning. md_vendor creates/versions prices; procurement/planner/exec view.
  // SoD: price maintenance (md_vendor) is segregated from buying (procurement) and paying (creditors).
  @Post('supplier-prices') @Permissions('md_vendor', 'procurement')
  upsertSupplierPrice(@Body(new ZodValidationPipe(SupplierPriceBody)) b: UpsertSupplierPriceDto, @CurrentUser() u: JwtUser) {
    return this.svc.upsertSupplierPrice(b, u);
  }
  @Get('supplier-prices') @Permissions('procurement', 'planner', 'exec')
  listSupplierPrices(@CurrentUser() u: JwtUser, @Query('vendor_id') vendorId?: string, @Query('item_id') itemId?: string) {
    return this.svc.listSupplierPrices({ vendor_id: vendorId ? Number(vendorId) : undefined, item_id: itemId }, u);
  }
  @Get('supplier-prices/history') @Permissions('procurement', 'planner')
  supplierPriceHistory(@CurrentUser() u: JwtUser, @Query('vendor_id') vendorId: string, @Query('item_id') itemId: string) {
    return this.svc.supplierPriceHistory(Number(vendorId), itemId, u);
  }

  @Post('pos') @Permissions('procurement')
  createPo(@Body(new ZodValidationPipe(PoBody)) b: CreatePoDto, @CurrentUser() u: JwtUser) { return this.svc.createPo(b, u); }

  @Patch('pos/:poNo/approve') @Permissions('procurement')
  approvePo(@Param('poNo') poNo: string, @Body(new ZodValidationPipe(ApproveBody)) b: z.infer<typeof ApproveBody>, @CurrentUser() u: JwtUser) {
    return this.svc.approvePo(poNo, b.approve, b.reason, u, { confirmOverBudget: b.confirm_over_budget, overrideBudget: b.override_budget, overrideReason: b.override_reason });
  }

  @Patch('pos/:poNo/cancel') @Permissions('procurement')
  cancelPo(@Param('poNo') poNo: string, @Body(new ZodValidationPipe(CancelBody)) b: { reason: string }, @CurrentUser() u: JwtUser) {
    return this.svc.cancelPo(poNo, b.reason, u);
  }

  // Printable ใบสั่งซื้อ (Purchase Order) — HTML→PDF via the shared PdfRenderer, HTML fallback when Chromium
  // is absent (same graceful-degrade contract as the tax documents). Viewing is open to the buying/receiving
  // roles + planner/exec who track the order (read-only presentation; no ledger effect).
  @Get('pos/:poNo/pdf') @Permissions('procurement', 'planner', 'exec', 'wh_receive', 'warehouse')
  async printPo(@Param('poNo') poNo: string, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const po = await this.svc.getPoForPrint(poNo, u);
    const html = this.poPdf.purchaseOrderHtml(po, po.template);
    const buf = await this.poPdf.renderToPdf(html);
    if (buf) {
      reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${poNo}.pdf"`).header('Content-Length', buf.length).send(buf);
    } else {
      reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
    }
  }

  // GR = a warehouse/receiving duty (wh_receive), deliberately segregated from purchase ordering so the
  // buyer cannot also confirm receipt (SoD R04 — preserves the 3-way match). Coarse 'warehouse' implies
  // wh_receive, so existing warehouse roles keep access; 'procurement' alone no longer can receive.
  @Post('grs') @Permissions('wh_receive')
  createGr(@Body(new ZodValidationPipe(GrBody)) b: CreateGrDto, @CurrentUser() u: JwtUser) { return this.svc.createGr(b, u); }

  // Recent goods receipts — the /receiving list surface (print/email each GR note).
  @Get('grs') @Permissions('wh_receive', 'warehouse', 'procurement', 'creditors', 'exec')
  listGrs(@Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listGrs(u, limit ? Number(limit) : 50); }

  // Printable ใบรับสินค้า (Goods Receipt Note) — HTML→PDF, HTML fallback when Chromium absent.
  @Get('grs/:grNo/pdf') @Permissions('wh_receive', 'warehouse', 'procurement', 'creditors', 'exec')
  async grPdf(@Param('grNo') grNo: string, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const g = await this.svc.getGrForPrint(grNo, u);
    const buf = await this.svc.renderGrPdf(g);
    if (buf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${grNo}.pdf"`).header('Content-Length', buf.length).send(buf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(this.svc.goodsReceiptHtml(g));
  }
  @Post('grs/:grNo/send-email') @Permissions('wh_receive', 'warehouse', 'procurement')
  emailGr(@Param('grNo') grNo: string, @Body(new ZodValidationPipe(DocEmailBody)) b: z.infer<typeof DocEmailBody>, @CurrentUser() u: JwtUser) {
    return this.svc.emailGr(grNo, b.to_email, u);
  }
}
