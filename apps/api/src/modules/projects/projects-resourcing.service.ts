import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { projects, projectTasks, projectResources, resourceRates, timesheets, crmOpportunities } from '../../database/schema';
import { BadRequestException } from '@nestjs/common';
import { n, fx, ymd } from '../../database/queries';
import { r2, DEFAULT_REV_PER_FTE_MONTH } from './projects.helpers';
import { shapeResource } from './projects.shapes';
import type { JwtUser } from '../../common/decorators';
import type { RateCardDto, ResourceDto } from './projects.service';

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
    const resources = [...byRes.entries()].map(([resource_name, m]) => {
      const cells = horizon.map((month) => { const pct = r2(m.get(month) ?? 0); return { month, allocated_pct: pct, over_allocated: pct > 100 }; });
      const peak = cells.reduce((mx, c) => Math.max(mx, c.allocated_pct), 0);
      return { resource_name, months: cells, peak_pct: r2(peak), over_months: cells.filter((c) => c.over_allocated).length };
    }).sort((a, b) => b.peak_pct - a.peak_pct);
    const monthly = horizon.map((month) => {
      const cells = resources.map((r) => r.months.find((c) => c.month === month)!);
      return { month, total_demand_pct: r2(cells.reduce((s, c) => s + c.allocated_pct, 0)), resources_over: cells.filter((c) => c.over_allocated).length };
    });
    return { from: start, months, horizon, resources, monthly, over_allocated_count: resources.filter((r) => r.over_months > 0).length };
  }
}
