import { pgTable, bigserial, bigint, text, numeric, integer, date, timestamp, boolean, index, jsonb } from 'drizzle-orm/pg-core';
import { encryptedText } from '../encrypted-column';
import { poStatusEnum } from './enums';
import { tenants } from './tenants';

// รวม tbl_suppliers + tbl_creditors (overlapping vendor masters)
export const vendors = pgTable('vendors', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  // Tenant ownership (migration 0034). NULL = legacy/shared master row: readable by every tenant but
  // writable only by HQ/bypass (custom RLS vendor_tenant_read/vendor_tenant_write). A row with a tenant_id
  // is fully isolated to that tenant. Set tenantId on any tenant-scoped vendor INSERT path.
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  // Per-tenant uniqueness is enforced by migration 0034 via a partial unique index on
  // (COALESCE(tenant_id,0), vendor_code) — NOT a global unique (that leaked codes across tenants).
  vendorCode: text('vendor_code'),
  name: text('name').notNull(),
  isSupplier: boolean('is_supplier').default(true),
  isCreditor: boolean('is_creditor').default(false),
  contact: text('contact'),
  phone: text('phone'),
  email: text('email'),
  userName: text('user_name'),  // supplier portal: link to users.username for vendor self-service (Phase D3)
  address: text('address'),
  // PII-at-rest (ITGC-AC-19, docs/27 R0-1): vendor tax ID + bank account are encrypted (AES-256-GCM,
  // legacy-plaintext passthrough). NOT queried by value in SQL — the ghost-vendor detector
  // (controls.service.ts) groups decrypted values in app code, since random-IV ciphertext never collides.
  taxId: encryptedText('tax_id'),
  paymentTerms: text('payment_terms').default('Cash'),
  leadTimeDays: integer('lead_time_days').default(3),
  rating: numeric('rating').default('3.0'),
  bankName: text('bank_name'),
  bankAccount: encryptedText('bank_account'), // PII-at-rest (ITGC-AC-19) — decrypts only at the payment boundary
  creditLimit: numeric('credit_limit', { precision: 14, scale: 2 }),
  currency: text('currency').default('THB'),
  category: text('category').default('Supplier'),
  active: boolean('active').default(true),
  notes: text('notes'),
  // Phase 16 — supplier screening
  approvalStatus: text('approval_status').notNull().default('approved'), // approved | pending | blocked
  blocklisted: boolean('blocklisted').notNull().default(false),
  blocklistReason: text('blocklist_reason'),
  scorecardScore: numeric('scorecard_score', { precision: 5, scale: 2 }),
  // Audit hygiene (0270) — the table had no creation trail at all.
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  // Party-model depth (0272, master-data audit Phase 4) — a subsidiary/branch vendor can point at its
  // parent vendor for consolidated scorecards/reporting. Plain bigint (no inline Drizzle FK), matching the
  // projects.ts WBS parentId self-reference precedent — a self-referencing FK inside the same table
  // definition is simplest done this way rather than fighting Drizzle's forward-reference typing.
  parentVendorId: bigint('parent_vendor_id', { mode: 'number' }),
  // Match-merge / DQM (0273, master-data audit Phase 5) — a merged-away duplicate is soft-retired
  // (active=false) with a pointer to the surviving vendor's id + who/when. Never physically deleted.
  mergedInto: bigint('merged_into', { mode: 'number' }),
  mergedBy: text('merged_by'),
  mergedAt: timestamp('merged_at', { withTimezone: true }),
});

