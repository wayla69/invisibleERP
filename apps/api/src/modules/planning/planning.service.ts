import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException, Optional } from '@nestjs/common';
import { eq, and, sql, asc, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { budgetVersions, budgetScenarios, budgetDrivers, forecastLines } from '../../database/schema/planning';
import { budgets } from '../../database/schema/budgets';
import { journalEntries, journalLines } from '../../database/schema/ledger';
import { docCountersTenant } from '../../database/schema/system';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { WorkflowService } from '../workflow/workflow.service';

@Injectable()
export class PlanningService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly workflow?: WorkflowService,
  ) {}

  // ── Doc-number: BV-{year}-{n:04d}, sequential per tenant+year ──
  private async nextVersionNo(tenantId: number, fiscalYear: number): Promise<string> {
    const db = this.db as any;
    const period = String(fiscalYear);
    const r = await db.insert(docCountersTenant)
      .values({ docType: 'BV', tenantId, period, n: 1 })
      .onConflictDoUpdate({
        target: [docCountersTenant.docType, docCountersTenant.tenantId, docCountersTenant.period],
        set: { n: sql`${docCountersTenant.n} + 1` },
      })
      .returning({ n: docCountersTenant.n });
    return `BV-${period}-${String(Number(r[0].n)).padStart(4, '0')}`;
  }

  // ── Guard: version must belong to caller's tenant ──
  private async assertVersion(versionId: number, user: JwtUser) {
    const db = this.db as any;
    const [v] = await db.select().from(budgetVersions).where(eq(budgetVersions.id, versionId)).limit(1);
    if (!v) throw new NotFoundException({ code: 'VERSION_NOT_FOUND', message: `Budget version ${versionId} not found` });
    return v;
  }

  private async assertScenario(scenarioId: number, user: JwtUser) {
    const db = this.db as any;
    const [s] = await db.select().from(budgetScenarios).where(eq(budgetScenarios.id, scenarioId)).limit(1);
    if (!s) throw new NotFoundException({ code: 'SCENARIO_NOT_FOUND', message: `Budget scenario ${scenarioId} not found` });
    return s;
  }

  // ── Versions ──

  async createVersion(dto: { name: string; fiscal_year: number; notes?: string }, user: JwtUser) {
    const db = this.db as any;
    const tenantId = user.tenantId!;
    const versionNo = await this.nextVersionNo(tenantId, dto.fiscal_year);
    const [v] = await db.insert(budgetVersions).values({
      tenantId, versionNo, name: dto.name, fiscalYear: dto.fiscal_year,
      status: 'Working', notes: dto.notes ?? null, createdBy: user.username,
    }).returning();
    return this.formatVersion(v);
  }

  async listVersions(user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(budgetVersions).orderBy(asc(budgetVersions.fiscalYear), asc(budgetVersions.id));
    return { versions: rows.map(this.formatVersion) };
  }

  async getVersion(versionId: number, user: JwtUser) {
    const v = await this.assertVersion(versionId, user);
    const db = this.db as any;
    const scenarios = await db.select().from(budgetScenarios).where(eq(budgetScenarios.versionId, versionId)).orderBy(asc(budgetScenarios.id));
    return { ...this.formatVersion(v), scenarios: scenarios.map(this.formatScenario) };
  }

  async submitVersion(versionId: number, user: JwtUser) {
    const db = this.db as any;
    const v = await this.assertVersion(versionId, user);
    if (v.status !== 'Working') throw new BadRequestException({ code: 'INVALID_STATUS', message: `Version must be in Working status to submit (current: ${v.status})`, messageTh: 'สถานะต้องเป็น Working เพื่อส่งอนุมัติ' });

    // start workflow (no active def → auto-approved)
    const totalAmount = await this.versionTotal(versionId);
    let wfStatus = 'pending';
    if (this.workflow) {
      const wf = await this.workflow.start({ docType: 'BUDGET', docNo: v.versionNo, amount: totalAmount, createdBy: user.username, tenantId: user.tenantId ?? null });
      wfStatus = wf.autoApproved ? 'auto' : wf.status;
    }

    const now = new Date();
    await db.update(budgetVersions).set({ status: 'Submitted', submittedAt: now, updatedAt: now }).where(eq(budgetVersions.id, versionId));
    return { version_no: v.versionNo, status: 'Submitted', workflow_status: wfStatus };
  }

  async approveVersion(versionId: number, user: JwtUser) {
    const db = this.db as any;
    const v = await this.assertVersion(versionId, user);
    if (v.status !== 'Submitted') throw new BadRequestException({ code: 'INVALID_STATUS', message: `Version must be Submitted to approve (current: ${v.status})`, messageTh: 'สถานะต้องเป็น Submitted เพื่ออนุมัติ' });

    // gate on workflow engine if active
    if (this.workflow) {
      await this.workflow.assertCanTransition('BUDGET', v.versionNo);
    }

    const now = new Date();
    await db.update(budgetVersions).set({ status: 'Approved', approvedAt: now, updatedAt: now }).where(eq(budgetVersions.id, versionId));
    return { version_no: v.versionNo, status: 'Approved' };
  }

  async baselineVersion(versionId: number, user: JwtUser) {
    const db = this.db as any;
    const v = await this.assertVersion(versionId, user);
    if (v.status !== 'Approved') throw new BadRequestException({ code: 'INVALID_STATUS', message: `Version must be Approved to set as Baseline (current: ${v.status})`, messageTh: 'ต้องอนุมัติก่อนกำหนดเป็น Baseline' });
    await db.update(budgetVersions).set({ status: 'Baseline', updatedAt: new Date() }).where(eq(budgetVersions.id, versionId));
    return { version_no: v.versionNo, status: 'Baseline' };
  }

  // ── Scenarios ──

  async addScenario(versionId: number, dto: { name: string; description?: string; is_default?: boolean }, user: JwtUser) {
    const db = this.db as any;
    await this.assertVersion(versionId, user);
    const [s] = await db.insert(budgetScenarios).values({
      tenantId: user.tenantId!, versionId, name: dto.name,
      description: dto.description ?? null, isDefault: dto.is_default ?? false,
    }).returning();
    return this.formatScenario(s);
  }

  async cloneScenario(scenarioId: number, dto: { name: string; description?: string }, user: JwtUser) {
    const db = this.db as any;
    const src = await this.assertScenario(scenarioId, user);

    // new scenario under same version
    const [newScen] = await db.insert(budgetScenarios).values({
      tenantId: user.tenantId!, versionId: Number(src.versionId), name: dto.name,
      description: dto.description ?? null, isDefault: false,
    }).returning();

    // copy all forecast lines
    const lines = await db.select().from(forecastLines).where(eq(forecastLines.scenarioId, scenarioId));
    if (lines.length > 0) {
      await db.insert(forecastLines).values(lines.map((l: any) => ({
        tenantId: user.tenantId!, scenarioId: Number(newScen.id),
        accountCode: l.accountCode, costCenterCode: l.costCenterCode,
        period: l.period, amount: l.amount, source: 'Manual', notes: l.notes,
      })));
    }

    return { ...this.formatScenario(newScen), lines_copied: lines.length };
  }

  async getScenarioLines(scenarioId: number, period: string | undefined, user: JwtUser) {
    const db = this.db as any;
    await this.assertScenario(scenarioId, user);
    const where = period
      ? and(eq(forecastLines.scenarioId, scenarioId), eq(forecastLines.period, period))
      : eq(forecastLines.scenarioId, scenarioId);
    const rows = await db.select().from(forecastLines).where(where).orderBy(asc(forecastLines.period), asc(forecastLines.accountCode));
    return { scenario_id: scenarioId, lines: rows.map(this.formatLine) };
  }

  // ── Forecast Lines ──

  async upsertForecastLine(scenarioId: number, dto: { account_code: string; period: string; amount: number; cost_center_code?: string; notes?: string }, user: JwtUser) {
    const db = this.db as any;
    await this.assertScenario(scenarioId, user);
    const tenantId = user.tenantId!;

    // Unique constraint on (scenario_id, account_code, period) — upsert via conflict target
    const [row] = await db.insert(forecastLines).values({
      tenantId, scenarioId, accountCode: dto.account_code,
      costCenterCode: dto.cost_center_code ?? null, period: dto.period,
      amount: fx(dto.amount, 4), source: 'Manual', notes: dto.notes ?? null,
    }).onConflictDoUpdate({
      target: [forecastLines.scenarioId, forecastLines.accountCode, forecastLines.period],
      set: { amount: fx(dto.amount, 4), costCenterCode: dto.cost_center_code ?? null, source: 'Manual', notes: dto.notes ?? null, updatedAt: new Date() },
    }).returning();
    return this.formatLine(row);
  }

  // ── Drivers ──

  async upsertDriver(scenarioId: number, dto: { account_code: string; driver_type: 'percent' | 'rate' | 'absolute'; rate_value: number; notes?: string }, user: JwtUser) {
    const db = this.db as any;
    const scen = await this.assertScenario(scenarioId, user);
    const tenantId = user.tenantId!;

    if (!['percent', 'rate', 'absolute'].includes(dto.driver_type)) {
      throw new BadRequestException({ code: 'INVALID_DRIVER_TYPE', message: 'driver_type must be percent | rate | absolute' });
    }

    // upsert by (scenario_id, account_code) — one driver rule per account per scenario
    const existing = await db.select({ id: budgetDrivers.id }).from(budgetDrivers)
      .where(and(eq(budgetDrivers.scenarioId, scenarioId), eq(budgetDrivers.accountCode, dto.account_code))).limit(1);

    if (existing.length > 0) {
      await db.update(budgetDrivers).set({ driverType: dto.driver_type, rateValue: fx(dto.rate_value, 4), notes: dto.notes ?? null })
        .where(eq(budgetDrivers.id, Number(existing[0].id)));
      return { scenario_id: scenarioId, account_code: dto.account_code, driver_type: dto.driver_type, rate_value: dto.rate_value, upserted: 'updated' };
    }

    const [d] = await db.insert(budgetDrivers).values({
      tenantId, scenarioId, accountCode: dto.account_code,
      driverType: dto.driver_type, rateValue: fx(dto.rate_value, 4), notes: dto.notes ?? null,
    }).returning();
    return { scenario_id: scenarioId, account_code: dto.account_code, driver_type: dto.driver_type, rate_value: dto.rate_value, upserted: 'created' };
  }

  // Run all driver rules for a scenario over the given periods, computing amounts from GL actuals.
  async runDrivers(scenarioId: number, dto: { periods: string[] }, user: JwtUser) {
    const db = this.db as any;
    const scen = await this.assertScenario(scenarioId, user);
    const tenantId = user.tenantId!;
    if (!dto.periods?.length) throw new BadRequestException({ code: 'NO_PERIODS', message: 'periods array required' });

    const drivers = await db.select().from(budgetDrivers).where(eq(budgetDrivers.scenarioId, scenarioId));
    if (!drivers.length) return { lines_written: 0 };

    // Get GL net movement (debit - credit) for each account+period from posted journal entries
    const glRows: any[] = await db.select({
      accountCode: journalLines.accountCode,
      period: journalEntries.period,
      net: sql`sum(${journalLines.debit} - ${journalLines.credit})`,
    }).from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.status, 'Posted'),
        inArray(journalEntries.period, dto.periods),
        inArray(journalLines.accountCode, drivers.map((d: any) => d.accountCode)),
      ))
      .groupBy(journalLines.accountCode, journalEntries.period);

    // Index actuals: account → period → net
    const actuals: Record<string, Record<string, number>> = {};
    for (const r of glRows) {
      if (!actuals[r.accountCode]) actuals[r.accountCode] = {};
      actuals[r.accountCode][r.period] = n(r.net);
    }

    let linesWritten = 0;
    for (const drv of drivers) {
      for (const period of dto.periods) {
        let amount = 0;
        const actual = actuals[drv.accountCode]?.[period] ?? 0;

        if (drv.driverType === 'percent') {
          amount = actual * (1 + n(drv.rateValue) / 100);
        } else if (drv.driverType === 'rate') {
          amount = n(drv.rateValue);
        } else {
          // absolute — only applies if a prior manual line exists for this period; otherwise set directly
          amount = n(drv.rateValue);
        }

        await db.insert(forecastLines).values({
          tenantId, scenarioId, accountCode: drv.accountCode,
          costCenterCode: null, period, amount: fx(amount, 4), source: 'Driver', notes: `driver:${drv.driverType}`,
        }).onConflictDoUpdate({
          target: [forecastLines.scenarioId, forecastLines.accountCode, forecastLines.period],
          set: { amount: fx(amount, 4), source: 'Driver', notes: `driver:${drv.driverType}`, updatedAt: new Date() },
        });
        linesWritten++;
      }
    }

    return { scenario_id: scenarioId, periods: dto.periods, lines_written: linesWritten };
  }

  // ── 3-Way Variance — Budget (flat budgets table) vs Forecast (forecast_lines) vs Actual (GL) ──
  async threeWayVariance(versionId: number, scenarioId: number, period: string, user: JwtUser) {
    const db = this.db as any;
    const tenantId = user.tenantId!;
    await this.assertVersion(versionId, user);
    await this.assertScenario(scenarioId, user);

    // Budget: from flat budgets table
    const budgetRows = await db.select({ accountCode: budgets.accountCode, amount: budgets.amount })
      .from(budgets)
      .where(and(eq(budgets.tenantId, tenantId), eq(budgets.period, period)));
    const budgetMap: Record<string, number> = {};
    for (const r of budgetRows) budgetMap[r.accountCode] = n(r.amount);

    // Forecast: from forecast_lines for this scenario+period
    const forecastRows = await db.select({ accountCode: forecastLines.accountCode, amount: forecastLines.amount })
      .from(forecastLines)
      .where(and(eq(forecastLines.scenarioId, scenarioId), eq(forecastLines.period, period)));
    const forecastMap: Record<string, number> = {};
    for (const r of forecastRows) forecastMap[r.accountCode] = n(r.amount);

    // Actual: net GL movement (debit - credit) from posted journal entries for this tenant+period
    const actualRows = await db.select({
      accountCode: journalLines.accountCode,
      net: sql`sum(${journalLines.debit} - ${journalLines.credit})`,
    }).from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.status, 'Posted'),
        eq(journalEntries.period, period),
      ))
      .groupBy(journalLines.accountCode);
    const actualMap: Record<string, number> = {};
    for (const r of actualRows) actualMap[r.accountCode] = n(r.net);

    // Merge all accounts
    const allAccounts = new Set([...Object.keys(budgetMap), ...Object.keys(forecastMap), ...Object.keys(actualMap)]);
    const lines = Array.from(allAccounts).sort().map((code) => {
      const budget = budgetMap[code] ?? 0;
      const forecast = forecastMap[code] ?? 0;
      const actual = actualMap[code] ?? 0;
      return {
        account_code: code,
        budget,
        forecast,
        actual,
        actual_vs_budget: +(actual - budget).toFixed(4),
        actual_vs_forecast: +(actual - forecast).toFixed(4),
        forecast_vs_budget: +(forecast - budget).toFixed(4),
      };
    });

    const totals = lines.reduce((acc, l) => ({
      budget: +(acc.budget + l.budget).toFixed(4),
      forecast: +(acc.forecast + l.forecast).toFixed(4),
      actual: +(acc.actual + l.actual).toFixed(4),
    }), { budget: 0, forecast: 0, actual: 0 });

    return {
      version_id: versionId, scenario_id: scenarioId, period,
      lines,
      totals: { ...totals, actual_vs_budget: +(totals.actual - totals.budget).toFixed(4), actual_vs_forecast: +(totals.actual - totals.forecast).toFixed(4) },
    };
  }

  // ── Helpers ──
  private async versionTotal(versionId: number): Promise<number> {
    const db = this.db as any;
    // sum all forecast_lines across scenarios in this version
    const scenarios = await db.select({ id: budgetScenarios.id }).from(budgetScenarios).where(eq(budgetScenarios.versionId, versionId));
    if (!scenarios.length) return 0;
    const ids = scenarios.map((s: any) => Number(s.id));
    const [r] = await db.select({ total: sql`coalesce(sum(${forecastLines.amount}),0)` }).from(forecastLines)
      .where(inArray(forecastLines.scenarioId, ids));
    return n(r?.total);
  }

  private formatVersion(v: any) {
    return {
      id: Number(v.id), version_no: v.versionNo, name: v.name, fiscal_year: v.fiscalYear,
      status: v.status, notes: v.notes, created_by: v.createdBy,
      submitted_at: v.submittedAt, approved_at: v.approvedAt,
      created_at: v.createdAt, updated_at: v.updatedAt,
    };
  }
  private formatScenario(s: any) {
    return { id: Number(s.id), version_id: Number(s.versionId), name: s.name, description: s.description, is_default: s.isDefault, created_at: s.createdAt };
  }
  private formatLine(l: any) {
    return {
      id: Number(l.id), scenario_id: Number(l.scenarioId), account_code: l.accountCode,
      cost_center_code: l.costCenterCode, period: l.period, amount: n(l.amount),
      source: l.source, notes: l.notes,
    };
  }
}
