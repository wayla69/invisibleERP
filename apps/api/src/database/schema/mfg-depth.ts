import { pgTable, bigserial, bigint, text, numeric, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// ── Routings (เส้นทางการผลิต) — operation sequence template for a product ──
export const routings = pgTable(
  'routings',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    routingCode: text('routing_code').notNull(),
    productItemId: text('product_item_id'),
    name: text('name'),
    active: boolean('active').default(true),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_routing_tenant').on(t.tenantId) }),
);

export const routingOperations = pgTable(
  'routing_operations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    routingId: bigint('routing_id', { mode: 'number' }).notNull().references(() => routings.id),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    opNo: numeric('op_no').notNull(),
    workCenter: text('work_center'),
    description: text('description'),
    setupMin: numeric('setup_min', { precision: 12, scale: 2 }).default('0'),
    runMinPerUnit: numeric('run_min_per_unit', { precision: 12, scale: 4 }).default('0'),
    laborRate: numeric('labor_rate', { precision: 12, scale: 2 }).default('0'), // per hour
  },
  (t) => ({ byRouting: index('idx_rop_routing').on(t.routingId) }),
);

// ── Shop-floor: operations on a specific work order (progress + scrap) ──
export const workOrderOperations = pgTable(
  'work_order_operations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    woId: bigint('wo_id', { mode: 'number' }).notNull(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    opNo: numeric('op_no').notNull(),
    workCenter: text('work_center'),
    description: text('description'),
    plannedQty: numeric('planned_qty', { precision: 14, scale: 3 }).default('0'),
    completedQty: numeric('completed_qty', { precision: 14, scale: 3 }).default('0'),
    scrapQty: numeric('scrap_qty', { precision: 14, scale: 3 }).default('0'),
    laborCost: numeric('labor_cost', { precision: 16, scale: 2 }).default('0'),
    status: text('status').notNull().default('Pending'), // Pending | InProgress | Done
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({ byWo: index('idx_woo_wo').on(t.woId) }),
);

// ── Quality inspections (ตรวจคุณภาพ) — incoming (GR) or production (WO) ──
export const qualityInspections = pgTable(
  'quality_inspections',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    inspNo: text('insp_no').notNull(),
    refType: text('ref_type').notNull(),  // WO | GR
    refDoc: text('ref_doc'),
    itemId: text('item_id'),
    itemDescription: text('item_description'),
    qtyInspected: numeric('qty_inspected', { precision: 14, scale: 3 }).default('0'),
    qtyPassed: numeric('qty_passed', { precision: 14, scale: 3 }).default('0'),
    qtyFailed: numeric('qty_failed', { precision: 14, scale: 3 }).default('0'),
    disposition: text('disposition').notNull().default('Accept'), // Accept | Rework | Quarantine | Scrap
    scrapValue: numeric('scrap_value', { precision: 16, scale: 2 }).default('0'),
    entryNo: text('entry_no'),            // GL for scrap write-down
    notes: text('notes'),
    inspectedBy: text('inspected_by'),
    inspectedAt: timestamp('inspected_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_qi_tenant').on(t.tenantId) }),
);

export type Routing = typeof routings.$inferSelect;
