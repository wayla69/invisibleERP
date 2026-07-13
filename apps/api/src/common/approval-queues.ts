// GOV-01 contributor contract (docs/46 Phase 2). The pending-approvals center aggregates ONE worklist of
// every item awaiting independent (maker-checker) approval across the system. A maker-checker's QUEUE lives
// in its owning module: any Nest provider implementing ApprovalQueueSource is discovered at boot by
// ApprovalQueueRegistrarService (finance module) and registered with FinanceService, which aggregates the
// queues in its canonical order. Adding a maker-checker = a queue in the owning module's
// *-approval-queues.ts provider — never a new inline query in finance.service.ts (the check-service-size
// ratchet enforces it). This file stays pure types/helpers: no DI, importable from any module without
// creating a module-graph edge.

export interface PendingApprovalItem {
  type: string;
  control: string;
  ref: unknown;
  label: string;
  amount: number;
  requested_by: unknown;
  requested_at: unknown;
  age_days: number | null;
}
export interface ApprovalQueue {
  // Stable key; used by FinanceService's canonical QUEUE_ORDER so the worklist's tie order (stable sort
  // on age) stays deterministic. New queues not in the canonical list are appended after it.
  source: string;
  pending(): Promise<PendingApprovalItem[]>;
}
export interface ApprovalQueueSource { approvalQueues(): ApprovalQueue[] }
export const isApprovalQueueSource = (x: unknown): x is ApprovalQueueSource =>
  typeof x === 'object' && x !== null && typeof (x as Record<string, unknown>).approvalQueues === 'function';

// The shared age computation every queue item uses (verbatim from the original GOV-01 aggregator).
export const approvalAgeDays = (d: any): number | null =>
  (d ? Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000)) : null);
