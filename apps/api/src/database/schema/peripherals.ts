// Phase 5 — POS hardware peripherals: a device registry plus the cash-drawer audit trail, per-terminal
// customer-display state, and weighing-scale readings. The cash drawer is kicked through the printer
// (ESC/POS), so the kick itself rides the 0074 print_jobs queue; these tables add the registry + audit/state.
import { pgTable, bigserial, bigint, text, numeric, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const posDevices = pgTable('pos_devices', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  branchId: bigint('branch_id', { mode: 'number' }),
  deviceCode: text('device_code').notNull(),          // unique per tenant
  kind: text('kind').notNull(),                        // printer | cash_drawer | display | scale
  terminal: text('terminal'),                          // POS terminal this device is attached to
  printerId: text('printer_id'),                       // for a cash_drawer: the printer that kicks it
  config: jsonb('config'),
  status: text('status').notNull().default('active'),  // active | inactive
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const drawerEvents = pgTable('drawer_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  branchId: bigint('branch_id', { mode: 'number' }),
  terminal: text('terminal'),
  tillSessionId: bigint('till_session_id', { mode: 'number' }),
  reason: text('reason').notNull(),                    // sale | no_sale | refund | paid_in | paid_out | manual
  saleNo: text('sale_no'),
  amount: numeric('amount', { precision: 14, scale: 2 }),
  printJobId: bigint('print_job_id', { mode: 'number' }),
  openedBy: text('opened_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const customerDisplays = pgTable('customer_displays', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  terminal: text('terminal').notNull(),
  state: jsonb('state'),                               // {lines, subtotal, total, amount_due, change, message}
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const scaleReadings = pgTable('scale_readings', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  terminal: text('terminal'),
  deviceCode: text('device_code'),
  sku: text('sku'),
  grossWeight: numeric('gross_weight', { precision: 14, scale: 3 }),
  tareWeight: numeric('tare_weight', { precision: 14, scale: 3 }).default('0'),
  netWeight: numeric('net_weight', { precision: 14, scale: 3 }),
  weightUnit: text('weight_unit').default('kg'),       // kg | g
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }),
  amount: numeric('amount', { precision: 14, scale: 2 }),
  saleNo: text('sale_no'),
  orderNo: text('order_no'),
  capturedBy: text('captured_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type PosDevice = typeof posDevices.$inferSelect;
export type DrawerEvent = typeof drawerEvents.$inferSelect;
export type ScaleReading = typeof scaleReadings.$inferSelect;
