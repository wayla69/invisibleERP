import { pgTable, bigserial, bigint, text, boolean, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Reason-code masters for controlled POS actions (void / discount / price-override / no-sale / return / refund).
export const reasonCodes = pgTable('reason_codes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  code: text('code').notNull(),
  label: text('label').notNull(),
  appliesTo: text('applies_to').default('all'), // all | void | discount | price_override | no_sale | return | refund | paid_out
  active: boolean('active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
