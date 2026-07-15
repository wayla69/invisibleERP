import { pgTable, smallint, text, jsonb, timestamp } from 'drizzle-orm/pg-core';

// Platform-level single-row config (docs/49, migration 0412) — the defaults every NEW SME company is
// stamped with at provisioning (tenants.sme_prefs copy). God-only via @PlatformAdmin routes; changing
// these later affects only future companies. Deliberately NO tenant_id-named column so the generic RLS
// loop + the tenant-index guard skip it (pattern: platform_notifications / signup_requests).
export const platformSmeDefaults = pgTable('platform_sme_defaults', {
  id: smallint('id').primaryKey().default(1),
  hiddenNavGroups: jsonb('hidden_nav_groups').notNull().default([]), // nav group title keys hidden for SME tenants
  accountantEmail: text('accountant_email'),                          // default SME-01 external-accountant recipient
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export type PlatformSmeDefaults = typeof platformSmeDefaults.$inferSelect;
