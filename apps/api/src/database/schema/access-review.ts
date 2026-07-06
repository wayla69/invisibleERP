import { pgTable, bigserial, bigint, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// ITGC-AC-08: User Access Review (UAR) attestation. Each row is a periodic recertification sign-off —
// who reviewed, when, the population reviewed, and how many SoD conflicts were outstanding at the time.
export const accessReviews = pgTable('access_reviews', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  period: text('period').notNull(),                 // e.g. '2026-Q2'
  reviewedBy: text('reviewed_by').notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }).defaultNow(),
  userCount: integer('user_count'),                 // population size at review time
  conflictUserCount: integer('conflict_user_count'),// users with an SoD conflict at review time
  notes: text('notes'),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
});

export type AccessReview = typeof accessReviews.$inferSelect;

// ITGC-AC-09 (maker-checker audit G11): two-person control over a Segregation-of-Duties EXCEPTION. A grant
// whose permission set holds both sides of an SoD rule can no longer be self-authorized by the granting
// admin — it is staged here as a PendingApproval request and only takes effect when a DIFFERENT admin
// (≠ requester and ≠ the affected user) approves it. Captures the intended grant (for a new user, the
// bcrypt password hash is held until approval, mirroring signup_requests), the violated rule ids, and the
// justification — the maker-checker evidence the UAR relies on. Tenant-scoped (RLS via migration 0253).
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
