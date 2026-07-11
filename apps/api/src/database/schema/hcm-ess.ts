import { pgTable, bigserial, bigint, text, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// ── HR-8 (docs/42 HCM depth, Wave 3) — Employee Self-Service (ESS) depth ──────────────────────────────────
// Extends the ESS surface on the payroll.employees identity (emp_code). Two tenant-scoped tables (RLS + a
// leading (tenant_id, …) index). The HR-08 profile-change control lives in hcm-ess.service.ts:
//   - a change to a SENSITIVE profile field (bank_account, national_id, name, tax_id) is parked `pending` in
//     ess_profile_change_requests and the employees master is written ONLY when a DIFFERENT hr/hr_admin user
//     approves (approved_by ≠ requested_by → SOD_SELF_APPROVAL; an employee cannot self-approve). Reject
//     leaves the master unchanged. Applying an approved request audit-logs the before/after (StatusLogService
//     docType ESSPROFILE).
//   - a change to a LOW-RISK field (phone, address, emergency_contact) auto-applies at request time (status
//     `applied`) — still recorded for the audit trail.
//   - own-scope: an `ess` caller may only see/modify their OWN requests + documents (emp_code = the caller's
//     linked employee); a second employee gets 404/empty. HR/hr_admin see all (or filter by emp_code).

// ESS profile-change requests — an employee-submitted change to a single profile field on their own record.
export const essProfileChangeRequests = pgTable(
  'ess_profile_change_requests',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    empCode: text('emp_code').notNull(),
    field: text('field').notNull(),                     // 'name' | 'national_id' | 'bank_account' | 'tax_id' | 'phone' | 'address' | 'emergency_contact'
    oldValue: text('old_value'),                        // masked for sensitive fields in the API response
    newValue: text('new_value').notNull(),
    sensitive: text('sensitive').notNull().default('false'), // 'true' if the field requires HR approval
    status: text('status').notNull().default('pending'),     // 'pending' | 'approved' | 'rejected' | 'applied'
    reason: text('reason'),
    requestedBy: text('requested_by'),
    approvedBy: text('approved_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => ({
    byEmp: index('idx_ess_change_emp').on(t.tenantId, t.empCode),
    byStatus: index('idx_ess_change_status').on(t.tenantId, t.status),
  }),
);

// Employee documents — a personal document-center row (contract, ID scan, certificate, …). file_ref is either
// an inline note or an `objstore:<key>` object-storage reference (isSafeObjectKey-validated on write).
export const employeeDocuments = pgTable(
  'employee_documents',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    empCode: text('emp_code').notNull(),
    docType: text('doc_type').notNull(),                // 'contract' | 'id_card' | 'certificate' | 'tax_form' | 'other'
    title: text('title').notNull(),
    fileRef: text('file_ref'),                          // objstore:<key> or a free-text note
    visibility: text('visibility').notNull().default('private'), // 'private' (own+HR) | 'hr' (HR only)
    uploadedBy: text('uploaded_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    byEmp: index('idx_emp_doc_emp').on(t.tenantId, t.empCode),
    byType: index('idx_emp_doc_type').on(t.tenantId, t.docType),
  }),
);

export type EssProfileChangeRequest = typeof essProfileChangeRequests.$inferSelect;
export type EmployeeDocument = typeof employeeDocuments.$inferSelect;
