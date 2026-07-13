import { BadRequestException, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { projects, projectTasks, projectMilestones, timesheets, projectTaskDependencies } from '../../database/schema';
import { n, fx, ymd } from '../../database/queries';
import { r2, clampPct, depsCsv, peopleCsv, csvToList } from './projects.helpers';
import { shapeTask, shapeMilestone } from './projects.shapes';
import type { JwtUser } from '../../common/decorators';
import type { TaskDto, TaskPatchDto, MilestoneDto, TaskDependencyDto } from './projects.service';

// PPM-B1 (PROJ-21): validate a richer `dependencies` list (type/lag; `type` is a closed Zod enum, same
// precedent as `status`) and replace this task's edge-metadata rows in project_task_dependencies (successor
// = taskId). A plain `depends_on` (no `dependencies`) leaves no rows behind — schedule() then defaults every
// predecessor to FS/lag-0, the pre-PPM-B1 behaviour.
async function syncDependencies(db: DrizzleDb, projectId: number, tenantId: number | null, taskId: number, deps: TaskDependencyDto[], user: JwtUser) {
  for (const d of deps) {
    if (Number(d.task_id) === Number(taskId)) throw new BadRequestException({ code: 'BAD_DEPENDENCY', message: 'A task cannot depend on itself', messageTh: 'งานขึ้นกับตัวเองไม่ได้' });
  }
  await db.delete(projectTaskDependencies).where(eq(projectTaskDependencies.successorTaskId, Number(taskId)));
  if (deps.length) {
    await db.insert(projectTaskDependencies).values(deps.map((d) => ({
      tenantId, projectId, predecessorTaskId: Number(d.task_id), successorTaskId: Number(taskId),
      depType: d.type ?? 'FS', lagDays: Math.round(d.lag_days ?? 0), createdBy: user.username,
    })));
  }
}

// WBS sub-service (docs/38 §3 projects decomposition, PR-3): tasks, milestones and RACI, moved VERBATIM.
// A PLAIN class constructed in the ProjectsService constructor BODY (positional-goldenmaster constraint,
// docs/38 rev 0.6) from the injected db + two callback ports: `rowOf` (project-row resolver) and `billFn`
// (reachMilestone → bill — the one wbs→billing edge, kept as a port so wbs stays independent of costs).
export class ProjectsWbsService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly rowOf: (code: string) => Promise<any>,
    private readonly billFn: (code: string, dto: { percent?: number }, user: JwtUser) => Promise<any>,
  ) {}

  // ── WBS tasks (P1) ───────────────────────────────────────────────────────
  async addTask(code: string, dto: TaskDto, user: JwtUser) {
    const db = this.db;
    const p = await this.rowOf(code);
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    // PPM-B1 (PROJ-21): a richer `dependencies` list derives the plain depends_on CSV (read-compat, e.g. the
    // Gantt task table) — the join-table rows carrying type/lag are written after the task id is known.
    const dependsOnIds = dto.dependencies != null ? dto.dependencies.map((d) => Number(d.task_id)) : dto.depends_on;
    const [t] = await db.insert(projectTasks).values({
      projectId: Number(p.id), tenantId, parentId: dto.parent_id ?? null, wbsCode: dto.wbs_code ?? null, name: dto.name,
      status: dto.status ?? 'open', plannedStart: dto.planned_start ?? null, plannedEnd: dto.planned_end ?? null,
      plannedHours: fx(dto.planned_hours ?? 0, 2), plannedCost: fx(dto.planned_cost ?? 0, 2),
      pctComplete: fx(clampPct(dto.pct_complete ?? 0), 2), dependsOn: depsCsv(dependsOnIds),
      constraintType: dto.constraint_type ?? null, constraintOffsetDays: dto.constraint_offset_days ?? null, assignee: dto.assignee ?? null,
      accountable: dto.accountable ?? null, responsible: peopleCsv(dto.responsible) ?? null, consulted: peopleCsv(dto.consulted) ?? null, informed: peopleCsv(dto.informed) ?? null,
      createdBy: user.username,
    }).returning({ id: projectTasks.id });
    if (dto.dependencies != null) await syncDependencies(db, Number(p.id), tenantId, Number(t!.id), dto.dependencies, user);
    return this.listTasks(code);
  }

  async listTasks(code: string) {
    const db = this.db;
    const p = await this.rowOf(code);
    const rows = await db.select().from(projectTasks).where(eq(projectTasks.projectId, Number(p.id))).orderBy(projectTasks.id);
    return { project_code: code, pct_complete: this.taskRollup(rows), tasks: rows.map(shapeTask), count: rows.length };
  }

  async patchTask(taskId: number, dto: TaskPatchDto, user: JwtUser) {
    const db = this.db;
    const [t] = await db.select().from(projectTasks).where(eq(projectTasks.id, Number(taskId))).limit(1);
    if (!t) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: `Task ${taskId} not found`, messageTh: 'ไม่พบงาน' });
    const set: any = {};
    if (dto.name != null) set.name = dto.name;
    if (dto.status != null) set.status = dto.status;
    if (dto.planned_start != null) set.plannedStart = dto.planned_start;
    if (dto.planned_end != null) set.plannedEnd = dto.planned_end;
    if (dto.planned_hours != null) set.plannedHours = fx(dto.planned_hours, 2);
    if (dto.planned_cost != null) set.plannedCost = fx(dto.planned_cost, 2);
    if (dto.assignee != null) set.assignee = dto.assignee;
    if (dto.accountable != null) set.accountable = dto.accountable || null;
    if (dto.responsible != null) set.responsible = peopleCsv(dto.responsible);
    if (dto.consulted != null) set.consulted = peopleCsv(dto.consulted);
    if (dto.informed != null) set.informed = peopleCsv(dto.informed);
    // PPM-B1 (PROJ-21): `dependencies` (richer) replaces both the CSV and the join-table edges; plain
    // `depends_on` (no `dependencies`) replaces the CSV only and CLEARS any prior join-table rows for this
    // task, so every predecessor reverts to the FS/lag-0 default — a single call always fully determines the
    // predecessor set + edge metadata, never leaving a stale typed edge behind.
    if (dto.dependencies != null) {
      const ids = dto.dependencies.map((d) => Number(d.task_id));
      set.dependsOn = depsCsv(ids);
      await syncDependencies(db, Number(t.projectId), t.tenantId ?? null, Number(taskId), dto.dependencies, user);
    } else if (dto.depends_on != null) {
      if (dto.depends_on.some((d) => Number(d) === Number(taskId))) throw new BadRequestException({ code: 'BAD_DEPENDENCY', message: 'A task cannot depend on itself', messageTh: 'งานขึ้นกับตัวเองไม่ได้' });
      set.dependsOn = depsCsv(dto.depends_on);
      await db.delete(projectTaskDependencies).where(eq(projectTaskDependencies.successorTaskId, Number(taskId)));
    }
    if (dto.constraint_type !== undefined) set.constraintType = dto.constraint_type;
    if (dto.constraint_offset_days !== undefined) set.constraintOffsetDays = dto.constraint_offset_days;
    // Marking a task done implies 100% complete unless an explicit pct is given.
    if (dto.pct_complete != null) set.pctComplete = fx(clampPct(dto.pct_complete), 2);
    else if (dto.status === 'done') set.pctComplete = fx(100, 2);
    await db.update(projectTasks).set(set).where(eq(projectTasks.id, Number(taskId)));
    const [proj] = await db.select().from(projects).where(eq(projects.id, Number(t.projectId))).limit(1);
    return this.listTasks(proj!.projectCode);
  }

  // Project overall % complete = planned-hours-weighted mean of task pct (simple mean if no planned hours).
  // Cancelled tasks are excluded from the roll-up.
  taskRollup(rows: any[]) {
    const active = rows.filter((t) => t.status !== 'cancelled');
    if (!active.length) return 0;
    const totalH = active.reduce((s, t) => s + n(t.plannedHours), 0);
    if (totalH > 0) return clampPct(active.reduce((s, t) => s + n(t.plannedHours) * n(t.pctComplete), 0) / totalH);
    return clampPct(active.reduce((s, t) => s + n(t.pctComplete), 0) / active.length);
  }

  // ── RACI accountability (B3) ─────────────────────────────────────────────
  // "My tasks": the caller's still-open tasks across every project where they are the accountable owner or a
  // responsible doer (matched on username). The personal work-queue that the RACI roles drive.
  async myTasks(user: JwtUser) {
    const db = this.db;
    const me = String(user.username ?? '').trim();
    const rows = (await db.select().from(projectTasks).where(sql`${projectTasks.status} not in ('done','cancelled')`)).map(shapeTask);
    const projRows = await db.select().from(projects);
    const pById = new Map<number, any>(projRows.map((p: any) => [Number(p.id), p]));
    const mine = rows
      .filter((t: any) => me && (String(t.accountable ?? '').trim() === me || t.responsible.includes(me)))
      .map((t: any) => {
        const p = pById.get(t.project_id);
        return { ...t, project_code: p?.projectCode ?? null, project_name: p?.name ?? null, my_role: String(t.accountable ?? '').trim() === me ? 'accountable' : 'responsible' };
      })
      .sort((a: any, b: any) => String(a.planned_end ?? '9999-12-31').localeCompare(String(b.planned_end ?? '9999-12-31')));
    return { user: me, tasks: mine, count: mine.length };
  }

  // The project's RACI accountability matrix: per-task A/R/C/I, a per-person role rollup, and the tasks that
  // lack a single accountable owner (an accountability gap). SoD note: the accountable owner should not be the
  // same person who later approves the task's cost/timesheet — surfaced here, enforced by the cost maker-checker.
  async raci(code: string) {
    const db = this.db;
    const p = await this.rowOf(code);
    const rows = (await db.select().from(projectTasks).where(eq(projectTasks.projectId, Number(p.id))).orderBy(projectTasks.id)).map(shapeTask);
    const active = rows.filter((t: any) => t.status !== 'cancelled');
    const people = new Map<string, { accountable: number; responsible: number; consulted: number; informed: number }>();
    const bump = (name: string, key: 'accountable' | 'responsible' | 'consulted' | 'informed') => {
      const k = String(name).trim(); if (!k) return;
      const e = people.get(k) ?? { accountable: 0, responsible: 0, consulted: 0, informed: 0 };
      e[key]++; people.set(k, e);
    };
    for (const t of active) {
      if (t.accountable) bump(t.accountable, 'accountable');
      for (const r of t.responsible) bump(r, 'responsible');
      for (const c of t.consulted) bump(c, 'consulted');
      for (const i of t.informed) bump(i, 'informed');
    }
    const missing_accountable = active.filter((t: any) => !t.accountable).map((t: any) => t.id);
    return {
      project_code: code,
      tasks: active.map((t: any) => ({ id: t.id, name: t.name, accountable: t.accountable, responsible: t.responsible, consulted: t.consulted, informed: t.informed })),
      people: [...people.entries()].map(([name, c]) => ({ name, ...c })).sort((a, b) => (b.accountable + b.responsible) - (a.accountable + a.responsible)),
      missing_accountable, complete: missing_accountable.length === 0, count: active.length,
    };
  }

  // ── Milestones (P1) ──────────────────────────────────────────────────────
  async addMilestone(code: string, dto: MilestoneDto, user: JwtUser) {
    const db = this.db;
    const p = await this.rowOf(code);
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    if (dto.billing_percent != null && (dto.billing_percent <= 0 || dto.billing_percent > 100))
      throw new BadRequestException({ code: 'BAD_PERCENT', message: 'billing_percent must be within (0,100]', messageTh: 'เปอร์เซ็นต์ต้องอยู่ระหว่าง 0-100' });
    await db.insert(projectMilestones).values({
      projectId: Number(p.id), tenantId, name: dto.name, dueDate: dto.due_date ?? null, owner: dto.owner ?? null,
      status: 'pending', billingPercent: dto.billing_percent != null ? fx(dto.billing_percent, 2) : null, createdBy: user.username,
    });
    return this.listMilestones(code);
  }

  async listMilestones(code: string) {
    const db = this.db;
    const p = await this.rowOf(code);
    const rows = await db.select().from(projectMilestones).where(eq(projectMilestones.projectId, Number(p.id))).orderBy(projectMilestones.id);
    return { project_code: code, milestones: rows.map(shapeMilestone), count: rows.length };
  }

  // Mark a milestone reached. If it carries a billing_percent, the same act raises the Fixed-price progress
  // bill through the EXISTING authorized PRJ-BILL path (revenue recognition + WIP relief, contract cap) — PROJ-02.
  async reachMilestone(milestoneId: number, user: JwtUser) {
    const db = this.db;
    const [m] = await db.select().from(projectMilestones).where(eq(projectMilestones.id, Number(milestoneId))).limit(1);
    if (!m) throw new NotFoundException({ code: 'MILESTONE_NOT_FOUND', message: `Milestone ${milestoneId} not found`, messageTh: 'ไม่พบหมุดหมาย' });
    if (m.status === 'reached') throw new BadRequestException({ code: 'MILESTONE_REACHED', message: 'Milestone already reached', messageTh: 'หมุดหมายถูกบรรลุแล้ว' });
    const [proj] = await db.select().from(projects).where(eq(projects.id, Number(m.projectId))).limit(1);
    await db.update(projectMilestones).set({ status: 'reached', reachedAt: new Date() }).where(eq(projectMilestones.id, Number(milestoneId)));
    let billing: any = null;
    if (m.billingPercent != null && n(m.billingPercent) > 0) billing = await this.billFn(proj!.projectCode, { percent: n(m.billingPercent) }, user);
    return { milestone_id: Number(milestoneId), project_code: proj!.projectCode, status: 'reached', billing };
  }
}
