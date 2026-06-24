// C2 (Platform Phase 21) — country localization packs (the Odoo l10n model). A pack bundles CoA + tax codes +
// statutory report templates + an e-invoicing provider + locale for a country (declared in code). Applying a
// pack sets the tenant's tax country + default locale and records the active pack; the CoA/tax content is
// exposed for review (seeding it into the live ledger is a guarded follow-up). RLS-scoped; no GL.
import { pgTable, bigserial, bigint, text, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const tenantLocalization = pgTable('tenant_localization', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  country: text('country').notNull(),
  version: text('version').notNull().default('1'),
  appliedAt: timestamp('applied_at', { withTimezone: true }).defaultNow(),
  appliedBy: text('applied_by'),
});

export type TenantLocalization = typeof tenantLocalization.$inferSelect;
