import { eq, desc, sql } from 'drizzle-orm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DrizzleDb } from '../../database/database.module';
import { projectTasks, projectMilestones, projectTemplates, projectTemplateItems } from '../../database/schema';
import { ymd, n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { depsCsv, addDays } from './projects.helpers';
import { shapeTemplateItem } from './projects.shapes';
import type { TemplateDto, ApplyTemplateDto } from './projects.service';

// Project templates sub-service (PPM B2) — a PLAIN class built in the ProjectsService ctor body (not a DI
// provider), extracted from the facade in the docs/46 Phase-4 projects round. Reusable WBS/milestone
// scaffolds: authoring, listing, and the two-pass apply (tasks first to map seq→id, then parent/dependency
// wiring; milestones dated off the same start).
export class ProjectsTemplatesService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly rowOf: (code: string) => Promise<any>,
    // Apply returns the refreshed task list through the WBS sub-service via the facade delegator.
    private readonly listTasksFn: (code: string) => Promise<any>,
  ) {}

  // Create a reusable WBS/milestone scaffold. Items default their seq to declaration order (1-based) so a
  // template can omit explicit seqs; parent_seq / depends_on_seq reference those ordinals.
  async createTemplate(dto: TemplateDto, user: JwtUser) {
    const db = this.db;
    const code = dto.code?.trim() || `TPL${String(Date.now()).slice(-6)}`;
    const [existing] = await db.select().from(projectTemplates).where(eq(projectTemplates.code, code)).limit(1);
    if (existing) throw new BadRequestException({ code: 'TEMPLATE_EXISTS', message: `Template ${code} already exists`, messageTh: 'รหัสแม่แบบซ้ำ' });
    const tenantId = user.tenantId ?? null;
    const [tpl] = await db.insert(projectTemplates).values({
      tenantId, code, name: dto.name, description: dto.description ?? null, status: 'active', createdBy: user.username,
    }).returning({ id: projectTemplates.id });
    const items = dto.items ?? [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await db.insert(projectTemplateItems).values({
        templateId: Number(tpl!.id), tenantId, itemType: it!.item_type ?? 'task', seq: it!.seq ?? i + 1, name: it!.name,
        parentSeq: it!.parent_seq ?? null, wbsCode: it!.wbs_code ?? null,
        plannedHours: fx(it!.planned_hours ?? 0, 2), plannedCost: fx(it!.planned_cost ?? 0, 2),
        offsetStartDays: Math.round(n(it!.offset_start_days)), offsetEndDays: Math.round(n(it!.offset_end_days)),
        dependsOnSeq: depsCsv(it!.depends_on_seq),
        billingPercent: it!.billing_percent != null ? fx(it!.billing_percent, 2) : null,
        owner: it!.owner ?? null, assignee: it!.assignee ?? null,
      });
    }
    return this.getTemplate(code);
  }

  async listTemplates(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(projectTemplates).orderBy(desc(projectTemplates.id)).limit(200);
    const counts = await db.select({ tid: projectTemplateItems.templateId, c: sql<string>`count(*)` }).from(projectTemplateItems).groupBy(projectTemplateItems.templateId);
    const cBy = new Map<number, number>(counts.map((x: any) => [Number(x.tid), Number(x.c)]));
    return { templates: rows.map((t: any) => ({ id: Number(t.id), code: t.code, name: t.name, description: t.description, status: t.status, item_count: cBy.get(Number(t.id)) ?? 0, created_at: t.createdAt })), count: rows.length };
  }

  async getTemplate(code: string) {
    const db = this.db;
    const [tpl] = await db.select().from(projectTemplates).where(eq(projectTemplates.code, code)).limit(1);
    if (!tpl) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: `Template ${code} not found`, messageTh: 'ไม่พบแม่แบบ' });
    const items = await db.select().from(projectTemplateItems).where(eq(projectTemplateItems.templateId, Number(tpl.id))).orderBy(projectTemplateItems.seq);
    return {
      id: Number(tpl.id), code: tpl.code, name: tpl.name, description: tpl.description, status: tpl.status, created_at: tpl.createdAt,
      items: items.map(shapeTemplateItem), count: items.length,
    };
  }

  // Apply a template to a project: scaffold its task + milestone items in one step, dated relative to the
  // project start (the project's start_date, an explicit start_date override, or today). Tasks are created
  // first to map seq→id, then a second pass wires parent_id and depends_on; milestones are dated off the same
  // start. Idempotent-ish guard: refuses if the project already has tasks (so re-apply can't duplicate a WBS).
  async applyTemplate(code: string, tplCode: string, dto: ApplyTemplateDto, user: JwtUser) {
    const db = this.db;
    const p = await this.rowOf(code);
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    const [tpl] = await db.select().from(projectTemplates).where(eq(projectTemplates.code, tplCode)).limit(1);
    if (!tpl) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: `Template ${tplCode} not found`, messageTh: 'ไม่พบแม่แบบ' });
    const existing = await db.select({ id: projectTasks.id }).from(projectTasks).where(eq(projectTasks.projectId, Number(p.id))).limit(1);
    if (existing.length) throw new BadRequestException({ code: 'PROJECT_HAS_TASKS', message: 'Apply a template only to a project with no tasks yet', messageTh: 'ใช้แม่แบบได้เฉพาะโครงการที่ยังไม่มีงาน' });
    const items = await db.select().from(projectTemplateItems).where(eq(projectTemplateItems.templateId, Number(tpl.id))).orderBy(projectTemplateItems.seq);
    const start = dto.start_date ?? p.startDate ?? ymd();

    const taskItems = items.filter((it: any) => (it.itemType ?? 'task') !== 'milestone');
    const seqToId = new Map<number, number>();
    // Pass 1 — insert tasks, capturing seq→new id.
    for (const it of taskItems) {
      const [t] = await db.insert(projectTasks).values({
        projectId: Number(p.id), tenantId, parentId: null, wbsCode: it.wbsCode ?? null, name: it.name, status: 'open',
        plannedStart: addDays(start, n(it.offsetStartDays)), plannedEnd: addDays(start, n(it.offsetEndDays)),
        plannedHours: fx(n(it.plannedHours), 2), plannedCost: fx(n(it.plannedCost), 2), pctComplete: fx(0, 2),
        dependsOn: null, assignee: it.assignee ?? null, createdBy: user.username,
      }).returning({ id: projectTasks.id });
      seqToId.set(Number(it.seq), Number(t!.id));
    }
    // Pass 2 — wire parent_id + depends_on now that every seq has a real id.
    for (const it of taskItems) {
      const id = seqToId.get(Number(it.seq));
      if (id == null) continue;
      const set: any = {};
      if (it.parentSeq != null && seqToId.has(Number(it.parentSeq))) set.parentId = seqToId.get(Number(it.parentSeq));
      const deps = (it.dependsOnSeq ? String(it.dependsOnSeq).split(',') : [])
        .map((s: string) => seqToId.get(Number(s))).filter((x: any) => x != null);
      if (deps.length) set.dependsOn = deps.join(',');
      if (Object.keys(set).length) await db.update(projectTasks).set(set).where(eq(projectTasks.id, id));
    }
    // Milestones — dated off the same start (offset_end_days = due offset).
    const msItems = items.filter((it: any) => (it.itemType ?? 'task') === 'milestone');
    for (const it of msItems) {
      await db.insert(projectMilestones).values({
        projectId: Number(p.id), tenantId, name: it.name, dueDate: addDays(start, n(it.offsetEndDays)), owner: it.owner ?? null,
        status: 'pending', billingPercent: it.billingPercent != null ? fx(n(it.billingPercent), 2) : null, createdBy: user.username,
      });
    }
    return { ...(await this.listTasksFn(code)), template: tplCode, tasks_created: taskItems.length, milestones_created: msItems.length, start_date: start };
  }
}
