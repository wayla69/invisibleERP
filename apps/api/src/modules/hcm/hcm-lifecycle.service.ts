import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, asc, sql, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { employees, onboardingTemplates, onboardingTemplateTasks, employeeLifecycle, employeeLifecycleTasks } from '../../database/schema';
import { StatusLogService } from '../../common/status-log.service';
import { isUniqueViolation } from '../../common/db-error';
import type { JwtUser } from '../../common/decorators';

export interface TemplateDto { code: string; name: string; kind?: 'onboarding' | 'offboarding'; active?: boolean }
export interface TemplateTaskDto { title: string; seq?: number; owner_role?: string; category?: string; is_access_revocation?: boolean }
export interface StartDto { emp_code: string; template_id: number }
export interface PatchTaskDto { status: 'done' | 'skipped'; notes?: string; reason?: string }

const CATEGORIES = ['it_access', 'payroll', 'equipment', 'docs', 'training'];

// HR-5 (docs/42) — employee onboarding / offboarding lifecycle (joiner-mover-leaver). Reads gate
// hr/hr_admin/exec; writes hr/hr_admin. The HR-05 control lives in `complete`: an offboarding lifecycle
// cannot be marked complete while any is_access_revocation task is still pending
// (ACCESS_REVOCATION_INCOMPLETE). Skipping an access-revocation task needs hr_admin/exec + a reason and is
// audit-logged on the doc status log. `offboardingExceptions` is a detective read of open offboardings
// with unrevoked access past N days.
@Injectable()
export class HcmLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly statusLog: StatusLogService,
  ) {}

  private isHrAdmin(user: JwtUser): boolean {
    return user.role === 'Admin' || (user.permissions ?? []).some((p) => p === 'hr_admin' || p === 'exec');
  }

  // ── Templates ──────────────────────────────────────────────────────────────
  async listTemplates(kind: string | undefined, user: JwtUser) {
    const rows = await this.db.select().from(onboardingTemplates).orderBy(onboardingTemplates.code);
    const filtered = kind ? rows.filter((r) => r.kind === kind) : rows;
    const ids = filtered.map((r) => Number(r.id));
    const tasks = ids.length
      ? await this.db.select().from(onboardingTemplateTasks).where(inArray(onboardingTemplateTasks.templateId, ids)).orderBy(asc(onboardingTemplateTasks.seq))
      : [];
    const tasksByTpl = new Map<number, typeof tasks>();
    for (const tk of tasks) {
      const arr = tasksByTpl.get(Number(tk.templateId)) ?? [];
      arr.push(tk);
      tasksByTpl.set(Number(tk.templateId), arr);
    }
    return {
      templates: filtered.map((r) => ({
        id: Number(r.id), code: r.code, name: r.name, kind: r.kind, active: r.active !== false,
        tasks: (tasksByTpl.get(Number(r.id)) ?? []).map((tk) => ({
          id: Number(tk.id), seq: Number(tk.seq ?? 0), title: tk.title, owner_role: tk.ownerRole ?? null,
          category: tk.category, is_access_revocation: tk.isAccessRevocation === true,
        })),
      })),
      count: filtered.length,
    };
  }

  async createTemplate(dto: TemplateDto, user: JwtUser) {
    const kind = dto.kind === 'offboarding' ? 'offboarding' : 'onboarding';
    try {
      const [row] = await this.db.insert(onboardingTemplates).values({
        tenantId: user.tenantId ?? null, code: dto.code, name: dto.name, kind, active: dto.active !== false,
      }).returning({ id: onboardingTemplates.id });
      return { id: Number(row!.id), code: dto.code, name: dto.name, kind };
    } catch (e) {
      if (isUniqueViolation(e))
        throw new BadRequestException({ code: 'TEMPLATE_EXISTS', message: `Template ${dto.code} already exists`, messageTh: 'รหัสเทมเพลตซ้ำ' });
      throw e;
    }
  }

  private async templateById(id: number) {
    const [t] = await this.db.select().from(onboardingTemplates).where(eq(onboardingTemplates.id, id)).limit(1);
    if (!t) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: `Template ${id} not found`, messageTh: 'ไม่พบเทมเพลต' });
    return t;
  }

  async addTemplateTask(templateId: number, dto: TemplateTaskDto, user: JwtUser) {
    const tpl = await this.templateById(templateId);
    const category = dto.category && CATEGORIES.includes(dto.category) ? dto.category : 'docs';
    const [{ maxSeq } = { maxSeq: 0 }] = await this.db.select({ maxSeq: sql<number>`coalesce(max(${onboardingTemplateTasks.seq}), 0)::int` })
      .from(onboardingTemplateTasks).where(eq(onboardingTemplateTasks.templateId, templateId));
    const seq = dto.seq != null ? Math.trunc(Number(dto.seq)) : Number(maxSeq) + 1;
    const [row] = await this.db.insert(onboardingTemplateTasks).values({
      tenantId: user.tenantId ?? null, templateId, seq, title: dto.title, ownerRole: dto.owner_role ?? null,
      category, isAccessRevocation: dto.is_access_revocation === true,
    }).returning({ id: onboardingTemplateTasks.id });
    return { id: Number(row!.id), template_id: templateId, template_code: tpl.code, seq, title: dto.title, category, is_access_revocation: dto.is_access_revocation === true };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async start(dto: StartDto, user: JwtUser) {
    const [emp] = await this.db.select().from(employees).where(eq(employees.empCode, dto.emp_code)).limit(1);
    if (!emp) throw new NotFoundException({ code: 'EMP_NOT_FOUND', message: `Employee ${dto.emp_code} not found`, messageTh: 'ไม่พบพนักงาน' });
    const tpl = await this.templateById(Number(dto.template_id));
    if (tpl.active === false) throw new BadRequestException({ code: 'TEMPLATE_INACTIVE', message: `Template ${tpl.code} is inactive`, messageTh: 'เทมเพลตถูกปิดใช้งาน' });
    const tplTasks = await this.db.select().from(onboardingTemplateTasks)
      .where(eq(onboardingTemplateTasks.templateId, Number(tpl.id))).orderBy(asc(onboardingTemplateTasks.seq));
    if (!tplTasks.length) throw new BadRequestException({ code: 'TEMPLATE_EMPTY', message: `Template ${tpl.code} has no tasks`, messageTh: 'เทมเพลตยังไม่มีงาน' });

    const [lc] = await this.db.insert(employeeLifecycle).values({
      tenantId: user.tenantId ?? null, empCode: dto.emp_code, templateId: Number(tpl.id), kind: tpl.kind,
      status: 'in_progress', startedBy: user.username,
    }).returning({ id: employeeLifecycle.id });
    const lifecycleId = Number(lc!.id);
    await this.db.insert(employeeLifecycleTasks).values(tplTasks.map((tk) => ({
      tenantId: user.tenantId ?? null, lifecycleId, seq: Number(tk.seq ?? 0), title: tk.title,
      category: tk.category, isAccessRevocation: tk.isAccessRevocation === true, status: 'pending' as const,
    })));
    return { id: lifecycleId, emp_code: dto.emp_code, template_code: tpl.code, kind: tpl.kind, status: 'in_progress', tasks_created: tplTasks.length };
  }

  async list(empCode: string | undefined, _user: JwtUser) {
    const q = this.db.select().from(employeeLifecycle);
    const rows = empCode ? await q.where(eq(employeeLifecycle.empCode, empCode)) : await q;
    const ids = rows.map((r) => Number(r.id));
    const tasks = ids.length
      ? await this.db.select().from(employeeLifecycleTasks).where(inArray(employeeLifecycleTasks.lifecycleId, ids)).orderBy(asc(employeeLifecycleTasks.seq))
      : [];
    const byLc = new Map<number, typeof tasks>();
    for (const tk of tasks) {
      const arr = byLc.get(Number(tk.lifecycleId)) ?? [];
      arr.push(tk);
      byLc.set(Number(tk.lifecycleId), arr);
    }
    return {
      lifecycles: rows.map((r) => {
        const lcTasks = byLc.get(Number(r.id)) ?? [];
        return {
          id: Number(r.id), emp_code: r.empCode, kind: r.kind, status: r.status,
          started_at: r.startedAt, completed_at: r.completedAt ?? null, started_by: r.startedBy ?? null,
          tasks_total: lcTasks.length, tasks_done: lcTasks.filter((t) => t.status === 'done').length,
          access_revocation_pending: lcTasks.filter((t) => t.isAccessRevocation === true && t.status === 'pending').length,
          tasks: lcTasks.map((tk) => ({
            id: Number(tk.id), seq: Number(tk.seq ?? 0), title: tk.title, category: tk.category,
            is_access_revocation: tk.isAccessRevocation === true, status: tk.status,
            done_by: tk.doneBy ?? null, done_at: tk.doneAt ?? null, notes: tk.notes ?? null,
          })),
        };
      }),
      count: rows.length,
    };
  }

  private async lifecycleOf(taskId: number) {
    const [tk] = await this.db.select().from(employeeLifecycleTasks).where(eq(employeeLifecycleTasks.id, taskId)).limit(1);
    if (!tk) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: `Task ${taskId} not found`, messageTh: 'ไม่พบงาน' });
    const [lc] = await this.db.select().from(employeeLifecycle).where(eq(employeeLifecycle.id, Number(tk.lifecycleId))).limit(1);
    return { tk, lc: lc! };
  }

  // Mark a lifecycle task done or skipped. Skipping an access-revocation task requires hr_admin/exec + a
  // reason and is audit-logged (HR-05 evidence — an access-removal step cannot be silently waived).
  async patchTask(taskId: number, dto: PatchTaskDto, user: JwtUser) {
    const { tk, lc } = await this.lifecycleOf(taskId);
    if (lc.status === 'complete') throw new BadRequestException({ code: 'LIFECYCLE_COMPLETE', message: 'Lifecycle already complete', messageTh: 'กระบวนการเสร็จสิ้นแล้ว' });
    const status = dto.status === 'skipped' ? 'skipped' : 'done';

    if (status === 'skipped' && tk.isAccessRevocation === true) {
      if (!this.isHrAdmin(user))
        throw new ForbiddenException({ code: 'SKIP_REQUIRES_HR_ADMIN', message: 'Skipping an access-revocation task requires hr_admin/exec', messageTh: 'การข้ามงานเพิกถอนสิทธิ์ต้องเป็น hr_admin/exec' });
      if (!dto.reason || !dto.reason.trim())
        throw new BadRequestException({ code: 'SKIP_REASON_REQUIRED', message: 'A reason is required to skip an access-revocation task', messageTh: 'ต้องระบุเหตุผลในการข้ามงานเพิกถอนสิทธิ์' });
      await this.statusLog.log('EMPLIFECYCLE', String(lc.id), 'pending', 'skipped', user.username,
        `ACCESS_REVOCATION_SKIP (HR-05): task#${taskId} "${tk.title}" — ${dto.reason.trim()}`);
    }

    await this.db.update(employeeLifecycleTasks)
      .set({ status, doneBy: user.username, doneAt: new Date(), notes: dto.reason?.trim() ?? dto.notes ?? tk.notes ?? null })
      .where(eq(employeeLifecycleTasks.id, taskId));
    return { id: taskId, lifecycle_id: Number(lc.id), status, is_access_revocation: tk.isAccessRevocation === true };
  }

  // Mark a lifecycle complete. HR-05: an OFFBOARDING lifecycle cannot complete while any access-revocation
  // task is still pending → ACCESS_REVOCATION_INCOMPLETE (the task must be done, or explicitly skipped with a
  // reason by hr_admin/exec via patchTask).
  async complete(lifecycleId: number, _user: JwtUser) {
    const [lc] = await this.db.select().from(employeeLifecycle).where(eq(employeeLifecycle.id, lifecycleId)).limit(1);
    if (!lc) throw new NotFoundException({ code: 'LIFECYCLE_NOT_FOUND', message: `Lifecycle ${lifecycleId} not found`, messageTh: 'ไม่พบกระบวนการ' });
    if (lc.status === 'complete') return { id: lifecycleId, status: 'complete', already: true };

    if (lc.kind === 'offboarding') {
      const [{ pending } = { pending: 0 }] = await this.db.select({ pending: sql<number>`count(*)::int` })
        .from(employeeLifecycleTasks)
        .where(and(eq(employeeLifecycleTasks.lifecycleId, lifecycleId), eq(employeeLifecycleTasks.isAccessRevocation, true), eq(employeeLifecycleTasks.status, 'pending')));
      if (Number(pending) > 0)
        throw new BadRequestException({
          code: 'ACCESS_REVOCATION_INCOMPLETE',
          message: `Cannot complete offboarding: ${pending} access-revocation task(s) still pending`,
          messageTh: 'ไม่สามารถปิดกระบวนการออกจากงานได้ ยังมีงานเพิกถอนสิทธิ์ค้างอยู่',
        });
    }

    await this.db.update(employeeLifecycle).set({ status: 'complete', completedAt: new Date() }).where(eq(employeeLifecycle.id, lifecycleId));
    return { id: lifecycleId, emp_code: lc.empCode, kind: lc.kind, status: 'complete' };
  }

  // HR-05 detective read — open (in_progress) offboardings whose access-revocation tasks are still pending
  // more than N days after start (default 7). Surfaces stale terminations where access has not been removed.
  async offboardingExceptions(days: number, _user: JwtUser) {
    const openOff = await this.db.select().from(employeeLifecycle)
      .where(and(eq(employeeLifecycle.kind, 'offboarding'), eq(employeeLifecycle.status, 'in_progress')));
    const ids = openOff.map((r) => Number(r.id));
    const tasks = ids.length
      ? await this.db.select().from(employeeLifecycleTasks)
          .where(and(inArray(employeeLifecycleTasks.lifecycleId, ids), eq(employeeLifecycleTasks.isAccessRevocation, true), eq(employeeLifecycleTasks.status, 'pending')))
      : [];
    const pendingByLc = new Map<number, typeof tasks>();
    for (const tk of tasks) {
      const arr = pendingByLc.get(Number(tk.lifecycleId)) ?? [];
      arr.push(tk);
      pendingByLc.set(Number(tk.lifecycleId), arr);
    }
    const now = Date.now();
    const threshold = Number.isFinite(days) && days >= 0 ? days : 7;
    const exceptions = openOff
      .filter((r) => (pendingByLc.get(Number(r.id)) ?? []).length > 0)
      .map((r) => {
        const startedMs = r.startedAt ? new Date(r.startedAt).getTime() : now;
        const daysOpen = Math.floor((now - startedMs) / 86_400_000);
        return {
          lifecycle_id: Number(r.id), emp_code: r.empCode, started_at: r.startedAt, started_by: r.startedBy ?? null,
          days_open: daysOpen, access_revocation_pending: (pendingByLc.get(Number(r.id)) ?? []).length,
          pending_tasks: (pendingByLc.get(Number(r.id)) ?? []).map((tk) => ({ id: Number(tk.id), title: tk.title, category: tk.category })),
        };
      })
      .filter((e) => e.days_open >= threshold)
      .sort((a, b) => b.days_open - a.days_open);
    return { threshold_days: threshold, exceptions, count: exceptions.length };
  }
}
