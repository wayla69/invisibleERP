// Row shapers for the projects module (docs/38 §3 projects decomposition, extraction PR-1) — the DB-row →
// API-shape mappers, moved verbatim. Pure functions of their input rows.
import { n } from '../../database/queries';
import { csvToList, r2 } from './projects.helpers';
export function shapeTask(t: any) {
  return { id: Number(t.id), project_id: Number(t.projectId), parent_id: t.parentId != null ? Number(t.parentId) : null, wbs_code: t.wbsCode, name: t.name, status: t.status, planned_start: t.plannedStart, planned_end: t.plannedEnd, planned_hours: n(t.plannedHours), planned_cost: n(t.plannedCost), pct_complete: n(t.pctComplete), depends_on: t.dependsOn ? String(t.dependsOn).split(',').map((x: string) => Number(x)).filter((x: number) => Number.isFinite(x)) : [], constraint_type: t.constraintType ?? null, constraint_offset_days: t.constraintOffsetDays != null ? Number(t.constraintOffsetDays) : null, assignee: t.assignee, accountable: t.accountable ?? null, responsible: csvToList(t.responsible), consulted: csvToList(t.consulted), informed: csvToList(t.informed), created_at: t.createdAt };
}
export function shapeMilestone(m: any) {
  return { id: Number(m.id), project_id: Number(m.projectId), name: m.name, due_date: m.dueDate, owner: m.owner, status: m.status, billing_percent: m.billingPercent != null ? n(m.billingPercent) : null, reached_at: m.reachedAt, created_at: m.createdAt };
}
export function shapeResource(r: any) {
  return { id: Number(r.id), project_id: Number(r.projectId), task_id: r.taskId != null ? Number(r.taskId) : null, resource_name: r.resourceName, role: r.role, alloc_pct: n(r.allocPct), period_start: r.periodStart, period_end: r.periodEnd, cost_rate: n(r.costRate), bill_rate: n(r.billRate), created_at: r.createdAt };
}
export function shapeTemplateItem(it: any) {
  return { id: Number(it.id), item_type: it.itemType, seq: Number(it.seq), name: it.name, parent_seq: it.parentSeq != null ? Number(it.parentSeq) : null, wbs_code: it.wbsCode, planned_hours: n(it.plannedHours), planned_cost: n(it.plannedCost), offset_start_days: Number(it.offsetStartDays ?? 0), offset_end_days: Number(it.offsetEndDays ?? 0), depends_on_seq: it.dependsOnSeq ? String(it.dependsOnSeq).split(',').map((x: string) => Number(x)).filter((x: number) => Number.isFinite(x)) : [], billing_percent: it.billingPercent != null ? n(it.billingPercent) : null, owner: it.owner, assignee: it.assignee };
}
export function shapeRisk(r: any) {
  return { id: Number(r.id), project_id: Number(r.projectId), kind: r.kind, title: r.title, status: r.status, probability: r.probability != null ? Number(r.probability) : null, impact: Number(r.impact), score: Number(r.score), rag: r.rag, owner: r.owner, mitigation: r.mitigation, due_date: r.dueDate, created_by: r.createdBy, created_at: r.createdAt, closed_at: r.closedAt };
}
export function shapeHealth(h: any) {
  return { snapshot_date: h.snapshotDate, rag: h.rag, cpi: h.cpi != null ? n(h.cpi) : null, spi: h.spi != null ? n(h.spi) : null, pct_complete: n(h.pctComplete), bac: n(h.bac), ev: n(h.ev), ac: n(h.ac), eac: n(h.eac), margin: n(h.margin), wip: n(h.wip), created_at: h.createdAt };
}
export function shapeChangeOrder(c: any) {
  return { id: Number(c.id), co_no: c.coNo, description: c.description, contract_delta: n(c.contractDelta), budget_delta: n(c.budgetDelta), estimated_cost_delta: n(c.estimatedCostDelta), reason: c.reason, status: c.status, requested_by: c.requestedBy, approved_by: c.approvedBy, created_at: c.createdAt, approved_at: c.approvedAt };
}
export function shapeBaseline(b: any) {
  return { id: Number(b.id), label: b.label, baseline_bac: n(b.baselineBac), baseline_duration_days: Number(b.baselineDurationDays), baseline_end: b.baselineEnd, reason: b.reason, status: b.status, created_by: b.createdBy, captured_at: b.capturedAt };
}
// BoQ line (M0, docs/32). remeasure_variance_qty = remeasured − budgeted (null until re-measured).
export function shapeBoqLine(l: any) {
  const remeasured = l.remeasuredQty != null ? n(l.remeasuredQty) : null;
  return {
    id: Number(l.id), line_no: Number(l.lineNo), category: l.category, item_no: l.itemNo ?? null, task_id: l.taskId != null ? Number(l.taskId) : null,
    wbs_code: l.wbsCode ?? null, description: l.description ?? null, uom: l.uom ?? null,
    budget_qty: n(l.budgetQty), rate: n(l.rate), budget_amount: n(l.budgetAmount),
    remeasured_qty: remeasured, remeasure_variance_qty: remeasured != null ? r2(remeasured - n(l.budgetQty)) : null,
  };
}