// ── Phase 16 — Source-to-Pay: RFQ/sourcing, supplier scorecards, 3-way match ──
export const rfqs = pgTable('rfqs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  rfqNo: text('rfq_no').notNull().unique(),
  rfqDate: date('rfq_date'), status: text('status').notNull().default('Open'), // Open | Awarded | Cancelled
  requiredDate: date('required_date'), remarks: text('remarks'), createdBy: text('created_by'),
  awardedQuoteId: bigint('awarded_quote_id', { mode: 'number' }),
});
export const rfqItems = pgTable('rfq_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  rfqId: bigint('rfq_id', { mode: 'number' }).references(() => rfqs.id),
  itemId: text('item_id'), itemDescription: text('item_description'), qty: numeric('qty'), uom: text('uom'),
});
export const supplierQuotes = pgTable('supplier_quotes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  quoteNo: text('quote_no').notNull().unique(), rfqId: bigint('rfq_id', { mode: 'number' }).references(() => rfqs.id),
  vendorId: bigint('vendor_id', { mode: 'number' }).references(() => vendors.id), vendorName: text('vendor_name'),
  quoteDate: date('quote_date'), validUntil: date('valid_until'), leadTimeDays: integer('lead_time_days'),
  totalAmount: numeric('total_amount', { precision: 14, scale: 2 }), status: text('status').notNull().default('Submitted'), // Submitted | Awarded | Rejected
  createdBy: text('created_by'),
});
export const supplierQuoteItems = pgTable('supplier_quote_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  quoteId: bigint('quote_id', { mode: 'number' }).references(() => supplierQuotes.id),
  itemId: text('item_id'), itemDescription: text('item_description'), qty: numeric('qty'), unitPrice: numeric('unit_price', { precision: 14, scale: 2 }), uom: text('uom'),
});
export const supplierScorecards = pgTable('supplier_scorecards', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), vendorId: bigint('vendor_id', { mode: 'number' }).references(() => vendors.id),
  period: text('period'), onTimePct: numeric('on_time_pct', { precision: 5, scale: 2 }), qualityPct: numeric('quality_pct', { precision: 5, scale: 2 }),
  priceVarPct: numeric('price_var_pct', { precision: 5, scale: 2 }), score: numeric('score', { precision: 5, scale: 2 }),
  grCount: integer('gr_count').default(0), claimCount: integer('claim_count').default(0), createdBy: text('created_by'),
});
export const matchTolerance = pgTable('match_tolerance', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  qtyPct: numeric('qty_pct', { precision: 6, scale: 3 }).notNull().default('0'), pricePct: numeric('price_pct', { precision: 6, scale: 3 }).notNull().default('2'),
  amountPct: numeric('amount_pct', { precision: 6, scale: 3 }).notNull().default('2'), amountAbs: numeric('amount_abs', { precision: 14, scale: 2 }).notNull().default('0.50'),
  updatedBy: text('updated_by'),
});
export const invoiceMatchResults = pgTable('invoice_match_results', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), matchNo: text('match_no').notNull().unique(),
  txnNo: text('txn_no').notNull().unique(), poNo: text('po_no'), matchStatus: text('match_status').notNull(),
  payable: boolean('payable').notNull().default(false), override: boolean('override').notNull().default(false),
  overrideBy: text('override_by'), overrideReason: text('override_reason'), overrideAt: timestamp('override_at', { withTimezone: true }),
  matchedBy: text('matched_by'), matchedAt: timestamp('matched_at', { withTimezone: true }).defaultNow(),
});
export const invoiceMatchLines = pgTable('invoice_match_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  matchId: bigint('match_id', { mode: 'number' }).references(() => invoiceMatchResults.id), itemId: text('item_id'),
  invQty: numeric('inv_qty'), invPrice: numeric('inv_price', { precision: 14, scale: 2 }), poQty: numeric('po_qty'),
  poPrice: numeric('po_price', { precision: 14, scale: 2 }), grQty: numeric('gr_qty'),
  qtyVarPct: numeric('qty_var_pct', { precision: 8, scale: 3 }), priceVarPct: numeric('price_var_pct', { precision: 8, scale: 3 }),
  lineStatus: text('line_status').notNull(),
});

