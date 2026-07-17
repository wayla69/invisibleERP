import { pgTable, bigint, boolean, text, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Per-tenant public-QR-ordering controls (SOX-ICFR #3, migration 0431). One row per tenant; absence = the
// defaults (auto-fire on). Tenant-scoped (RLS via the canonical policy; PK is the leading tenant_id index).
export const qrSettings = pgTable('qr_settings', {
  tenantId: bigint('tenant_id', { mode: 'number' }).primaryKey().references(() => tenants.id),
  requireStaffFire: boolean('require_staff_fire').notNull().default(false),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
