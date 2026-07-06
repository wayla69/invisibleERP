// Fixed Assets (FI-AA): asset register + straight-line monthly depreciation + disposal.
// Every table carries tenant_id → the 0007 RLS loop scopes them. GL effects via LedgerService.postEntry.
import { pgTable, bigserial, bigint, boolean, text, numeric, date, integer, timestamp, pgEnum, unique, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const depMethodEnum = pgEnum('dep_method', ['straight_line']);
export const assetStatusEnum = pgEnum('asset_status', ['active', 'disposed', 'fully_depreciated']);

export const assetCategories = pgTable('asset_categories', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  defaultUsefulLifeYears: integer('default_useful_life_years').notNull().default(5),
  assetAccount: text('asset_account').notNull().default('1500'),
  accumDepAccount: text('accum_dep_account').notNull().default('1590'),
  depExpenseAccount: text('dep_expense_account').notNull().default('5200'),
  active: text('active').default('true'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqCatPerTenant: unique('uq_asset_cat').on(t.tenantId, t.code) }));

export const fixedAssets = pgTable('fixed_assets', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  assetNo: text('asset_no').notNull(),
  categoryId: bigint('category_id', { mode: 'number' }).references(() => assetCategories.id),
  name: text('name').notNull(),
  acquireDate: date('acquire_date').notNull(),
  acquireCost: numeric('acquire_cost', { precision: 18, scale: 4 }).notNull(),
  salvageValue: numeric('salvage_value', { precision: 18, scale: 4 }).notNull().default('0'),
  usefulLifeMonths: integer('useful_life_months').notNull(),
  depreciationMethod: depMethodEnum('depreciation_method').notNull().default('straight_line'),
  status: assetStatusEnum('status').notNull().default('active'),
  accumulatedDepreciation: numeric('accumulated_depreciation', { precision: 18, scale: 4 }).notNull().default('0'),
  netBookValue: numeric('net_book_value', { precision: 18, scale: 4 }).notNull(),
  lastDepreciatedPeriod: text('last_depreciated_period'),
  disposedDate: date('disposed_date'),
  disposalProceeds: numeric('disposal_proceeds', { precision: 18, scale: 4 }),
  disposalGainLoss: numeric('disposal_gain_loss', { precision: 18, scale: 4 }),
  disposalPending: boolean('disposal_pending').notNull().default(false), // FA-09 maker-checker: disposal requested, awaiting approval
  disposalRequestedBy: text('disposal_requested_by'),                     // preparer (maker)
  disposalApprovedBy: text('disposal_approved_by'),                       // checker — must differ from requester
  acquireSource: text('acquire_source').notNull().default('cash'),
  // Procure-to-Capitalize traceability (FA-10): the goods receipt / purchase order this asset was
  // capitalised from. NULL for assets acquired directly (cash purchase via POST /api/assets).
  sourceGrNo: text('source_gr_no'),
  sourcePoNo: text('source_po_no'),
  // Physical-tracking fields (for QR asset tags + scan-to-locate). Accounting
  // status stays in `status`; these track where the asset physically is / who holds it.
  location: text('location'),
  department: text('department'),
  serialNo: text('serial_no'),
  assignedTo: text('assigned_to'),
  notes: text('notes'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqAssetPerTenant: unique('uq_fixed_asset_no').on(t.tenantId, t.assetNo), byStatus: index('idx_fa_status').on(t.status) }));

// Audit trail of physical asset moves (location/status changes via QR scan).
// tenant-scoped → covered by the RLS loop re-run in the migration.
export const assetMovements = pgTable('asset_movements', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  assetId: bigint('asset_id', { mode: 'number' }).references(() => fixedAssets.id),
  assetNo: text('asset_no'),
  moveDate: timestamp('move_date', { withTimezone: true }).defaultNow(),
  moveType: text('move_type'), // 'Scan Update' | 'Transfer' | 'Status Change'
  fromLocation: text('from_location'),
  toLocation: text('to_location'),
  fromStatus: text('from_status'),
  toStatus: text('to_status'),
  note: text('note'),
  byUser: text('by_user'),
});