// Scanned-invoice intake → PO auto-map → automated 3-way match (EXP-10, migration 0229). Holds the
// extracted draft + the mapping decision; posting creates the AP bill and runs the EXP-01 match. Payment
// stays behind the AP-PAY maker-checker — this automates the path TO payment-ready, not the disbursement.
export const apInvoiceIntakes = pgTable('ap_invoice_intakes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  intakeNo: text('intake_no').notNull().unique(), // AINV-YYYYMMDD-NNN
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  rawText: text('raw_text'),
  vendorId: bigint('vendor_id', { mode: 'number' }).references(() => vendors.id), // resolved during mapping
  vendorName: text('vendor_name'),
  vendorTaxId: text('vendor_tax_id'),
  invoiceNo: text('invoice_no'),
  invoiceDate: date('invoice_date'),
  amount: numeric('amount', { precision: 14, scale: 2 }),
  currency: text('currency').default('THB'),
  extractSource: text('extract_source'), // ai | rules | rules-fallback
  poNo: text('po_no'),
  mapMethod: text('map_method'), // po_number | vendor_tax_id | vendor_amount | manual
  mapConfidence: numeric('map_confidence', { precision: 5, scale: 2 }), // 0–100
  candidates: jsonb('candidates'), // scored PO candidates surfaced for human review
  dupOf: text('dup_of'), // earlier intake carrying the same vendor invoice no (duplicate-payment guard)
  // upload channel: the scanned source document (image/PDF). file_ref is `objstore:<key>` when the
  // object store is configured, else the inline data: URL (object-storage.ts fallback pattern).
  fileName: text('file_name'),
  fileMime: text('file_mime'),
  fileRef: text('file_ref'),
  status: text('status').notNull().default('NeedsReview'), // NeedsReview | Mapped | Posted
  txnNo: text('txn_no'), // ap_transactions.txn_no once posted
  matchStatus: text('match_status'), // verdict copied from the auto-run 3-way match
  payable: boolean('payable'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  postedBy: text('posted_by'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
}, (t) => ({
  byStatus: index('idx_ap_intake_status').on(t.tenantId, t.status),
  byTxn: index('idx_ap_intake_txn').on(t.txnNo),
}));

export const supplierRequests = pgTable('supplier_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  reqDate: date('req_date'),
  supplierName: text('supplier_name'),
  contact: text('contact'),
  phone: text('phone'),
  email: text('email'),
  address: text('address'),
  paymentTerms: text('payment_terms'),
  leadTimeDays: integer('lead_time_days'),
  requestedBy: text('requested_by'),
  status: text('status').default('Pending'),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  remarks: text('remarks'),
});

export const purchaseRequests = pgTable('purchase_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  prNo: text('pr_no').notNull().unique(),
  prDate: date('pr_date'),
  requestedBy: text('requested_by'),
  status: text('status').default('Draft'),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  remarks: text('remarks'),
  priority: text('priority').default('Normal'),
  // Project dimension (M0, docs/32) — a requisition can be raised against a project so material spend is
  // committed/received against that project's BoQ. Nullable → non-project buys are unaffected.
  projectId: bigint('project_id', { mode: 'number' }),
});

export const prItems = pgTable('pr_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  prId: bigint('pr_id', { mode: 'number' }).references(() => purchaseRequests.id),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  requestQty: numeric('request_qty'),
  uom: text('uom'),
  requiredDate: date('required_date'),
  reason: text('reason'),
  poNo: text('po_no'),
  status: text('status').default('Open'),
  boqLineId: bigint('boq_line_id', { mode: 'number' }), // → project_boq_lines.id (M0, docs/32)
}, (t) => ({ byPr: index('idx_pr_items_pr').on(t.prId) }));

export const purchaseOrders = pgTable('purchase_orders', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  poNo: text('po_no').notNull().unique(), // PO-YYYYMMDD-NNN
  poDate: date('po_date'),
  vendorId: bigint('vendor_id', { mode: 'number' }).references(() => vendors.id),
  vendorName: text('vendor_name'), // เดิมเก็บชื่อ string — เก็บไว้สำหรับ match-by-name + ETL
  status: poStatusEnum('status').default('Draft'),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  vendorAckAt: timestamp('vendor_ack_at', { withTimezone: true }), // supplier portal PO acknowledgement (Phase D3)
  remarks: text('remarks'),
  totalAmount: numeric('total_amount', { precision: 14, scale: 2 }),
  createdBy: text('created_by'),
  expectedDate: date('expected_date'),
  // C1: transaction currency (ISO-4217) + booked exchange rate vs functional currency (migration 0175)
  currency: text('currency').notNull().default('THB'),
  fxRate: numeric('fx_rate', { precision: 14, scale: 6 }).notNull().default('1.000000'),
  // Project dimension (M0, docs/32) — nullable; a project PO commits material against the project's BoQ.
  projectId: bigint('project_id', { mode: 'number' }),
});

export const poItems = pgTable('po_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  poId: bigint('po_id', { mode: 'number' }).references(() => purchaseOrders.id),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  orderQty: numeric('order_qty'),
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }),
  uom: text('uom'),
  amount: numeric('amount', { precision: 14, scale: 2 }),
  receivedQty: numeric('received_qty').default('0'),
  isCapital: boolean('is_capital').notNull().default(false), // FA-10: capitalise on receipt (per-line override of item master)
  status: text('status').default('Open'),
  // Project/BoQ dimension (M0, docs/32) — a PO line draws a specific BoQ line's budget. Nullable.
  projectId: bigint('project_id', { mode: 'number' }),
  boqLineId: bigint('boq_line_id', { mode: 'number' }),
}, (t) => ({ byPo: index('idx_po_items_po').on(t.poId) }));

