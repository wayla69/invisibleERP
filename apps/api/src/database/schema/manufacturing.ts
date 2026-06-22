import { pgTable, bigserial, bigint, text, numeric, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Production / work orders (ใบสั่งผลิต) — make a finished good from a BOM. Tenant-scoped (RLS).
// Costing is BOM-standard: material (Σ component line cost) + labor + overhead → total / unit.
export const workOrders = pgTable(
  'work_orders',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    woNo: text('wo_no').notNull(),
    bomId: bigint('bom_id', { mode: 'number' }),
    bomCode: text('bom_code'),
    productItemId: text('product_item_id'),
    productName: text('product_name'),
    uom: text('uom'),
    qtyPlanned: numeric('qty_planned', { precision: 14, scale: 3 }).notNull().default('0'),
    qtyProduced: numeric('qty_produced', { precision: 14, scale: 3 }).default('0'),
    status: text('status').notNull().default('Open'), // Open | Released | Completed | Cancelled
    materialCost: numeric('material_cost', { precision: 16, scale: 2 }).default('0'),
    laborCost: numeric('labor_cost', { precision: 16, scale: 2 }).default('0'),
    overheadCost: numeric('overhead_cost', { precision: 16, scale: 2 }).default('0'),
    totalCost: numeric('total_cost', { precision: 16, scale: 2 }).default('0'),
    unitCost: numeric('unit_cost', { precision: 16, scale: 4 }).default('0'),
    entryNoIssue: text('entry_no_issue'),       // GL JE for material+labor+oh → WIP
    entryNoComplete: text('entry_no_complete'), // GL JE for WIP → finished goods
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_wo_tenant').on(t.tenantId) }),
);

// Component requirements of a work order — scaled from the BOM lines to the planned qty.
export const workOrderComponents = pgTable(
  'work_order_components',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    woId: bigint('wo_id', { mode: 'number' }).notNull().references(() => workOrders.id),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    itemId: text('item_id'),
    itemDescription: text('item_description'),
    uom: text('uom'),
    qtyRequired: numeric('qty_required', { precision: 14, scale: 3 }).default('0'),
    unitCost: numeric('unit_cost', { precision: 14, scale: 4 }).default('0'),
    lineCost: numeric('line_cost', { precision: 16, scale: 2 }).default('0'),
  },
  (t) => ({ byWo: index('idx_woc_wo').on(t.woId) }),
);

export type WorkOrder = typeof workOrders.$inferSelect;
