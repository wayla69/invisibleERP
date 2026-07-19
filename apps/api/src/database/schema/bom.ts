import { pgTable, bigserial, bigint, text, numeric, date, timestamp, boolean } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const bomMaster = pgTable('bom_master', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  bomCode: text('bom_code').notNull().unique(),
  productName: text('product_name'),
  yieldQty: numeric('yield_qty').default('1'),
  yieldUom: text('yield_uom'),
  laborCost: numeric('labor_cost', { precision: 14, scale: 2 }),
  overheadCost: numeric('overhead_cost', { precision: 14, scale: 2 }),
  otherCost: numeric('other_cost', { precision: 14, scale: 2 }),
  sellingPrice: numeric('selling_price', { precision: 14, scale: 2 }),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }),
  createdBy: text('created_by'),
});

export const bomMasterLines = pgTable('bom_master_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  bomId: bigint('bom_id', { mode: 'number' }).references(() => bomMaster.id),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  buyUom: text('buy_uom'),
  useUom: text('use_uom'),
  convFactor: numeric('conv_factor').default('1'),
  qtyUseUom: numeric('qty_use_uom'),
  qtyBuyUom: numeric('qty_buy_uom'),
  unitCost: numeric('unit_cost', { precision: 14, scale: 2 }),
  lineCost: numeric('line_cost', { precision: 14, scale: 2 }),
  notes: text('notes'),
});

// tenant→HQ approval queue (only BOM table with live data: 3 rows)
export const bomSubmissions = pgTable('bom_submissions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  bomCode: text('bom_code'),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  productName: text('product_name'),
  yieldQty: numeric('yield_qty'),
  yieldUom: text('yield_uom'),
  laborCost: numeric('labor_cost', { precision: 14, scale: 2 }),
  overheadCost: numeric('overhead_cost', { precision: 14, scale: 2 }),
  otherCost: numeric('other_cost', { precision: 14, scale: 2 }),
  sellingPrice: numeric('selling_price', { precision: 14, scale: 2 }),
  notes: text('notes'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  submittedBy: text('submitted_by'), // maker identity for SoD (audit #6): approver must differ (bom.submission.approve)
  status: text('status').default('Pending'),
});

export const bomSubmissionLines = pgTable('bom_submission_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  submissionId: bigint('submission_id', { mode: 'number' }).references(() => bomSubmissions.id),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  buyUom: text('buy_uom'),
  useUom: text('use_uom'),
  convFactor: numeric('conv_factor').default('1'),
  qtyUseUom: numeric('qty_use_uom'),
  qtyBuyUom: numeric('qty_buy_uom'),
  unitCost: numeric('unit_cost', { precision: 14, scale: 2 }),
  lineCost: numeric('line_cost', { precision: 14, scale: 2 }),
  notes: text('notes'),
});

export const custBom = pgTable('cust_bom', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  bomCode: text('bom_code'),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  productName: text('product_name'),
  productItemId: text('product_item_id'),
  yieldQty: numeric('yield_qty'),
  yieldUom: text('yield_uom'),
  laborCost: numeric('labor_cost', { precision: 14, scale: 2 }),
  overheadCost: numeric('overhead_cost', { precision: 14, scale: 2 }),
  otherCost: numeric('other_cost', { precision: 14, scale: 2 }),
  sellingPrice: numeric('selling_price', { precision: 14, scale: 2 }),
  active: boolean('active').default(true),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }),
});

export const custBomLines = pgTable('cust_bom_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  custBomId: bigint('cust_bom_id', { mode: 'number' }).references(() => custBom.id),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  buyUom: text('buy_uom'),
  useUom: text('use_uom'),
  convFactor: numeric('conv_factor').default('1'),
  qtyUseUom: numeric('qty_use_uom'),
  qtyBuyUom: numeric('qty_buy_uom'),
  unitCost: numeric('unit_cost', { precision: 14, scale: 2 }),
  lineCost: numeric('line_cost', { precision: 14, scale: 2 }),
  notes: text('notes'),
});

export const custProdRuns = pgTable('cust_prod_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  runNo: text('run_no').notNull().unique(), // PRD-
  bomCode: text('bom_code'),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  runDate: date('run_date'),
  batchQty: numeric('batch_qty').default('1'),
  status: text('status').default('Completed'),
  totalCost: numeric('total_cost', { precision: 14, scale: 2 }),
  createdBy: text('created_by'),
});

export const custProdItems = pgTable('cust_prod_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  runId: bigint('run_id', { mode: 'number' }).references(() => custProdRuns.id),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  theoreticalQty: numeric('theoretical_qty'),
  actualQty: numeric('actual_qty'),
  variance: numeric('variance'),
  uom: text('uom'),
});

export const custVariance = pgTable('cust_variance', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  varDate: date('var_date'),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  bomCode: text('bom_code'),
  theoreticalUse: numeric('theoretical_use'),
  actualUse: numeric('actual_use'),
  variance: numeric('variance'),
  variancePct: numeric('variance_pct'),
  uom: text('uom'),
  reason: text('reason'),
  // Step 4 — normalized reason for the variance (WASTE/OVERSTOCK/SPOILAGE/PORTIONING/THEFT/OTHER) + the
  // station/section it was counted at, so the baht variance rolls up by why + where (actionable lever).
  reasonCode: text('reason_code').notNull().default('OTHER'),
  station: text('station'),
  shift: text('shift').default('Day'),
});
