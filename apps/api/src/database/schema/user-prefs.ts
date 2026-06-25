import { pgTable, bigserial, bigint, text, jsonb, timestamp, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Per-user UI preferences that should follow the user across devices — currently the sidebar favourites
// (★ pins) and the nav sub-section fold-state. A generic JSON blob keeps it extensible (future UI prefs
// slot into the same row). One row per (tenant, username); tenant-isolated via RLS, owner-scoped in queries.
// NB: 'recents' deliberately stays per-device (localStorage) — see docs/15-ui-ux-menu-restructure-plan.md.
export const userPrefs = pgTable(
  'user_prefs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    owner: text('owner').notNull(), // username that owns the preferences
    prefs: jsonb('prefs').notNull().default({}), // { favorites: string[], navFold: Record<string, boolean> }
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    tenantOwnerUniq: unique('user_prefs_tenant_owner_uniq').on(t.tenantId, t.owner),
  }),
);