// Asset revaluation / impairment (FA-07). An upward revaluation credits the revaluation surplus (equity
// 3200); a downward revaluation (impairment) debits impairment loss (5820). Each event is logged here for
// the audit trail; the asset's net_book_value is adjusted and the gross 1500 moved by the delta.
export const assetRevaluations = pgTable('asset_revaluations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  assetId: bigint('asset_id', { mode: 'number' }).references(() => fixedAssets.id),
  assetNo: text('asset_no'),
  revalDate: date('reval_date'),
  kind: text('kind').notNull(), // revaluation (up) | impairment (down)
  oldValue: numeric('old_value', { precision: 18, scale: 4 }).notNull(),
  newValue: numeric('new_value', { precision: 18, scale: 4 }).notNull(),
  delta: numeric('delta', { precision: 18, scale: 4 }).notNull(),
  reason: text('reason'),
  glRef: text('gl_ref'),
  actionedBy: text('actioned_by'),                  // preparer (maker)
  status: text('status').notNull().default('Posted'), // FA-08 maker-checker: PendingApproval | Posted | Rejected
  approvedBy: text('approved_by'),                   // checker — must differ from actionedBy
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byAsset: index('idx_reval_asset').on(t.assetNo) }));

// Asset registration request (FA-10 maker-checker). A capital GR line is capitalised onto the asset register
// only via this request: a preparer raises it (PendingApproval, NO GL effect) and a DIFFERENT user approves,
// at which point the fixed_assets row + acquisition JE (Dr 1500 / Cr 2000) are created and asset_no stamped
// back here. tenant-scoped → covered by the RLS loop re-run in migration 0137.
export const assetRegistrationRequests = pgTable('asset_registration_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  regNo: text('reg_no').notNull(),                  // FAR-YYYYMMDD-NNN
  grNo: text('gr_no'),                              // source goods receipt
  poNo: text('po_no'),                              // source purchase order (traceability)
  grItemId: bigint('gr_item_id', { mode: 'number' }), // the specific GR line being capitalised
  itemId: text('item_id'),
  name: text('name').notNull(),
  categoryId: bigint('category_id', { mode: 'number' }).references(() => assetCategories.id),
  acquireDate: date('acquire_date'),
  acquireCost: numeric('acquire_cost', { precision: 18, scale: 4 }).notNull(),
  salvageValue: numeric('salvage_value', { precision: 18, scale: 4 }).notNull().default('0'),
  usefulLifeMonths: integer('useful_life_months'),
  acquireSource: text('acquire_source').notNull().default('credit'),
  location: text('location'),
  department: text('department'),
  serialNo: text('serial_no'),
  notes: text('notes'),
  status: text('status').notNull().default('PendingApproval'), // PendingApproval | Posted | Rejected
  assetNo: text('asset_no'),                        // the created fixed asset, once approved
  requestedBy: text('requested_by'),                // preparer (maker)
  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow(),
  approvedBy: text('approved_by'),                  // checker — must differ from requestedBy
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectReason: text('reject_reason'),
}, (t) => ({ uqRegNo: unique('uq_asset_reg_no').on(t.tenantId, t.regNo), byStatus: index('idx_asset_reg_status').on(t.tenantId, t.status), byGr: index('idx_asset_reg_gr').on(t.grNo) }));

export const depreciationRuns = pgTable('depreciation_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  runNo: text('run_no').notNull(),
  period: text('period').notNull(),
  postedAt: timestamp('posted_at', { withTimezone: true }).defaultNow(),
  totalDepreciation: numeric('total_depreciation', { precision: 18, scale: 4 }).notNull(),
  assetCount: integer('asset_count').notNull().default(0),
  journalNo: text('journal_no'),
  createdBy: text('created_by'),
}, (t) => ({ uqRunPeriodPerTenant: unique('uq_dep_run_period').on(t.tenantId, t.period) }));

