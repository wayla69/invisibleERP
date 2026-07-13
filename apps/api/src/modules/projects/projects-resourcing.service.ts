import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { projects, projectTasks, projectResources, resourceRates, resourceSkills, resourceCalendar, timesheets, crmOpportunities } from '../../database/schema';
import { BadRequestException } from '@nestjs/common';
import { n, fx, ymd } from '../../database/queries';
import { r2, DEFAULT_REV_PER_FTE_MONTH } from './projects.helpers';
import { shapeResource } from './projects.shapes';
import type { JwtUser } from '../../common/decorators';
import type { RateCardDto, ResourceDto, ResourceSkillDto, ResourceCalendarDto } from './projects.service';

// Resourcing sub-service (docs/38 §3 projects decomposition, PR-2 — PROJ-05): rate cards, assignment,
// utilization and forward capacity, moved VERBATIM. A PLAIN class constructed in the ProjectsService
// constructor BODY (not a DI param): the goldenmaster harness builds `new ProjectsService(db, ledger)`
// positionally with no optionals, so the facade materializes this itself from the injected db + a `rowOf`
// project-row resolver callback (the only cross-context need).
export class ProjectsResourcingService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly rowOf: (code: string) => Promise<any>,
  ) {}

  // ── Resource rate card (P2) ──────────────────────────────────────────────
  async addRateCard(dto: RateCardDto, user: JwtUser) {
    const db = this.db;
    await db.insert(resourceRates).values({
      tenantId: user.tenantId ?? null, role: dto.role, costRate: fx(dto.cost_rate ?? 0, 2), billRate: fx(dto.bill_rate ?? 0, 2),
      effectiveFrom: dto.effective_from ?? ymd(), effectiveTo: dto.effective_to ?? null, createdBy: user.username,
    });
    return this.listRateCards(user);
  }

  async listRateCards(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(resourceRates).orderBy(desc(resourceRates.id)).limit(300);
    return { rate_cards: rows.map((r: any) => ({ id: Number(r.id), role: r.role, cost_rate: n(r.costRate), bill_rate: n(r.billRate), effective_from: r.effectiveFrom, effective_to: r.effectiveTo })), count: rows.length };
  }

  // Resolve the rate-card rates applicable to a role on a date: the latest effective_from that is on/before the
  // date and whose effective_to is empty or on/after it. Returns zeros if the role has no rate card.
  private async resolveRate(role: string | undefined, onDate: string, user: JwtUser) {
    if (!role) return { costRate: 0, billRate: 0 };
    const db = this.db;
    const conds = [eq(resourceRates.role, role)];
    if (user.tenantId != null) conds.push(eq(resourceRates.tenantId, user.tenantId));
    const rows = await db.select().from(resourceRates).where(and(...conds));
    const applicable = rows
      .filter((r: any) => (!r.effectiveFrom || r.effectiveFrom <= onDate) && (!r.effectiveTo || r.effectiveTo >= onDate))
      .sort((a: any, b: any) => String(b.effectiveFrom ?? '').localeCompare(String(a.effectiveFrom ?? '')));
    const r = applicable[0];
    return { costRate: r ? n(r.costRate) : 0, billRate: r ? n(r.billRate) : 0 };
  }

  // ── Project resource assignment + capacity (P2) ──────────────────────────
  async assignResource(code: string, dto: ResourceDto, user: JwtUser) {
    const db = this.db;
    const p = await this.rowOf(code);
    const alloc = r2(dto.alloc_pct ?? 100);
    if (alloc <= 0 || alloc > 100) throw new BadRequestException({ code: 'BAD_ALLOC', message: 'alloc_pct must be within (0,100]', messageTh: 'สัดส่วนการจัดสรรต้องอยู่ระหว่าง 0-100' });
    const start = dto.period_start ?? ymd();
    const rate = await this.resolveRate(dto.role, start, user);
    await db.insert(projectResources).values({
      projectId: Number(p.id), tenantId: p.tenantId ?? user.tenantId ?? null, taskId: dto.task_id ?? null,
      resourceName: dto.resource_name, role: dto.role ?? null, allocPct: fx(alloc, 2), periodStart: start, periodEnd: dto.period_end ?? null,
      costRate: fx(rate.costRate, 2), billRate: fx(rate.billRate, 2), createdBy: user.username,
    });
    return this.listResources(code);
  }

  async listResources(code: string) {
    const db = this.db;
    const p = await this.rowOf(code);
    const rows = await db.select().from(projectResources).where(eq(projectResources.projectId, Number(p.id))).orderBy(projectResources.id);
    return { project_code: code, resources: rows.map(shapeResource), count: rows.length };
  }

  // Capacity/utilization (PROJ-05): total allocation per named resource across all of the caller's projects;
  // >100% flags over-allocation (a resource booked beyond capacity).
  async resourceUtilization(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(projectResources);
    const by = new Map<string, number>();
    for (const r of rows) by.set(r.resourceName, r2((by.get(r.resourceName) ?? 0) + n(r.allocPct)));
    const utilization = [...by.entries()]
      .map(([resource_name, total]) => ({ resource_name, allocated_pct: r2(total), over_allocated: total > 100 }))
      .sort((a, b) => b.allocated_pct - a.allocated_pct);
    return { utilization, over_allocated_count: utilization.filter((u) => u.over_allocated).length };
  }

  // Time-phased capacity calendar (PPM upgrade): the flat resourceUtilization rolls every assignment into one
  // number; this buckets each assignment's alloc % into the MONTHS its [period_start, period_end] spans and
  // compares the per-month demand to capacity (100%/resource/month), so a resource over-booked in a *specific*
  // window is visible even when the lifetime average looks fine. Read-only; horizon = `months` from `from`.
  async resourceCapacity(_user: JwtUser, dto?: { months?: number; from?: string }) {
    const db = this.db;
    const months = Math.max(1, Math.min(24, Math.round(dto?.months ?? 6)));
    const start = (dto?.from && /^\d{4}-\d{2}$/.test(dto.from)) ? dto.from : ymd().slice(0, 7);
    const addMonths = (period: string, k: number) => { const [y, m] = period.split('-').map(Number); const idx = y! * 12 + (m! - 1) + k; return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`; };
    const horizon = Array.from({ length: months }, (_, i) => addMonths(start, i));
    const rows = await db.select().from(projectResources);
    // An assignment is active in month M when period_start ≤ M-end and (period_end is open or ≥ M-start). A
    // null period_start means "from project inception" (active from the horizon's first month onward).
    const activeIn = (r: any, month: string) => {
      const mStart = `${month}-01`, mEnd = `${month}-31`;
      const ps = r.periodStart ?? null, pe = r.periodEnd ?? null;
      return (ps == null || ps <= mEnd) && (pe == null || pe >= mStart);
    };
    const byRes = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const name = r.resourceName;
      const m = byRes.get(name) ?? new Map<string, number>();
      for (const month of horizon) if (activeIn(r, month)) m.set(month, r2((m.get(month) ?? 0) + n(r.allocPct)));
      byRes.set(name, m);
    }
    // PROJ-20 (PPM-A1): a real per-resource, per-month availability CEILING (default 100% absent an override)
    // replaces the flat 100% assumption, and `named` flags whether a resource_skills row backs this booking
    // (a resource_name with no skills row is a GENERIC placeholder, e.g. "Senior Dev TBD").
    const calendarRows = await db.select().from(resourceCalendar);
    const availByResMonth = new Map<string, number>();
    for (const c of calendarRows) availByResMonth.set(`${c.resourceName}|${String(c.month).slice(0, 7)}`, n(c.availablePct));
    const namedResources = new Set((await db.select().from(resourceSkills)).map((s: any) => s.resourceName));

    const resources = [...byRes.entries()].map(([resource_name, m]) => {
      const cells = horizon.map((month) => {
        const pct = r2(m.get(month) ?? 0);
        const available_pct = availByResMonth.get(`${resource_name}|${month}`) ?? 100;
        return { month, allocated_pct: pct, available_pct, over_allocated: pct > available_pct };
      });
      const peak = cells.reduce((mx, c) => Math.max(mx, c.allocated_pct), 0);
      return { resource_name, named: namedResources.has(resource_name), months: cells, peak_pct: r2(peak), over_months: cells.filter((c) => c.over_allocated).length };
    }).sort((a, b) => b.peak_pct - a.peak_pct);
    const monthly = horizon.map((month) => {
      const cells = resources.map((r) => r.months.find((c) => c.month === month)!);
      return { month, total_demand_pct: r2(cells.reduce((s, c) => s + c.allocated_pct, 0)), resources_over: cells.filter((c) => c.over_allocated).length };
    });
    return { from: start, months, horizon, resources, monthly, over_allocated_count: resources.filter((r) => r.over_months > 0).length };
  }

  // ── Resource skills + calendar + role supply-vs-demand (PPM-A1, PROJ-20) ─────────────────────────

  async upsertResourceSkill(dto: ResourceSkillDto, user: JwtUser) {
    const db = this.db;
    await db.insert(resourceSkills).values({
      tenantId: user.tenantId ?? null, resourceName: dto.resource_name, skill: dto.skill, proficiency: dto.proficiency ?? null, createdBy: user.username,
    }).onConflictDoUpdate({
      target: [resourceSkills.tenantId, resourceSkills.resourceName, resourceSkills.skill],
      set: { proficiency: dto.proficiency ?? null },
    });
    return this.listResourceSkills(user);
  }

  async listResourceSkills(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(resourceSkills).orderBy(resourceSkills.resourceName, resourceSkills.skill);
    return { skills: rows.map((r: any) => ({ resource_name: r.resourceName, skill: r.skill, proficiency: r.proficiency })), count: rows.length };
  }

  async upsertResourceCalendar(dto: ResourceCalendarDto, user: JwtUser) {
    const db = this.db;
    if (!/^\d{4}-\d{2}$/.test(dto.month)) throw new BadRequestException({ code: 'BAD_MONTH', message: 'month must be YYYY-MM', messageTh: 'รูปแบบเดือนต้องเป็น YYYY-MM' });
    const pct = dto.available_pct ?? 100;
    if (pct < 0 || pct > 100) throw new BadRequestException({ code: 'BAD_AVAILABLE_PCT', message: 'available_pct must be within 0-100', messageTh: 'ค่าความพร้อมต้องอยู่ระหว่าง 0-100' });
    await db.insert(resourceCalendar).values({
      tenantId: user.tenantId ?? null, resourceName: dto.resource_name, month: `${dto.month}-01`, availablePct: fx(pct, 2), reason: dto.reason ?? null, createdBy: user.username,
    }).onConflictDoUpdate({
      target: [resourceCalendar.tenantId, resourceCalendar.resourceName, resourceCalendar.month],
      set: { availablePct: fx(pct, 2), reason: dto.reason ?? null },
    });
    return this.listResourceCalendar(user, dto.resource_name);
  }

  async listResourceCalendar(_user: JwtUser, resourceName?: string) {
    const db = this.db;
    const rows = resourceName
      ? await db.select().from(resourceCalendar).where(eq(resourceCalendar.resourceName, resourceName)).orderBy(resourceCalendar.month)
      : await db.select().from(resourceCalendar).orderBy(resourceCalendar.resourceName, resourceCalendar.month);
    return { entries: rows.map((r: any) => ({ resource_name: r.resourceName, month: String(r.month).slice(0, 7), available_pct: n(r.availablePct), reason: r.reason })), count: rows.length };
  }

  // Role/skill supply-vs-demand (PROJ-20): per role, per month, DEMAND (Σ assignment alloc_pct tagged with
  // that role) vs SUPPLY (Σ availability of every resource_skills-tagged person who can fill it, capacity-
  // calendar aware, default 100%/person absent an override). A negative gap = understaffed — more assigned
  // work than people qualified to do it, surfaced before it becomes a schedule slip.
  async roleSupplyDemand(_user: JwtUser, dto?: { months?: number; from?: string }) {
    const db = this.db;
    const months = Math.max(1, Math.min(24, Math.round(dto?.months ?? 6)));
    const start = (dto?.from && /^\d{4}-\d{2}$/.test(dto.from)) ? dto.from : ymd().slice(0, 7);
    const addMonths = (period: string, k: number) => { const [y, m] = period.split('-').map(Number); const idx = y! * 12 + (m! - 1) + k; return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`; };
    const horizon = Array.from({ length: months }, (_, i) => addMonths(start, i));
    const activeIn = (ps: string | null, pe: string | null, month: string) => {
      const mStart = `${month}-01`, mEnd = `${month}-31`;
      return (ps == null || ps <= mEnd) && (pe == null || pe >= mStart);
    };

    const assignments = await db.select().from(projectResources);
    const demand = new Map<string, Map<string, number>>();
    for (const r of assignments) {
      if (!r.role) continue;
      const m = demand.get(r.role) ?? new Map<string, number>();
      for (const month of horizon) if (activeIn(r.periodStart, r.periodEnd, month)) m.set(month, r2((m.get(month) ?? 0) + n(r.allocPct)));
      demand.set(r.role, m);
    }

    const skills = await db.select().from(resourceSkills);
    const calendarRows = await db.select().from(resourceCalendar);
    const availByResMonth = new Map<string, number>();
    for (const c of calendarRows) availByResMonth.set(`${c.resourceName}|${String(c.month).slice(0, 7)}`, n(c.availablePct));
    const supply = new Map<string, Map<string, number>>();
    for (const s of skills) {
      const m = supply.get(s.skill) ?? new Map<string, number>();
      for (const month of horizon) m.set(month, r2((m.get(month) ?? 0) + (availByResMonth.get(`${s.resourceName}|${month}`) ?? 100)));
      supply.set(s.skill, m);
    }

    const roleSet = new Set<string>([...demand.keys(), ...supply.keys()]);
    const roles = [...roleSet].map((role) => {
      const dM = demand.get(role) ?? new Map<string, number>();
      const sM = supply.get(role) ?? new Map<string, number>();
      const cells = horizon.map((month) => {
        const demand_pct = r2(dM.get(month) ?? 0);
        const supply_pct = r2(sM.get(month) ?? 0);
        const gap_pct = r2(supply_pct - demand_pct);
        return { month, demand_pct, supply_pct, gap_pct, understaffed: gap_pct < 0 };
      });
      return { role, months: cells, understaffed_months: cells.filter((c) => c.understaffed).length };
    }).sort((a, b) => b.understaffed_months - a.understaffed_months);
    return { from: start, months, horizon, roles, understaffed_role_count: roles.filter((r) => r.understaffed_months > 0).length };
  }
}
