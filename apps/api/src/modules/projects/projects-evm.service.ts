import { BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { projects, projectTasks, projectEntries, projectBaselines, projectHealthSnapshots } from '../../database/schema';
import { n, fx, ymd } from '../../database/queries';
import { r2, r4, clampPct, addDays, peopleCsv, csvToList } from './projects.helpers';
import { shapeTask, shapeBaseline, shapeHealth } from './projects.shapes';
import type { JwtUser } from '../../common/decorators';
import type { ProjectsWbsService } from './projects-wbs.service';
import type { BaselineDto, ProgramDto } from './projects.service';

// EVM sub-service (docs/38 §3 projects decomposition, PR-4 — PROJ-06/07, the final prescribed cut):
// earned value, CPM schedule, programs, baselines and health snapshots, moved VERBATIM. A PLAIN class
// constructed in the ProjectsService ctor BODY (positional-goldenmaster constraint) from the injected db,
// the wbs sub-service (taskRollup), and four callback ports back to the facade: rowOf/getOf (project
// resolution), fmtOf (the shared project formatter) and emit (the live action bus wrapper).
export class ProjectsEvmService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly wbs: ProjectsWbsService,
    private readonly rowOf: (code: string) => Promise<any>,
    private readonly getOf: (code: string) => Promise<any>,
    private readonly fmtOf: (p: any, nonBillable?: number) => any,
    private readonly emit: (tenantId: number | null | undefined, kind: string, severity: string, projectCode: string, extra?: Record<string, any>) => void,
  ) {}

  async evm(code: string, asOf?: string) {
    const db = this.db;
    const p = await this.rowOf(code);
    const tasks = (await db.select().from(projectTasks).where(eq(projectTasks.projectId, Number(p.id)))).filter((t: any) => t.status !== 'cancelled');
    const today = asOf ?? ymd();
    let bac = 0, ev = 0, pv = 0;
    for (const t of tasks) {
      const pc = n(t.plannedCost);
      bac = r2(bac + pc);
      ev = r2(ev + pc * clampPct(t.pctComplete) / 100);
      // Planned value = budgeted cost of work scheduled by `as_of` (a task with no planned_end counts as scheduled).
      if (!t.plannedEnd || t.plannedEnd <= today) pv = r2(pv + pc);
    }
    // Fall back to the project budget as the baseline when no task planned cost is set.
    if (bac === 0) { bac = n(p.budgetAmount); pv = bac; }
    // Actual cost incurred = recoverable WIP cost (cost_to_date) + non-billable (the project's total actual cost).
    const nbRows = await db.select({ v: sql<string>`coalesce(sum(${projectEntries.amount}),0)` }).from(projectEntries)
      .where(and(eq(projectEntries.projectId, Number(p.id)), eq(projectEntries.billable, false)));
    const ac = r2(n(p.costToDate) + n(nbRows[0]?.v));
    const cpi = ac > 0 ? r4(ev / ac) : null;        // >1 under cost, <1 over cost
    const spi = pv > 0 ? r4(ev / pv) : null;        // >1 ahead of schedule, <1 behind
    const eac = cpi && cpi > 0 ? r2(ac + (bac - ev) / cpi) : r2(ac + (bac - ev)); // estimate at completion
    return {
      project_code: code, as_of: today, bac, pv, ev, ac,
      cost_variance: r2(ev - ac), schedule_variance: r2(ev - pv),
      cpi, spi, eac, etc: r2(eac - ac), task_count: tasks.length,
    };
  }

  // Critical-path schedule (CPM) over the WBS: a forward pass (early start/finish) + backward pass (late
  // start/finish) on the finish-to-start `depends_on` graph, with each task's duration in days (explicit
  // planned_start→planned_end span, else planned_hours/8, min 1). Tasks with zero slack are on the critical
  // path. Cancelled tasks are excluded; a dependency cycle degrades gracefully (the back-edge is ignored).
  async schedule(code: string) {
    const db = this.db;
    const p = await this.rowOf(code);
    const rows = (await db.select().from(projectTasks).where(eq(projectTasks.projectId, Number(p.id)))).filter((t: any) => t.status !== 'cancelled');
    const tasks = rows.map(shapeTask);
    const byId = new Map<number, any>(tasks.map((t: any) => [t.id, t]));
    const dur = (t: any) => {
      if (t.planned_start && t.planned_end) return Math.max(1, Math.round((Date.parse(t.planned_end) - Date.parse(t.planned_start)) / 86400000) + 1);
      return Math.max(1, Math.ceil(n(t.planned_hours) / 8) || 1);
    };
    // Predecessors restricted to known tasks; build successor adjacency.
    const preds = new Map<number, number[]>(tasks.map((t: any) => [t.id, (t.depends_on || []).filter((d: number) => byId.has(d) && d !== t.id)]));
    const succ = new Map<number, number[]>(tasks.map((t: any) => [t.id, []]));
    for (const t of tasks) for (const d of preds.get(t.id)!) succ.get(d)!.push(t.id);
    // Topological order (Kahn); any nodes left in a cycle are appended so the passes still terminate.
    const indeg = new Map<number, number>(tasks.map((t: any) => [t.id, preds.get(t.id)!.length]));
    const queue = tasks.filter((t: any) => indeg.get(t.id) === 0).map((t: any) => t.id);
    const topo: number[] = [];
    while (queue.length) {
      const id = queue.shift()!; topo.push(id);
      for (const s of succ.get(id)!) { indeg.set(s, indeg.get(s)! - 1); if (indeg.get(s) === 0) queue.push(s); }
    }
    for (const t of tasks) if (!topo.includes(t.id)) topo.push(t.id);
    const es = new Map<number, number>(), ef = new Map<number, number>();
    for (const id of topo) {
      const start = Math.max(0, ...preds.get(id)!.map((d) => ef.get(d) ?? 0));
      es.set(id, start); ef.set(id, start + dur(byId.get(id)));
    }
    const projectDuration = Math.max(0, ...tasks.map((t: any) => ef.get(t.id) ?? 0));
    const lf = new Map<number, number>(), ls = new Map<number, number>();
    for (const id of [...topo].reverse()) {
      const succs = succ.get(id)!;
      const finish = succs.length ? Math.min(...succs.map((s) => ls.get(s)!)) : projectDuration;
      lf.set(id, finish); ls.set(id, finish - dur(byId.get(id)));
    }
    const out = tasks.map((t: any) => {
      const slack = r2((ls.get(t.id) ?? 0) - (es.get(t.id) ?? 0));
      return { ...t, duration_days: dur(t), es: es.get(t.id) ?? 0, ef: ef.get(t.id) ?? 0, ls: ls.get(t.id) ?? 0, lf: lf.get(t.id) ?? 0, slack, on_critical_path: slack <= 0.0001 };
    });
    return {
      project_code: code, project_duration_days: projectDuration,
      critical_path: out.filter((t: any) => t.on_critical_path).map((t: any) => t.id),
      tasks: out, count: out.length,
    };
  }

  // ── Program (cross-project) critical path (PMO-4) ────────────────────────
  // Group a project into a program + declare which OTHER projects it must follow (finish-to-start). The
  // member projects + those dependencies form a higher-level graph whose nodes are whole projects (node
  // duration = each project's OWN critical-path duration from schedule()); a forward/backward CPM pass over
  // it gives the PROGRAM critical path, end date, and per-project slack — so a delay that ripples ACROSS
  // projects is visible, not just within one. Detective/non-posting (rides PROJ-06).
  async setProgram(code: string, dto: ProgramDto, user: JwtUser) {
    const db = this.db;
    const p = await this.rowOf(code);
    const set: any = {};
    if (dto.program_code !== undefined) set.programCode = (dto.program_code ?? '').toString().trim() || null;
    if (dto.depends_on_projects !== undefined) {
      const deps = peopleCsv(dto.depends_on_projects); // trim + dedupe project codes (null when empty)
      if (deps) {
        const list = csvToList(deps);
        if (list.includes(code)) throw new BadRequestException({ code: 'BAD_DEPENDENCY', message: 'A project cannot depend on itself', messageTh: 'โครงการขึ้นกับตัวเองไม่ได้' });
        for (const c of list) {
          const [exists] = await db.select().from(projects).where(eq(projects.projectCode, c)).limit(1);
          if (!exists) throw new BadRequestException({ code: 'DEP_PROJECT_NOT_FOUND', message: `Dependency project ${c} not found`, messageTh: `ไม่พบโครงการที่อ้างอิง (${c})` });
        }
      }
      set.dependsOnProjects = deps;
    }
    await db.update(projects).set(set).where(eq(projects.id, Number(p.id)));
    return this.getOf(code);
  }

  async programCriticalPath(programCode: string, _user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(projects).where(eq(projects.programCode, programCode));
    if (!rows.length) throw new NotFoundException({ code: 'PROGRAM_NOT_FOUND', message: `No projects in program ${programCode}`, messageTh: 'ไม่พบโปรแกรม' });
    const members = new Set<string>(rows.map((p: any) => p.projectCode));
    // node duration = each project's own critical-path duration (≥1 so a plan-less project still occupies a day).
    const nodes: { code: string; name: string; status: string; duration: number; preds: string[] }[] = [];
    for (const p of rows) {
      const sched = await this.schedule(p.projectCode);
      const preds = csvToList(p.dependsOnProjects).filter((c) => members.has(c) && c !== p.projectCode);
      nodes.push({ code: p.projectCode, name: p.name, status: p.status, duration: Math.max(1, sched.project_duration_days || 0), preds });
    }
    const byCode = new Map(nodes.map((n) => [n.code, n]));
    const succ = new Map<string, string[]>(nodes.map((n) => [n.code, []]));
    for (const n of nodes) for (const d of n.preds) succ.get(d)!.push(n.code);
    // Topological order (Kahn); cycle-trapped nodes are appended so the passes still terminate.
    const indeg = new Map<string, number>(nodes.map((n) => [n.code, n.preds.length]));
    const queue = nodes.filter((n) => indeg.get(n.code) === 0).map((n) => n.code);
    const topo: string[] = [];
    while (queue.length) { const c = queue.shift()!; topo.push(c); for (const s of succ.get(c)!) { indeg.set(s, indeg.get(s)! - 1); if (indeg.get(s) === 0) queue.push(s); } }
    for (const n of nodes) if (!topo.includes(n.code)) topo.push(n.code);
    const es = new Map<string, number>(), ef = new Map<string, number>();
    for (const c of topo) { const start = Math.max(0, ...byCode.get(c)!.preds.map((d) => ef.get(d) ?? 0)); es.set(c, start); ef.set(c, start + byCode.get(c)!.duration); }
    const programDuration = Math.max(0, ...nodes.map((n) => ef.get(n.code) ?? 0));
    const lf = new Map<string, number>(), ls = new Map<string, number>();
    for (const c of [...topo].reverse()) { const ss = succ.get(c)!; const finish = ss.length ? Math.min(...ss.map((s) => ls.get(s)!)) : programDuration; lf.set(c, finish); ls.set(c, finish - byCode.get(c)!.duration); }
    const out = nodes.map((n) => {
      const slack = r2((ls.get(n.code) ?? 0) - (es.get(n.code) ?? 0));
      return { project_code: n.code, name: n.name, status: n.status, duration_days: n.duration, depends_on: n.preds, es: es.get(n.code) ?? 0, ef: ef.get(n.code) ?? 0, ls: ls.get(n.code) ?? 0, lf: lf.get(n.code) ?? 0, slack, on_critical_path: slack <= 0.0001 };
    }).sort((a, b) => a.es - b.es || a.project_code.localeCompare(b.project_code));
    return { program_code: programCode, project_count: out.length, program_duration_days: programDuration, critical_path: out.filter((p) => p.on_critical_path).map((p) => p.project_code), projects: out };
  }

  async programs(user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(projects).where(sql`${projects.programCode} is not null`);
    const byProg = new Map<string, number>();
    for (const p of rows) { const k = p.programCode as string; if (!k) continue; byProg.set(k, (byProg.get(k) ?? 0) + 1); }
    const out: any[] = [];
    for (const program_code of [...byProg.keys()].sort()) {
      const cp = await this.programCriticalPath(program_code, user);
      out.push({ program_code, member_count: byProg.get(program_code), program_duration_days: cp.program_duration_days, critical_path: cp.critical_path });
    }
    return { programs: out, count: out.length };
  }

  // EVM S-curve: the planned-cost baseline accumulated by month (each task's planned cost lands in its
  // planned_end month), with the current EV/AC/PV snapshot overlaid — the classic planned-vs-actual S-curve.
  async evmSeries(code: string, dto?: { months?: number; as_of?: string }) {
    const db = this.db;
    const p = await this.rowOf(code);
    const tasks = (await db.select().from(projectTasks).where(eq(projectTasks.projectId, Number(p.id)))).filter((t: any) => t.status !== 'cancelled');
    const buckets = new Map<string, number>();
    for (const t of tasks) {
      const m = t.plannedEnd ? String(t.plannedEnd).slice(0, 7) : (p.startDate ? String(p.startDate).slice(0, 7) : ymd().slice(0, 7));
      buckets.set(m, r2((buckets.get(m) ?? 0) + n(t.plannedCost)));
    }
    let cumulative = 0;
    const series = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, planned]) => {
      cumulative = r2(cumulative + planned);
      return { month, planned_cost: planned, cumulative_planned: cumulative };
    });
    const current = await this.evm(code, dto?.as_of);
    return { project_code: code, series, current, bac: current.bac };
  }

  ragOf(cpi: number | null, spi: number | null): string {
    if (cpi == null && spi == null) return 'no_data';
    if ((cpi != null && cpi < 0.9) || (spi != null && spi < 0.9)) return 'red';
    if ((cpi != null && cpi < 1) || (spi != null && spi < 1)) return 'amber';
    return 'green';
  }

  // ── Baselines & variance (B1, PROJ-07) ───────────────────────────────────
  // Current planned BAC (Σ non-cancelled task planned cost; falls back to the project budget) + critical-path
  // duration — the figures a baseline snapshots and the current plan is compared against.
  private async currentPlan(code: string, p: any) {
    const db = this.db;
    const tasks = (await db.select().from(projectTasks).where(eq(projectTasks.projectId, Number(p.id)))).filter((t: any) => t.status !== 'cancelled');
    let bac = r2(tasks.reduce((s: number, t: any) => s + n(t.plannedCost), 0));
    if (bac === 0) bac = n(p.budgetAmount);
    const sched = await this.schedule(code);
    return { bac, duration_days: sched.project_duration_days };
  }

  // Capture a baseline. The FIRST baseline is free; **re-baselining requires a reason** (BASELINE_REASON_REQUIRED)
  // and supersedes the prior active baseline (history preserved) — a project can't silently move its goalposts.
  async captureBaseline(code: string, dto: BaselineDto, user: JwtUser) {
    const db = this.db;
    const p = await this.rowOf(code);
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    const plan = await this.currentPlan(code, p);
    const [active] = await db.select().from(projectBaselines).where(and(eq(projectBaselines.projectId, Number(p.id)), eq(projectBaselines.status, 'active'))).limit(1);
    if (active && !dto.reason) throw new BadRequestException({ code: 'BASELINE_REASON_REQUIRED', message: 'Re-baselining requires a reason', messageTh: 'การตั้งเส้นฐานใหม่ต้องระบุเหตุผล' });
    if (active) await db.update(projectBaselines).set({ status: 'superseded' }).where(eq(projectBaselines.id, Number(active.id)));
    await db.insert(projectBaselines).values({
      projectId: Number(p.id), tenantId, label: dto.label ?? (active ? 'Re-baseline' : 'Baseline'),
      baselineBac: fx(plan.bac, 2), baselineDurationDays: plan.duration_days, baselineEnd: p.endDate ?? null,
      reason: dto.reason ?? null, status: 'active', createdBy: user.username,
    });
    return this.getBaseline(code, user);
  }

  // The active baseline + the current plan + variance (scope/cost creep) + the full baseline history.
  async getBaseline(code: string, _user: JwtUser) {
    const db = this.db;
    const p = await this.rowOf(code);
    const all = await db.select().from(projectBaselines).where(eq(projectBaselines.projectId, Number(p.id))).orderBy(desc(projectBaselines.id));
    const active = all.find((b: any) => b.status === 'active') ?? null;
    const plan = await this.currentPlan(code, p);
    const variance = active ? {
      bac_delta: r2(plan.bac - n(active.baselineBac)),
      bac_pct: n(active.baselineBac) > 0 ? r2(((plan.bac - n(active.baselineBac)) / n(active.baselineBac)) * 100) : null,
      duration_delta: plan.duration_days - Number(active.baselineDurationDays),
    } : null;
    return { project_code: code, baseline: active ? shapeBaseline(active) : null, current: plan, variance, history: all.map(shapeBaseline) };
  }

  // ── Project health history (PPM upgrade) ─────────────────────────────────
  // Capture a dated EVM/RAG snapshot for ONE project, so the live point-in-time EVM gains a trajectory. RAG:
  // red if CPI or SPI < 0.9, amber if either < 1, green if both ≥ 1, no_data if neither is computable.
  // Idempotent per (project, date) — re-capturing the same day refreshes the row.
  async captureHealth(code: string, dto: { as_of?: string }, user: JwtUser) {
    const db = this.db;
    const p = await this.rowOf(code);
    return this.snapProject(p, dto?.as_of ?? ymd(), user);
  }

  // Capture a snapshot for EVERY project for the caller's tenant — the scheduled (BI action job) path.
  async captureAllHealth(user: JwtUser) {
    const db = this.db;
    const date = ymd();
    const rows = await db.select().from(projects).orderBy(desc(projects.id)).limit(500);
    let captured = 0;
    for (const p of rows) { await this.snapProject(p, date, user); captured++; }
    return { as_of: date, scanned: rows.length, captured };
  }

  // Compute + upsert one project's health snapshot for a date.
  private async snapProject(p: any, date: string, user: JwtUser) {
    const db = this.db;
    const e = await this.evm(p.projectCode, date);
    const f = this.fmtOf(p);
    const tasks = await db.select().from(projectTasks).where(eq(projectTasks.projectId, Number(p.id)));
    const pct = this.wbs.taskRollup(tasks);
    const rag = (e.cpi == null && e.spi == null) ? 'no_data'
      : ((e.cpi != null && e.cpi < 0.9) || (e.spi != null && e.spi < 0.9)) ? 'red'
      : ((e.cpi != null && e.cpi < 1) || (e.spi != null && e.spi < 1)) ? 'amber' : 'green';
    const row = {
      tenantId: p.tenantId ?? user.tenantId ?? null, snapshotDate: date, rag,
      cpi: e.cpi != null ? fx(e.cpi, 4) : null, spi: e.spi != null ? fx(e.spi, 4) : null,
      pctComplete: fx(pct, 2), bac: fx(e.bac, 2), ev: fx(e.ev, 2), ac: fx(e.ac, 2), eac: fx(e.eac, 2),
      margin: fx(f.margin, 2), wip: fx(f.wip, 2), createdBy: user.username,
    };
    await db.insert(projectHealthSnapshots).values({ projectId: Number(p.id), ...row })
      .onConflictDoUpdate({ target: [projectHealthSnapshots.projectId, projectHealthSnapshots.snapshotDate], set: { ...row, createdAt: new Date() } });
    // PMO-1: a red snapshot proactively wakes the action center rather than waiting for someone to look.
    if (rag === 'red') this.emit(p.tenantId ?? user.tenantId ?? null, 'project_red', 'high', p.projectCode, { cpi: e.cpi, spi: e.spi, snapshot_date: date });
    return { project_code: p.projectCode, snapshot_date: date, rag, cpi: e.cpi, spi: e.spi, margin: f.margin };
  }

  // The dated health trajectory for a project (ascending) — feeds a CPI/SPI/RAG trend chart.
  async healthHistory(code: string) {
    const db = this.db;
    const p = await this.rowOf(code);
    const rows = await db.select().from(projectHealthSnapshots).where(eq(projectHealthSnapshots.projectId, Number(p.id))).orderBy(projectHealthSnapshots.snapshotDate);
    return { project_code: code, history: rows.map(shapeHealth), count: rows.length };
  }
}
