import { pgTable, bigint, boolean, integer, text, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Per-tenant public-QR-ordering controls (SOX-ICFR #3, migration 0431). One row per tenant; absence = the
// defaults (auto-fire on). Tenant-scoped (RLS via the canonical policy; PK is the leading tenant_id index).
export const qrSettings = pgTable('qr_settings', {
  tenantId: bigint('tenant_id', { mode: 'number' }).primaryKey().references(() => tenants.id),
  requireStaffFire: boolean('require_staff_fire').notNull().default(false),
  // dynamic QR (0434): when on, a scanned printed QR only JOINS a staff-opened table and stops working once
  // the bill closes — it will not self-open a session.
  dynamicMode: boolean('dynamic_mode').notNull().default(false),
  // when on (0434), a paid table is freed straight to 'available' (skips the 'cleaning' hold).
  autoCloseOnPaid: boolean('auto_close_on_paid').notNull().default(false),
  // how the diner menu picks its recommended set (0435): 'manual' | 'behavior' | 'popular_low_cost'.
  recommendMode: text('recommend_mode').notNull().default('manual'),
  recommendCount: integer('recommend_count').notNull().default(6),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
