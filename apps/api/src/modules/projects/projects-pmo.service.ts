// PMO command-center aggregators (docs/46 god-service burn-down round 5): the read-only cross-project /
// cross-sub-service compositions — portfolio EVM rollup (A1), action center (PMO-1, PROJ-11), forward
// resource & cash forecast (PMO-2), period governance pack (PMO-3), and resource leveling (PPM-A2,
// PROJ-23). Plain class constructed in the ProjectsService ctor BODY (not a DI provider) so the facade's
// positional (db, ledger) goldenmaster construction stays valid; bodies moved VERBATIM. Everything here is
// detective/read-only — it posts nothing — and reaches the facade's own reads through the `ports` closures
// (the same loop-back pattern as the other projects sub-services).
import { eq, and, desc, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { projects, projectMilestones, projectBaselines, projectChangeOrders, projectHealthSnapshots, projectMaterialRequisitions, crmOpportunities, timesheets, projectResources, resourceCalendar, stockReservations } from '../../database/schema';
import type { RetentionService } from '../retention/retention.service';
import { ymd, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { r2, DEFAULT_REV_PER_FTE_MONTH, r4, addDays } from './projects.helpers';

/** Loop-back ports into the facade's reads (and, via it, the other sub-services). */
export interface ProjectsPmoPorts {
  row(code: string): Promise<any>;
  list(user: JwtUser): Promise<any>;
  get(code: string): Promise<any>;
  evm(code: string, asOf?: string): Promise<any>;
  schedule(code: string): Promise<any>;
  earnedSchedule(code: string, asOf?: string): Promise<any>;
  evmByCategory(code: string): Promise<any>;
  healthHistory(code: string): Promise<any>;
  getBaseline(code: string, user: JwtUser): Promise<any>;
  listRisks(code: string): Promise<any>;
  listMilestones(code: string): Promise<any>;
  listChangeOrders(code: string): Promise<any>;
  topRisks(user: JwtUser): Promise<any>;
  resourceUtilization(user: JwtUser): Promise<any>;
  resourceCapacity(user: JwtUser, dto?: { months?: number; from?: string }): Promise<any>;
  ragOf(cpi: number | null, spi: number | null): string;
}

export class ProjectsPmoService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly ports: ProjectsPmoPorts,
    // docs/35 Depth-1 — optional exactly when the facade's @Optional retention dep is absent.
    private readonly retention?: RetentionService,
  ) {}

  // ── Resource leveling (PPM-A2, PROJ-23) ───────────────────────────────────
  // Detects a month where a named resource is over-allocated WITHIN this project's own assignments (the
  // same calendar-aware ceiling as the tenant-wide resourceCapacity heatmap — default 100% absent a
  // resource_calendar override), then cross-references the CPM schedule's per-task SLACK (schedule(),
  // PROJ-06/21) to suggest which task-linked assignment could be shifted later — by up to its slack, in
  // days — without delaying the critical path. An over-allocated resource-month where every contributing
  // task is already on the critical path (slack 0) is flagged NO_SLACK: genuinely unresolvable without
  // accepting a project delay. Project-scoped (unlike the tenant-wide resourceCapacity) because slack is a
  // property of THIS project's own schedule. Read-only/detective — suggests, never moves anything; a
  // project with no over-allocated resource carries empty over_allocations/suggestions/unresolvable.
  async resourceLeveling(code: string, _user: JwtUser) {
    const db = this.db;
    const p = await this.ports.row(code);
    const sched = await this.ports.schedule(code);
    const slackByTask = new Map<number, number>(sched.tasks.map((t: any) => [t.id, Number(t.slack) || 0]));
    const taskById = new Map<number, any>(sched.tasks.map((t: any) => [t.id, t]));

    const assignments = (await db.select().from(projectResources).where(eq(projectResources.projectId, Number(p.id))))
      .filter((r: any) => r.taskId != null)
      .map((r: any) => {
        const t = taskById.get(Number(r.taskId));
        return { ...r, effStart: r.periodStart ?? t?.planned_start ?? null, effEnd: r.periodEnd ?? t?.planned_end ?? null };
      });

    const calendarRows = await db.select().from(resourceCalendar);
    const availByResMonth = new Map<string, number>();
    for (const c of calendarRows) availByResMonth.set(`${c.resourceName}|${String(c.month).slice(0, 7)}`, n(c.availablePct));

    const activeIn = (ps: string | null, pe: string | null, month: string) => {
      const mStart = `${month}-01`, mEnd = `${month}-31`;
      return (ps == null || ps <= mEnd) && (pe == null || pe >= mStart);
    };
    const months = new Set<string>();
    for (const r of assignments) {
      if (r.effStart) months.add(String(r.effStart).slice(0, 7));
      if (r.effEnd) months.add(String(r.effEnd).slice(0, 7));
    }

    const byResMonth = new Map<string, { alloc: number; contributors: { taskId: number; allocPct: number }[] }>();
    for (const month of months) {
      for (const r of assignments) {
        if (!activeIn(r.effStart, r.effEnd, month)) continue;
        const key = `${r.resourceName}|${month}`;
        const bucket = byResMonth.get(key) ?? { alloc: 0, contributors: [] };
        bucket.alloc = r2(bucket.alloc + n(r.allocPct));
        bucket.contributors.push({ taskId: Number(r.taskId), allocPct: n(r.allocPct) });
        byResMonth.set(key, bucket);
      }
    }

    const overAllocations: any[] = [], suggestions: any[] = [], unresolvable: any[] = [];
    for (const [key, bucket] of byResMonth) {
      const [resourceName, month] = key.split('|');
      const available = availByResMonth.get(key) ?? 100;
      if (bucket.alloc <= available) continue;
      overAllocations.push({ resource_name: resourceName, month, allocated_pct: r2(bucket.alloc), available_pct: available, over_by_pct: r2(bucket.alloc - available) });
      const candidates = bucket.contributors
        .map((c) => ({ ...c, slack: slackByTask.get(c.taskId) ?? 0, task: taskById.get(c.taskId) }))
        .filter((c) => c.slack > 0)
        .sort((a, b) => b.slack - a.slack);
      const top = candidates[0];
      if (!top) { unresolvable.push({ resource_name: resourceName, month, reason: 'NO_SLACK' }); continue; }
      const newStart = top.task?.planned_start ? addDays(top.task.planned_start, top.slack) : null;
      suggestions.push({
        resource_name: resourceName, month, task_id: top.taskId, task_name: top.task?.name ?? null,
        alloc_pct: top.allocPct, slack_days: top.slack, suggested_shift_days: top.slack,
        shifted_to_month: newStart ? newStart.slice(0, 7) : null,
      });
    }
    return {
      project_code: code,
      over_allocations: overAllocations.sort((a, b) => a.month.localeCompare(b.month) || a.resource_name.localeCompare(b.resource_name)),
      suggestions: suggestions.sort((a, b) => a.month.localeCompare(b.month)),
      unresolvable: unresolvable.sort((a, b) => a.month.localeCompare(b.month)),
      over_allocated_count: overAllocations.length,
    };
  }

  // Portfolio command center (A1): an executive cross-project rollup — EVM totals, project-health buckets,
  // status + financial totals, the at-risk list, resource capacity, and the pipeline→delivery funnel. Also
  // backs the schedulable `project_evm` BI report. Read-only — rides evm() / resourceUtilization() / crm.
  async portfolioEvm(user: JwtUser) {
    const db = this.db;
    const list = await this.ports.list(user);
    const rows: any[] = [];
    let bac = 0, ev = 0, ac = 0, eac = 0, contract = 0, billed = 0, wip = 0, margin = 0, costToDate = 0;
    const status_counts: Record<string, number> = {};
    const health = { on_track: 0, at_risk: 0, no_data: 0 };
    for (const p of list.projects) {
      const e = await this.ports.evm(p.project_code);
      const hasData = e.cpi != null || e.spi != null;
      const risky = (e.cpi != null && e.cpi < 0.9) || (e.spi != null && e.spi < 0.9);
      if (!hasData) health.no_data++; else if (risky) health.at_risk++; else health.on_track++;
      rows.push({ project_code: p.project_code, name: p.name, status: p.status, customer_name: p.customer_name, billing_type: p.billing_type, cpi: e.cpi, spi: e.spi, bac: e.bac, ev: e.ev, ac: e.ac, eac: e.eac, wip: p.wip, margin: p.margin, on_track: hasData && !risky });
      bac = r2(bac + e.bac); ev = r2(ev + e.ev); ac = r2(ac + e.ac); eac = r2(eac + e.eac);
      contract = r2(contract + n(p.contract_amount)); billed = r2(billed + n(p.billed_to_date)); wip = r2(wip + n(p.wip)); margin = r2(margin + n(p.margin)); costToDate = r2(costToDate + n(p.cost_to_date));
      status_counts[p.status] = (status_counts[p.status] ?? 0) + 1;
    }
    const at_risk = rows
      .filter((r) => (r.cpi != null && r.cpi < 0.9) || (r.spi != null && r.spi < 0.9))
      .map((r) => ({ project_code: r.project_code, name: r.name, cpi: r.cpi, spi: r.spi }))
      .sort((a, b) => (a.cpi ?? 9) - (b.cpi ?? 9));
    const cap = await this.ports.resourceUtilization(user);
    // Pipeline → delivery funnel: open + won opportunities (crm), and projects originated from a won deal.
    const OPEN = ['prospecting', 'qualification', 'proposal', 'negotiation'];
    const opps = await db.select().from(crmOpportunities);
    let open_count = 0, open_amount = 0, won_count = 0, won_amount = 0;
    for (const o of opps) {
      const amt = n(o.amount);
      if (OPEN.includes(o.stage)) { open_count++; open_amount = r2(open_amount + amt); }
      else if (o.stage === 'won') { won_count++; won_amount = r2(won_amount + amt); }
    }
    const converted_count = list.projects.filter((p: any) => p.crm_opp_no).length;
    return {
      as_of: ymd(), count: rows.length,
      status_counts,
      financials: { contract, billed, wip, margin, cost_to_date: costToDate },
      totals: { bac, ev, ac, eac, cpi: ac > 0 ? r4(ev / ac) : null },
      health,
      capacity: { over_allocated_count: cap.over_allocated_count, top: cap.utilization.slice(0, 5) },
      funnel: { open_count, open_amount, won_count, won_amount, converted_count },
      at_risk, projects: rows,
    };
  }

  // ── Action center / exception inbox (PMO-1, PROJ-11) ─────────────────────
  // One severity-ranked "what needs me now" worklist across all the caller's projects, assembled from the
  // signals the modules already produce — pure aggregation, posts nothing (detective control PROJ-11):
  //  • maker-checker queues awaiting a *different* approver: pending change orders, pending project timesheets;
  //  • risk governance: open HIGH risks with no mitigation plan (PROJ-08);
  //  • performance: red projects (CPI/SPI < 0.9) and over-budget projects;
  //  • schedule: milestones past their due date and not yet reached;
  //  • governance gaps: an Open project with no change-controlled baseline (PROJ-07) or a stale health
  //    snapshot (none in `stale_days`, default 14). Each item deep-links to the offending project tab.
  async actionCenter(user: JwtUser, dto?: { stale_days?: number }) {
    const db = this.db;
    const today = ymd();
    const staleDays = dto?.stale_days != null && Number(dto.stale_days) > 0 ? Math.floor(Number(dto.stale_days)) : 14;
    const staleCutoff = addDays(today, -staleDays);
    // Project universe the caller can see (RLS-scoped); everything below is bounded to this id set so the
    // cross-project queries never leak another tenant's rows.
    const pRows = await db.select().from(projects).orderBy(desc(projects.id)).limit(100);
    const codeById = new Map<number, string>(pRows.map((p: any) => [Number(p.id), p.projectCode]));
    const ids = new Set<number>(pRows.map((p: any) => Number(p.id)));
    const fmtByCode = new Map<string, any>((await this.ports.list(user)).projects.map((p: any) => [p.project_code, p]));

    const items: any[] = [];
    const SEV_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const push = (kind: string, severity: 'high' | 'medium' | 'low', projectId: number | null, code: string | null, titleTh: string, titleEn: string, ref: string | null, tab: string, meta: Record<string, any> = {}) => {
      items.push({ kind, severity, project_id: projectId, project_code: code, title_th: titleTh, title_en: titleEn, ref, href: code ? `/projects/${code}?tab=${tab}` : '/projects', as_of: today, meta });
    };

    // Per-project performance + governance signals.
    const baseRows = await db.select({ pid: projectBaselines.projectId }).from(projectBaselines).where(eq(projectBaselines.status, 'active'));
    const hasBaseline = new Set<number>(baseRows.map((b: any) => Number(b.pid)));
    const snapRows = await db.select({ pid: projectHealthSnapshots.projectId, last: sql<string>`max(${projectHealthSnapshots.snapshotDate})` }).from(projectHealthSnapshots).groupBy(projectHealthSnapshots.projectId);
    const lastSnap = new Map<number, string>(snapRows.map((s: any) => [Number(s.pid), s.last]));
    for (const p of pRows) {
      const pid = Number(p.id); const code = p.projectCode;
      const f = fmtByCode.get(code);
      if (f?.over_budget) push('over_budget', 'high', pid, code, `เกินงบประมาณ (${f.budget_used_pct}%)`, `Over budget (${f.budget_used_pct}%)`, `${f.budget_used_pct}%`, 'costs', { budget_used_pct: f.budget_used_pct, budget_variance: f.budget_variance });
      const e = await this.ports.evm(code);
      const isRed = (e.cpi != null && e.cpi < 0.9) || (e.spi != null && e.spi < 0.9);
      if (isRed) push('project_red', 'high', pid, code, `สุขภาพโครงการแดง (CPI ${e.cpi ?? '—'} / SPI ${e.spi ?? '—'})`, `Project health red (CPI ${e.cpi ?? '—'} / SPI ${e.spi ?? '—'})`, `CPI ${e.cpi ?? '—'}`, 'overview', { cpi: e.cpi, spi: e.spi });
      // Earned-schedule slip (PROJ-19): late in a project the classic SPI (EV/PV) converges to 1 even when
      // delivery is late — the time-based SPI(t) keeps degrading, so it catches slips the PV-based red check
      // above no longer sees. Suppressed when the project already reads red (no duplicate worklist item).
      if (!isRed) {
        const esm = await this.ports.earnedSchedule(code).catch(() => null);
        if (esm?.spi_t != null && esm.spi_t < 0.9)
          push('schedule_slip_es', 'medium', pid, code, `เวลาหลุดแผนตาม Earned Schedule (SPI(t) ${esm.spi_t})`, `Schedule slipping by earned schedule (SPI(t) ${esm.spi_t})`, `SPI(t) ${esm.spi_t}`, 'overview', { spi_t: esm.spi_t, sv_t_months: esm.sv_t_months, spi: e.spi });
      }
      const inFlight = p.status !== 'Closed'; // an in-flight (Open/Active) project should be baselined + tracked
      if (inFlight && !hasBaseline.has(pid)) push('no_baseline', 'medium', pid, code, 'ยังไม่มีเส้นฐาน (baseline)', 'No change-controlled baseline', null, 'overview', {});
      const ls = lastSnap.get(pid);
      if (inFlight && (!ls || ls < staleCutoff)) push('stale_health', 'low', pid, code, ls ? `สุขภาพล่าสุด ${ls} (เก่ากว่า ${staleDays} วัน)` : 'ยังไม่เคยบันทึกสุขภาพ', ls ? `Last health ${ls} (older than ${staleDays}d)` : 'No health snapshot captured', ls ?? null, 'overview', { last_snapshot: ls ?? null, stale_days: staleDays });
    }

    // Pending change orders awaiting a different approver (maker-checker, PROJ-10).
    const coRows = await db.select().from(projectChangeOrders).where(eq(projectChangeOrders.status, 'pending'));
    for (const c of coRows) {
      const pid = Number(c.projectId); if (!ids.has(pid)) continue;
      const code = codeById.get(pid) ?? null;
      push('change_order_pending', 'medium', pid, code, `ใบสั่งเปลี่ยนแปลงรออนุมัติ (${c.coNo})`, `Change order awaiting approval (${c.coNo})`, c.coNo, 'overview', { co_no: c.coNo, requested_by: c.requestedBy, contract_delta: n(c.contractDelta) });
    }

    // Over-budget material requisitions awaiting an authoriser (maker-checker, PROJ-13 — M2).
    const pmrRows = await db.select().from(projectMaterialRequisitions).where(eq(projectMaterialRequisitions.status, 'pending'));
    for (const m of pmrRows) {
      const pid = Number(m.projectId); if (!ids.has(pid)) continue;
      const code = codeById.get(pid) ?? null;
      push('pmr_over_budget', 'high', pid, code, `ใบขอเบิกวัสดุเกินงบรออนุมัติ (${m.pmrNo})`, `Over-budget material requisition awaiting approval (${m.pmrNo})`, m.pmrNo, 'boq', { pmr_no: m.pmrNo, requested_by: m.requestedBy, over_amount: n(m.overAmount) });
    }

    // Aging stock reservations still 'held' past the stale window (docs/50 Wave 1 A2) — surfaced BEFORE
    // the scheduled `reservation_stale_release` sweep reaps them, so a planner consumes or releases deliberately.
    const resRows = await db.select().from(stockReservations)
      .where(and(eq(stockReservations.status, 'held'), sql`${stockReservations.createdAt} < ${new Date(Date.now() - staleDays * 86400_000)}`));
    for (const rr of resRows) {
      const pid = Number(rr.projectId); if (!ids.has(pid)) continue;
      const code = codeById.get(pid) ?? null;
      push('reservation_stale', 'low', pid, code, `การจองสต๊อกค้างเกิน ${staleDays} วัน (${rr.itemId} × ${n(rr.qtyReserved)})`, `Stock reservation held longer than ${staleDays}d (${rr.itemId} × ${n(rr.qtyReserved)})`, String(rr.id), 'reservations', { reservation_id: Number(rr.id), item_id: rr.itemId, qty: n(rr.qtyReserved), created_at: rr.createdAt });
    }

    // Pending project timesheets awaiting independent approval (maker-checker labor, PROJ-04).
    const tsRows = await db.select().from(timesheets).where(eq(timesheets.status, 'Pending'));
    const tsByProject = new Map<number, number>();
    for (const t of tsRows) {
      const pid = t.projectId != null ? Number(t.projectId) : null;
      if (pid == null || !ids.has(pid)) continue;
      tsByProject.set(pid, (tsByProject.get(pid) ?? 0) + 1);
    }
    for (const [pid, count] of tsByProject) {
      const code = codeById.get(pid) ?? null;
      push('timesheet_pending', 'medium', pid, code, `ใบลงเวลารออนุมัติ (${count})`, `Project timesheets awaiting approval (${count})`, String(count), 'costs', { count });
    }

    // Milestones past due and not yet reached (schedule slip).
    const msRows = await db.select().from(projectMilestones).where(eq(projectMilestones.status, 'pending'));
    for (const m of msRows) {
      const pid = Number(m.projectId); if (!ids.has(pid)) continue;
      if (!m.dueDate || String(m.dueDate) >= today) continue;
      const code = codeById.get(pid) ?? null;
      push('milestone_slipping', 'medium', pid, code, `หมุดหมายเลยกำหนด: ${m.name} (${m.dueDate})`, `Milestone overdue: ${m.name} (${m.dueDate})`, m.dueDate, 'milestones', { milestone: m.name, due_date: m.dueDate });
    }

    // Open HIGH risks with no mitigation plan (PROJ-08) — reuse the portfolio top-risk roll-up.
    const risks = await this.ports.topRisks(user);
    for (const r of risks.top) {
      if (r.rag !== 'red' || r.mitigation) continue;
      push('risk_unmitigated_high', 'high', r.project_id ?? null, r.project_code ?? null, `ความเสี่ยงสูงยังไม่มีแผนรับมือ: ${r.title}`, `Unmitigated high risk: ${r.title}`, r.title, 'risks', { risk_id: r.id, score: r.score });
    }

    // Retention release tranches whose due date has passed (docs/35 Depth-1) — the withheld retention is now
    // collectible (customer) / payable (subcontractor) and should be released. Bounded to the caller's projects.
    if (this.retention) {
      const due = await this.retention.due(today).catch(() => null);
      for (const d of due?.due ?? []) {
        const pid = d.project_id != null ? Number(d.project_id) : null;
        if (pid == null || !ids.has(pid)) continue;
        const code = codeById.get(pid) ?? null;
        const th = d.party_type === 'subcontractor' ? 'เงินประกันผลงานผู้รับเหมาช่วงถึงกำหนดคืน' : 'เงินประกันผลงานลูกค้าถึงกำหนดคืน';
        const en = d.party_type === 'subcontractor' ? 'Subcontractor retention due for release' : 'Customer retention due for release';
        push('retention_due', 'medium', pid, code, `${th} (${d.source_doc_no}, ${n(d.amount)})`, `${en} (${d.source_doc_no}, ${n(d.amount)})`, d.source_doc_no, 'billing', { tranche_id: d.tranche_id, retention_id: d.retention_id, amount: n(d.amount), due_date: d.due_date, party_type: d.party_type });
      }
    }

    items.sort((a, b) => (SEV_RANK[a.severity]! - SEV_RANK[b.severity]!) || String(a.project_code ?? '').localeCompare(String(b.project_code ?? '')) || a.kind.localeCompare(b.kind));
    const by_kind: Record<string, number> = {};
    for (const it of items) by_kind[it.kind] = (by_kind[it.kind] ?? 0) + 1;
    const summary = {
      total: items.length,
      high: items.filter((i) => i.severity === 'high').length,
      medium: items.filter((i) => i.severity === 'medium').length,
      low: items.filter((i) => i.severity === 'low').length,
      by_kind,
    };
    return { as_of: today, stale_days: staleDays, summary, items };
  }

  // ── Forward resource & cash forecast (PMO-2) ─────────────────────────────
  // Makes the capacity calendar forward-looking: committed capacity demand per month, alongside a
  // BILLINGS/CASH forecast that overlays committed contractual billing with the probability-weighted pipeline —
  // "if we win the deals in the pipeline, when does the cash land (and where are we already over-allocated)?".
  // Read-only — rides PROJ-05 (resource governance) / PROJ-06 (EVM). Sources, all already in the system:
  //  • committed billing = Fixed-price pending MILESTONES with a billing_percent, dated in-horizon (× contract),
  //    plus each POC project's earned-but-unbilled contract asset (expected to invoice in the first month);
  //  • weighted pipeline = each OPEN opportunity's amount × probability%, placed at its expected close month;
  //  • committed demand = the resource capacity calendar's per-month allocation roll-up.
  async forecast(user: JwtUser, dto?: { months?: number; from?: string; rev_per_fte_month?: number }) {
    const db = this.db;
    const months = Math.max(1, Math.min(24, Math.round(dto?.months ?? 6)));
    const start = (dto?.from && /^\d{4}-\d{2}$/.test(dto.from)) ? dto.from : ymd().slice(0, 7);
    // Configurable value→FTE rate: the revenue one full-time-equivalent delivers per month — used to turn the
    // probability-weighted pipeline VALUE into projected resourcing DEMAND (FTE) so the forecast shows not just
    // "when does cash land" but "how many people would winning the pipeline need". Default if unset/invalid.
    const revPerFte = dto?.rev_per_fte_month != null && Number(dto.rev_per_fte_month) > 0 ? r2(dto.rev_per_fte_month) : DEFAULT_REV_PER_FTE_MONTH;
    const cap = await this.ports.resourceCapacity(user, { months, from: start });
    const horizon: string[] = cap.horizon;
    const hset = new Set(horizon);
    const firstMonth = horizon[0];

    // Committed contractual billing per month.
    const committedBill = new Map<string, number>(horizon.map((m) => [m, 0]));
    const projRows = await db.select().from(projects).orderBy(desc(projects.id)).limit(200);
    const pById = new Map<number, any>(projRows.map((p: any) => [Number(p.id), p]));
    const ms = await db.select().from(projectMilestones).where(eq(projectMilestones.status, 'pending'));
    for (const m of ms) {
      if (m.billingPercent == null || !m.dueDate) continue;
      const mo = String(m.dueDate).slice(0, 7);
      if (!hset.has(mo)) continue;
      const proj = pById.get(Number(m.projectId)); if (!proj) continue;
      const bill = r2(n(proj.contractAmount) * n(m.billingPercent) / 100);
      if (bill > 0) committedBill.set(mo, r2((committedBill.get(mo) ?? 0) + bill));
    }
    // POC earned-but-unbilled (contract asset) is billable now → place in the first horizon month.
    let pocAsset = 0;
    for (const f of (await this.ports.list(user)).projects) if (f.rev_method === 'poc' && (f.contract_asset ?? 0) > 0) pocAsset = r2(pocAsset + (f.contract_asset ?? 0));
    if (pocAsset > 0) committedBill.set(firstMonth!, r2((committedBill.get(firstMonth!) ?? 0) + pocAsset));

    // Probability-weighted pipeline per month (expected close).
    const weightedPipe = new Map<string, number>(horizon.map((m) => [m, 0]));
    const OPEN = ['prospecting', 'qualification', 'proposal', 'negotiation'];
    const opps = await db.select().from(crmOpportunities);
    let openCount = 0, openAmount = 0, weightedForecast = 0;
    for (const o of opps) {
      if (!OPEN.includes(o.stage)) continue;
      openCount++; openAmount = r2(openAmount + n(o.amount));
      const w = r2(n(o.amount) * Number(o.probability ?? 0) / 100);
      weightedForecast = r2(weightedForecast + w);
      const mo = o.expectedCloseDate ? String(o.expectedCloseDate).slice(0, 7) : null;
      if (mo && hset.has(mo)) weightedPipe.set(mo, r2((weightedPipe.get(mo) ?? 0) + w));
    }

    const billingMonthly = horizon.map((month) => {
      const committed = r2(committedBill.get(month) ?? 0);
      const weighted = r2(weightedPipe.get(month) ?? 0);
      return { month, committed_billing: committed, weighted_pipeline: weighted, total_expected: r2(committed + weighted) };
    });
    const committedTotal = r2(billingMonthly.reduce((s, m) => s + m.committed_billing, 0));
    const weightedTotal = r2(billingMonthly.reduce((s, m) => s + m.weighted_pipeline, 0));
    // Resourcing demand per month: committed (today's allocation, % → FTE) + the pipeline's projected FTE draw
    // (weighted pipeline value that month / rev_per_fte_month). total = committed + pipeline.
    const resourcingMonthly = cap.monthly.map((m: any) => {
      const committedFte = r2(m.total_demand_pct / 100);
      const pipelineFte = r2((weightedPipe.get(m.month) ?? 0) / revPerFte);
      return { month: m.month, committed_demand_pct: m.total_demand_pct, resources_over: m.resources_over, committed_demand_fte: committedFte, pipeline_demand_fte: pipelineFte, total_demand_fte: r2(committedFte + pipelineFte) };
    });
    const peakDemand = resourcingMonthly.reduce((mx: number, m: any) => Math.max(mx, m.committed_demand_pct), 0);
    const peakTotalFte = resourcingMonthly.reduce((mx: number, m: any) => Math.max(mx, m.total_demand_fte), 0);
    const pipelineFteTotal = r2(resourcingMonthly.reduce((s: number, m: any) => s + m.pipeline_demand_fte, 0));

    return {
      from: start, months, horizon, rev_per_fte_month: revPerFte,
      resourcing: { monthly: resourcingMonthly, over_allocated_count: cap.over_allocated_count, peak_demand_pct: r2(peakDemand), peak_total_demand_fte: r2(peakTotalFte), pipeline_demand_fte_total: pipelineFteTotal },
      billing: { monthly: billingMonthly, committed_total: committedTotal, weighted_pipeline_total: weightedTotal, expected_total: r2(committedTotal + weightedTotal) },
      pipeline: { open_count: openCount, open_amount: openAmount, weighted_forecast: weightedForecast },
    };
  }

  // ── Period governance / status pack (PMO-3) ──────────────────────────────
  // Assembles the recurring PMO status report so it isn't hand-built each period. For ONE project it returns
  // the full pack — header + EVM + the health-snapshot **trend** (PPM-4) + baseline variance (PROJ-07) +
  // open-HIGH risks (PROJ-08) + milestone status + the change-order log (PROJ-10); for the PORTFOLIO it
  // returns a RAG-ranked status row per project plus a roll-up. Read-only/detective — rides PROJ-06; also a
  // schedulable BI report type (`project_governance_pack`).
  async governancePack(user: JwtUser, opts?: { code?: string; period?: string }) {
    const period = opts?.period && /^\d{4}-\d{2}$/.test(opts.period) ? opts.period : ymd().slice(0, 7);
    if (opts?.code) return { scope: 'project', as_of: ymd(), period, project: await this.projectPack(opts.code, period, user) };
    const today = ymd();
    const ragRank: Record<string, number> = { red: 0, amber: 1, no_data: 2, green: 3 };
    const list = await this.ports.list(user);
    const rows: any[] = [];
    const sum = { red: 0, amber: 0, green: 0, no_data: 0, unmitigated_high: 0, open_high_risks: 0, overdue_milestones: 0, pending_change_orders: 0 };
    for (const f of list.projects) {
      const code = f.project_code;
      const e = await this.ports.evm(code);
      const rag = this.ports.ragOf(e.cpi, e.spi);
      sum[rag as 'red' | 'amber' | 'green' | 'no_data']++;
      const risks = await this.ports.listRisks(code);
      const ms = await this.ports.listMilestones(code);
      const overdue = ms.milestones.filter((m: any) => m.status === 'pending' && m.due_date && String(m.due_date) < today).length;
      const co = await this.ports.listChangeOrders(code);
      sum.unmitigated_high += risks.summary.unmitigated_high; sum.open_high_risks += risks.summary.high_open;
      sum.overdue_milestones += overdue; sum.pending_change_orders += co.summary.pending;
      rows.push({ project_code: code, name: f.name, status: f.status, rag, cpi: e.cpi, spi: e.spi, margin: f.margin, wip: f.wip,
        open_high_risks: risks.summary.high_open, unmitigated_high: risks.summary.unmitigated_high, overdue_milestones: overdue, pending_change_orders: co.summary.pending });
    }
    rows.sort((a, b) => (ragRank[a.rag]! - ragRank[b.rag]!) || String(a.project_code).localeCompare(String(b.project_code)));
    return { scope: 'portfolio', as_of: today, period, count: rows.length, summary: sum, projects: rows };
  }

  private async projectPack(code: string, period: string, user: JwtUser) {
    const today = ymd();
    const detail = await this.ports.get(code);
    const e = await this.ports.evm(code);
    const health = (await this.ports.healthHistory(code)).history;
    const baseline = await this.ports.getBaseline(code, user);
    const risks = await this.ports.listRisks(code);
    const ms = await this.ports.listMilestones(code);
    const co = await this.ports.listChangeOrders(code);
    // A5 (docs/50 Wave 5) — the material lens: per-BoQ-category EVM incl. material CPI + wasted value.
    const mat = await this.ports.evmByCategory(code);
    return {
      project_code: code, name: detail.name, status: detail.status, customer_name: detail.customer_name, period,
      rag: this.ports.ragOf(e.cpi, e.spi), pct_complete: detail.pct_complete,
      contract_amount: detail.contract_amount, billed_to_date: detail.billed_to_date, wip: detail.wip, margin: detail.margin,
      evm: { cpi: e.cpi, spi: e.spi, bac: e.bac, ev: e.ev, ac: e.ac, eac: e.eac, cost_variance: e.cost_variance, schedule_variance: e.schedule_variance },
      material: mat.boq ? { material_cpi: mat.material_cpi, totals: mat.totals, categories: mat.categories } : null,
      health_trend: health,
      baseline: { active: baseline.baseline, variance: baseline.variance },
      risks: { summary: risks.summary, open_high: risks.risks.filter((r: any) => r.rag === 'red' && r.status !== 'closed') },
      milestones: {
        count: ms.count,
        overdue: ms.milestones.filter((m: any) => m.status === 'pending' && m.due_date && String(m.due_date) < today),
        reached: ms.milestones.filter((m: any) => m.status === 'reached').length,
        list: ms.milestones,
      },
      change_orders: { summary: co.summary, list: co.change_orders },
    };
  }
}