export const depreciationLines = pgTable('depreciation_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  runId: bigint('run_id', { mode: 'number' }).notNull().references(() => depreciationRuns.id),
  assetId: bigint('asset_id', { mode: 'number' }).notNull().references(() => fixedAssets.id),
  amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
  accumulatedAfter: numeric('accumulated_after', { precision: 18, scale: 4 }).notNull(),
  nbvAfter: numeric('nbv_after', { precision: 18, scale: 4 }).notNull(),
});

// FA-11 — asset custody-change maker-checker. A scan that would MOVE an asset (change location/holder)
// no longer writes the register directly: it raises a PendingApproval request here (NO GL effect); a
// DIFFERENT user must approve before the register moves + an asset_movements 'Scan Update' row is written.
// A scan that CONFIRMS the current location (no change) is logged immediately as a 'Scan Verify' movement
// and needs no approval. Self-approve → SOD_VIOLATION (binds even Admin). tenant-scoped → RLS loop (0251).
export const assetScanRequests = pgTable('asset_scan_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  reqNo: text('req_no').notNull(),                  // FAC-YYYYMMDD-NNN
  assetId: bigint('asset_id', { mode: 'number' }).references(() => fixedAssets.id),
  assetNo: text('asset_no').notNull(),
  fromLocation: text('from_location'),
  toLocation: text('to_location'),
  fromAssignedTo: text('from_assigned_to'),
  toAssignedTo: text('to_assigned_to'),
  note: text('note'),
  source: text('source').notNull().default('scan'), // 'scan' | 'audit'
  auditNo: text('audit_no'),                         // set when raised by an audit reconciliation
  status: text('status').notNull().default('PendingApproval'), // PendingApproval | Approved | Rejected
  requestedBy: text('requested_by'),                // maker (custodian / counter)
  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow(),
  approvedBy: text('approved_by'),                  // checker — must differ from requestedBy
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectReason: text('reject_reason'),
}, (t) => ({ uqReqNo: unique('uq_asset_scan_req_no').on(t.tenantId, t.reqNo), byStatus: index('idx_asset_scan_req_status').on(t.tenantId, t.status), byAsset: index('idx_asset_scan_req_asset').on(t.assetNo) }));

// Asset audit (physical count by scan). Open a session for a location, scan the tags present; each scan is
// classified against the register (Found / Misplaced / Unknown). Reconciliation adds Missing (expected at
// the location but not scanned). Closing raises FA-11 custody-change requests for the misplaced assets.
export const assetAudits = pgTable('asset_audits', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  auditNo: text('audit_no').notNull(),              // AUD-YYYYMMDD-NNN
  location: text('location'),                        // null = whole tenant
  status: text('status').notNull().default('Open'), // Open | Closed
  expectedCount: integer('expected_count').notNull().default(0),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: text('closed_by'),
}, (t) => ({ uqAuditNo: unique('uq_asset_audit_no').on(t.tenantId, t.auditNo), byStatus: index('idx_asset_audit_status').on(t.tenantId, t.status) }));

export const assetAuditScans = pgTable('asset_audit_scans', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  auditNo: text('audit_no').notNull(),
  assetNo: text('asset_no').notNull(),
  result: text('result').notNull(),                 // Found | Misplaced | Unknown
  registerLocation: text('register_location'),      // where the register says it is (for Misplaced)
  clientUuid: text('client_uuid'),                  // offline idempotency key — dedup on replay
  scannedBy: text('scanned_by'),
  scannedAt: timestamp('scanned_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqScanUuid: unique('uq_asset_audit_scan_uuid').on(t.tenantId, t.auditNo, t.clientUuid), byAudit: index('idx_asset_audit_scan_audit').on(t.auditNo) }));

export type FixedAsset = typeof fixedAssets.$inferSelect;
export type AssetCategory = typeof assetCategories.$inferSelect;
export type DepreciationRun = typeof depreciationRuns.$inferSelect;
