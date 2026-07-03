import { pgTable, bigserial, bigint, text, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Approval-queue onboarding (ITGC-AC-18 #3). Platform-level (pre-tenant): a public "request access" form
// creates a PENDING row (no tenant yet); a platform owner approves (→ provisions) or rejects. The resolved
// tenant is `created_tenant_id` (NOT `tenant_id`, so the RLS loop never scopes this platform table). The
// requester's password is stored HASHED and used on approve.
export const signupRequests = pgTable('signup_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyName: text('company_name').notNull(),
  tenantCode: text('tenant_code').notNull(),
  adminUsername: text('admin_username').notNull(),
  passwordHash: text('password_hash').notNull(),
  email: text('email').notNull(),
  industry: text('industry'),
  status: text('status').notNull().default('pending'),
  rejectReason: text('reject_reason'),
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdTenantId: bigint('created_tenant_id', { mode: 'number' }).references(() => tenants.id),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
});