export const poDeliveries = pgTable('po_deliveries', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  poId: bigint('po_id', { mode: 'number' }).references(() => purchaseOrders.id),
  deliveryNo: integer('delivery_no'),
  itemId: text('item_id'),
  scheduledQty: numeric('scheduled_qty'),
  scheduledDate: date('scheduled_date'),
  receivedQty: numeric('received_qty').default('0'),
  status: text('status').default('Pending'),
}, (t) => ({ byPo: index('idx_po_deliveries_po').on(t.poId) }));

export const goodsReceipts = pgTable('goods_receipts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  grNo: text('gr_no').notNull().unique(),
  grDate: date('gr_date'),
  poNo: text('po_no'),
  vendorId: bigint('vendor_id', { mode: 'number' }).references(() => vendors.id),
  vendorName: text('vendor_name'),
  receivedBy: text('received_by'),
  remarks: text('remarks'),
  // C1: inherits the PO's transaction currency + rate at receipt date (migration 0175)
  currency: text('currency').notNull().default('THB'),
  fxRate: numeric('fx_rate', { precision: 14, scale: 6 }).notNull().default('1.000000'),
  // Project dimension (M0, docs/32) — inherited from the PO so a receipt carries its project. Nullable.
  projectId: bigint('project_id', { mode: 'number' }),
}, (t) => ({ byPo: index('idx_gr_pono').on(t.poNo) }));

export const grItems = pgTable('gr_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  grId: bigint('gr_id', { mode: 'number' }).references(() => goodsReceipts.id),
  poNo: text('po_no'),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  poQty: numeric('po_qty'),
  receivedQty: numeric('received_qty'),
  uom: text('uom'),
  lotNo: text('lot_no'),
  expiryDate: date('expiry_date'),
  unitCost: numeric('unit_cost', { precision: 14, scale: 2 }),
  isCapital: boolean('is_capital').notNull().default(false), // FA-10: eligible for capitalisation to the asset register
  remarks: text('remarks'),
}, (t) => ({ byGr: index('idx_gr_items_gr').on(t.grId), byPo: index('idx_gr_items_pono').on(t.poNo) }));

// ── T2-D: Supplier price-list versioning (migration 0174) ──────────────────
// Versioned purchase price per vendor+item+uom. On upsert the prior active row is superseded
// (status → 'superseded'), keeping a full audit trail. Feeds price_var_pct in supplier scorecards.
export const supplierPriceLists = pgTable('supplier_price_lists', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  vendorId: bigint('vendor_id', { mode: 'number' }).notNull().references(() => vendors.id),
  itemId: text('item_id').notNull(),
  itemDescription: text('item_description'),
  uom: text('uom').notNull().default('EA'),
  currency: text('currency').notNull().default('THB'),
  unitPrice: numeric('unit_price', { precision: 18, scale: 4 }).notNull(),
  minQty: numeric('min_qty', { precision: 14, scale: 4 }).notNull().default('1'),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  status: text('status').notNull().default('active'), // 'active' | 'superseded'
  // "ผู้ขายประจำ" (preferred supplier per item) — the buyer's default source for this item (migration 0267).
  // At most one active row per (tenant,item) carries preferred=true; setting it unsets the siblings. Drives
  // the PR→PO auto-group: a line's item is routed to its preferred vendor first, then cheapest active price,
  // then the most-recent PO vendor. Lives on the (already tenant-scoped, RLS) price list so no new table.
  preferred: boolean('preferred').notNull().default(false),
  notes: text('notes'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byVendorItem: index('idx_spl_vendor_item').on(t.tenantId, t.vendorId, t.itemId) }));

export const grClaims = pgTable('gr_claims', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  claimNo: text('claim_no').notNull().unique(),
  claimDate: date('claim_date'),
  grNo: text('gr_no'),
  poNo: text('po_no'),
  vendorId: bigint('vendor_id', { mode: 'number' }).references(() => vendors.id),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  grQty: numeric('gr_qty'),
  claimQty: numeric('claim_qty'),
  uom: text('uom'),
  reason: text('reason'),
  imageKey: text('image_key'),
  status: text('status').default('Open'),
  supplierAction: text('supplier_action'),
  resolvedBy: text('resolved_by'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  remarks: text('remarks'),
});
