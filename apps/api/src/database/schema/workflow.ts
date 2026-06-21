// Phase 15 — Generic Approval Workflow engine + Segregation of Duties (SoD). One polymorphic engine:
// documents bind by (doc_type, doc_no) only; modules never fork. The engine GATES other modules' postings
// (it posts NOTHING to the GL itself). Every table carries tenant_id → RLS-isolated by the 0002 loop.
import { pgTable, bigserial, bigint, text, numeric, integer, boolean, timestamp, date, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// per-tenant, per-doc_type workflow config
export const workflowDefinitions = pgTable('workflow_definitions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  docType: text('doc_type').notNull(),          // 'PR' | 'PO' | 'AP_PAY' | 'JE' | ...
  name: text('name').notNull(),
  active: boolean('active').default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byType: index('idx_wfdef_type').on(t.tenantId, t.docType) }));

// ordered steps. routes to a role OR a user; ENGAGES only when min_amount <= amount. all_of_n>1 = parallel.
export const workflowSteps = pgTable('workflow_steps', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  definitionId: bigint('definition_id', { mode: 'number' }).notNull().references(() => workflowDefinitions.id),
  stepNo: integer('step_no').notNull(),
  approverRole: text('approver_role'),          // role; XOR with approverUser
  approverUser: text('approver_user'),          // username; XOR with approverRole
  minAmount: numeric('min_amount', { precision: 14, scale: 2 }).default('0'),
  allOfN: integer('all_of_n').default(1),
  name: text('name'),
}, (t) => ({ byDef: uniqueIndex('uq_wfstep_def_no').on(t.definitionId, t.stepNo) }));

// one runtime instance per submitted document
export const workflowInstances = pgTable('workflow_instances', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  definitionId: bigint('definition_id', { mode: 'number' }).references(() => workflowDefinitions.id),
  docType: text('doc_type').notNull(),
  docNo: text('doc_no').notNull(),
  amount: numeric('amount', { precision: 14, scale: 2 }).default('0'),
  createdBy: text('created_by').notNull(),       // the maker — SoD anchor
  status: text('status').notNull().default('pending'),  // pending | approved | rejected | cancelled
  currentStep: integer('current_step').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (t) => ({ byDoc: index('idx_wfinst_doc').on(t.tenantId, t.docType, t.docNo), byStatus: index('idx_wfinst_status').on(t.tenantId, t.status) }));

// append-only audit trail of every decision
export const approvalActions = pgTable('approval_actions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  instanceId: bigint('instance_id', { mode: 'number' }).notNull().references(() => workflowInstances.id),
  stepNo: integer('step_no').notNull(),
  actor: text('actor').notNull(),
  onBehalfOf: text('on_behalf_of'),              // delegator, if acted via delegation
  decision: text('decision').notNull(),          // approve | reject
  comment: text('comment'),
  actedAt: timestamp('acted_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byInstance: index('idx_appract_instance').on(t.instanceId) }));

// user A delegates approvals to user B for a date range
export const approvalDelegations = pgTable('approval_delegations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  fromUser: text('from_user').notNull(),
  toUser: text('to_user').notNull(),
  fromDate: date('from_date').notNull(),
  toDate: date('to_date').notNull(),
  active: boolean('active').default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byTo: index('idx_deleg_to').on(t.tenantId, t.toUser) }));

// SoD: conflicting permission/action pairs + maker-checker toggle
export const sodRules = pgTable('sod_rules', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('PERM_PAIR'), // MAKER_CHECKER | PERM_PAIR
  docType: text('doc_type'),
  permA: text('perm_a'),
  permB: text('perm_b'),
  active: boolean('active').default(true),
}, (t) => ({ byTenant: index('idx_sod_tenant').on(t.tenantId) }));

export type WorkflowDefinition = typeof workflowDefinitions.$inferSelect;
export type WorkflowInstance = typeof workflowInstances.$inferSelect;
export type ApprovalAction = typeof approvalActions.$inferSelect;
