import { pgTable, bigserial, bigint, integer, text, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// GRC-1 / ITGC-MON-01 — Control Console (auditor-facing RCM + test-of-effectiveness evidence). The control
// CATALOGUE itself is platform reference data read from compliance/rcm-catalog.json (identical for every
// tenant), so it is NOT a table. This table records each tenant's ToE test-RUN against a control: which
// control was tested, when, the verdict (pass/fail/na), which harness ran it, the check tally, an evidence
// reference and free-text notes. Tenant-scoped: the leading (tenant_id, control_id) index + the canonical
// 0232-form tenant_isolation RLS policy (applied in migration 0336) keep one tenant's ToE evidence private.
export const controlTestRuns = pgTable('control_test_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  controlId: text('control_id').notNull(),                 // RCM control ID, e.g. 'GL-05', 'ITGC-MON-01'
  result: text('result').notNull().default('pass'),        // pass | fail | na
  harness: text('harness'),                                // e.g. 'compliance', 'basics', 'manual'
  checksPassed: integer('checks_passed'),
  checksTotal: integer('checks_total'),
  evidenceRef: text('evidence_ref'),                       // link / artifact reference (CI run, doc id, …)
  notes: text('notes'),
  recordedBy: text('recorded_by'),
  runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byTenantControl: index('idx_control_test_runs_tenant').on(t.tenantId, t.controlId, t.runAt),
}));

export type ControlTestRun = typeof controlTestRuns.$inferSelect;
