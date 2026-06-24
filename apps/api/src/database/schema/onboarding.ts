// E1 (Platform Phase 26) — guided onboarding + industry template packs. `onboarding_progress` tracks which
// setup steps a tenant has completed; `pack_installs` records which industry packs were applied. The pack
// CONTENT (the custom objects each pack seeds) is declared in code (OnboardingService). RLS-scoped; no GL.
import { pgTable, bigserial, bigint, text, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const onboardingProgress = pgTable('onboarding_progress', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  stepKey: text('step_key').notNull(),
  doneAt: timestamp('done_at', { withTimezone: true }).defaultNow(),
  doneBy: text('done_by'),
});

export const packInstalls = pgTable('pack_installs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  packKey: text('pack_key').notNull(),
  version: text('version').notNull().default('1'),
  installedAt: timestamp('installed_at', { withTimezone: true }).defaultNow(),
  installedBy: text('installed_by'),
});

export type OnboardingProgress = typeof onboardingProgress.$inferSelect;
export type PackInstall = typeof packInstalls.$inferSelect;
