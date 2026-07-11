import { pgTable, bigserial, bigint, text, integer, boolean, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// ITGC-AC-08 / ITGC-AC-21: User Access Review (UAR) attestation. Each row is a periodic recertification —
// who reviewed, when, the population reviewed, and how many SoD conflicts were outstanding at the time.
// A row is either a legacy BLANKET sign-off (status='certified' on insert) or a line-item RECERTIFICATION
// CAMPAIGN (ITGC-AC-21): opened as status='open', drifts to 'in_review' as items are dispositioned, and is
// finalized as 'certified' — at which point every 'revoke' decision has actually removed the user's grants
// (see access_review_items.actioned; the closed loop).
export const accessReviews = pgTable('access_reviews', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  period: text('period').notNull(),                 // e.g. '2026-Q2'
  reviewedBy: text('reviewed_by').notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }).defaultNow(),
  userCount: integer('user_count'),                 // population size at review time
  conflictUserCount: integer('conflict_user_count'),// users with an SoD conflict at review time
  notes: text('notes'),
  status: text('status').notNull().default('certified'), // certified (blanket) | open | in_review | certified (campaign)
  itemsTotal: integer('items_total'),               // line items in a recertification campaign
  itemsRevoked: integer('items_revoked'),           // items whose 'revoke' decision was applied (closed loop)
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
});

export type AccessReview = typeof accessReviews.$inferSelect;

// ITGC-AC-21: line-item Access Recertification. One row per user in a campaign — the reviewer keeps or
// revokes each user's access IN-APP, and on campaign certification a 'revoke' decision ACTUALLY removes the
// user's permission grants (actioned=true; closed-loop revocation). current_perms is the effective-permission
// snapshot at open time (the recertification evidence). Tenant-scoped (RLS via migration 0336).
export const accessReviewItems = pgTable('access_review_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  reviewId: bigint('review_id', { mode: 'number' }).notNull().references(() => accessReviews.id),
  username: text('username').notNull(),
  role: text('role'),                               // role snapshot at open time
  currentPerms: text('current_perms'),              // JSON array of effective permissions at open time
  decision: text('decision').notNull().default('pending'), // pending | keep | revoke
  reviewer: text('reviewer'),                       // who dispositioned this line
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  actioned: boolean('actioned').notNull().default(false), // a 'revoke' whose grants were actually removed
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type AccessReviewItem = typeof accessReviewItems.$inferSelect;

// ITGC-AC-09 (maker-checker audit G11): two-person control over a Segregation-of-Duties EXCEPTION. A grant
// whose permission set holds both sides of an SoD rule can no longer be self-authorized by the granting
// admin — it is staged here as a PendingApproval request and only takes effect when a DIFFERENT admin
// (≠ requester and ≠ the affected user) approves it. Captures the intended grant (for a new user, the
// bcrypt password hash is held until approval, mirroring signup_requests), the violated rule ids, and the
// justification — the maker-checker evidence the UAR relies on. Tenant-scoped (RLS via migration 0260).
export const accessGrantExceptions = pgTable('access_grant_exceptions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  reqNo: text('req_no').notNull(),                    // AGE-YYYYMMDD-NNN
  targetUsername: text('target_username').notNull(),
  isNewUser: text('is_new_user').notNull().default('false'), // 'true' → create on approval; 'false' → update
  passwordHash: text('password_hash'),                // held until approval (new user only)
  role: text('role'),
  permissions: text('permissions'),                   // JSON array string of the requested (conflicting) override
  customerName: text('customer_name'),                // tenant code for a new user
  sodRules: text('sod_rules'),                        // comma-joined violated SoD rule ids (evidence)
  reason: text('reason').notNull(),
  status: text('status').notNull().default('PendingApproval'), // PendingApproval | Approved | Rejected
  requestedBy: text('requested_by'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow(),
  approvedBy: text('approved_by'),                    // checker — must differ from requester AND target
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectReason: text('reject_reason'),
});

export type AccessGrantException = typeof accessGrantExceptions.$inferSelect;
