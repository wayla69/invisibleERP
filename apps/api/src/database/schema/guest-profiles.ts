// Fine-casual guest dining profiles (Michelin-style guest CRM for the reservation desk).
// PDPA-FIRST: everything here is preference/profiling data processed under EXPLICIT CONSENT — the
// member_consents purpose 'dining_profile' gates every read AND write (GuestProfileService); no consent ⇒
// nothing is stored or shown. DSAR access/portability exports these rows and erasure/retention HARD-DELETES
// them (pure preference data — no accounting value, unlike the points ledger). tenant_id REQUIRED → the
// canonical RLS loop scopes both tables.
import { pgTable, bigserial, bigint, text, integer, timestamp, boolean, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { posMembers } from './loyalty-members';

// 1:1 per member — the guest's own dining preferences, curated by front-of-house with the guest's consent.
export const memberDiningProfiles = pgTable('member_dining_profiles', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  memberId: bigint('member_id', { mode: 'number' }).notNull().references(() => posMembers.id),
  favoriteMenus: jsonb('favorite_menus'),             // string[] — dishes the guest loves (manually curated)
  favoriteIngredients: jsonb('favorite_ingredients'), // string[] — ingredients the guest favours
  allergies: jsonb('allergies'),                      // string[] — allergens to flag to the kitchen
  dietary: text('dietary'),                           // halal / vegetarian / vegan / …
  seatingPreference: text('seating_preference'),      // window / private room / counter / …
  typicalPartySize: integer('typical_party_size'),
  serviceNotes: text('service_notes'),                // free-form Michelin-style notes ("still water, no ice")
  extra: jsonb('extra'),                              // extensible key→value details (favourite wine, occasions, …)
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqMember: uniqueIndex('member_dining_profiles_member_uq').on(t.memberId),
  idxTenant: index('idx_member_dining_profiles_tenant').on(t.tenantId, t.memberId),
}));

// Companions the guest usually dines with (names + their preferences/allergies) — third-party personal
// data the guest volunteers, stored under the SAME 'dining_profile' consent and hard-deleted on erasure.
export const memberCompanions = pgTable('member_companions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  memberId: bigint('member_id', { mode: 'number' }).notNull().references(() => posMembers.id),
  name: text('name').notNull(),
  relationship: text('relationship'),                 // spouse / child / colleague / …
  allergies: jsonb('allergies'),                      // string[]
  preferences: text('preferences'),                   // free-form likes/dislikes
  notes: text('notes'),
  active: boolean('active').notNull().default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  idxTenant: index('idx_member_companions_tenant').on(t.tenantId, t.memberId),
}));

export type MemberDiningProfile = typeof memberDiningProfiles.$inferSelect;
export type MemberCompanion = typeof memberCompanions.$inferSelect;
