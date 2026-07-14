import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DrizzleDb } from '../../database/database.module';
import { portfolioScenarios, portfolioScenarioItems, projects } from '../../database/schema';
import { n } from '../../database/queries';
import { r2 } from './projects.helpers';
import type { JwtUser } from '../../common/decorators';
import type { PortfolioScenarioDto, PortfolioItemDto, PortfolioCommitDto } from './projects.service';

// Portfolio selection sub-service (PPM Wave P4, PROJ-25) — a PLAIN class built in the ProjectsService ctor
// body (not a DI provider), mirroring ProjectsResourcingService: the goldenmaster builds `new
// ProjectsService(db, ledger)` positionally, so the facade materializes this from the injected db alone.
//
// A portfolio SELECTION scenario is a named what-if that models which candidate projects to fund within a
// budget ENVELOPE. Each candidate carries an include/exclude decision + a priority score. `analyze()` is a
// pure read-only aggregation over the projects spine (contract/budget/estimated-cost → margin) that reports
// the selected total vs the envelope. A scenario is DRAFT (freely editable) until COMMITTED — a maker-checker
// decision (committer <> created_by → SOD_SELF_APPROVAL) that locks the authorised GO-set; an over-envelope
// commit is rejected (OVER_ENVELOPE) unless an exec overrides with a reason. No project row is ever mutated.
export class ProjectsPortfolioService {
  constructor(private readonly db: DrizzleDb) {}

  private tid(user: JwtUser): number | null {
    return user.tenantId ?? null;
  }

  // Resolve a scenario by its per-tenant number (RLS already scopes the read to the caller's tenant).
  private async scenarioByNo(scenarioNo: string): Promise<any> {
    const [s] = await this.db.select().from(portfolioScenarios).where(eq(portfolioScenarios.scenarioNo, scenarioNo)).limit(1);
    if (!s) throw new NotFoundException({ code: 'SCENARIO_NOT_FOUND', message: `Portfolio scenario ${scenarioNo} not found`, messageTh: 'ไม่พบสถานการณ์พอร์ตโฟลิโอ' });
    return s;
  }

  async createScenario(dto: PortfolioScenarioDto, user: JwtUser) {
    const db = this.db;
    const name = (dto.name ?? '').trim();
    if (!name) throw new BadRequestException({ code: 'NAME_REQUIRED', message: 'A scenario name is required', messageTh: 'ต้องระบุชื่อสถานการณ์' });
    const env = dto.budget_envelope != null ? r2(Math.max(0, n(dto.budget_envelope))) : null;
    // Per-tenant sequential number PSC-#### (RLS scopes the count to the caller's tenant).
    const [cnt] = await db.select({ c: sql<string>`count(*)` }).from(portfolioScenarios);
    const scenarioNo = `PSC-${String(Number(n(cnt?.c)) + 1).padStart(4, '0')}`;
    const [row] = await db.insert(portfolioScenarios).values({
      tenantId: this.tid(user), scenarioNo, name, status: 'draft',
      budgetEnvelope: env != null ? env.toFixed(2) : null,
      objective: dto.objective ?? null, notes: dto.notes ?? null, createdBy: user.username,
    }).returning();
    return this.analyze(row!.scenarioNo);
  }

  async listScenarios(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(portfolioScenarios).orderBy(desc(portfolioScenarios.id)).limit(300);
    const ids = rows.map((r: any) => Number(r.id));
    const counts = ids.length
      ? await db.select({ scenarioId: portfolioScenarioItems.scenarioId, n: sql<string>`count(*)` })
          .from(portfolioScenarioItems)
          .where(and(inArray(portfolioScenarioItems.scenarioId, ids), eq(portfolioScenarioItems.decision, 'include')))
          .groupBy(portfolioScenarioItems.scenarioId)
      : [];
    const byId = new Map(counts.map((c: any) => [Number(c.scenarioId), Number(n(c.n))]));
    return {
      scenarios: rows.map((r: any) => ({
        scenario_no: r.scenarioNo, name: r.name, status: r.status,
        budget_envelope: r.budgetEnvelope != null ? n(r.budgetEnvelope) : null,
        included_count: byId.get(Number(r.id)) ?? 0,
        objective: r.objective, created_by: r.createdBy, committed_by: r.committedBy, committed_at: r.committedAt,
      })),
      count: rows.length,
    };
  }

  // Add or update a candidate project's decision + priority on a DRAFT scenario. Idempotent per project.
  async upsertItem(scenarioNo: string, dto: PortfolioItemDto, user: JwtUser) {
    const db = this.db;
    const s = await this.scenarioByNo(scenarioNo);
    if (s.status !== 'draft') throw new BadRequestException({ code: 'SCENARIO_LOCKED', message: 'A committed scenario is read-only', messageTh: 'สถานการณ์ที่ยืนยันแล้วแก้ไขไม่ได้' });
    const [proj] = await db.select({ id: projects.id }).from(projects).where(eq(projects.projectCode, dto.project_code)).limit(1);
    if (!proj) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: `Project ${dto.project_code} not found`, messageTh: 'ไม่พบโครงการ' });
    const decision = dto.decision === 'exclude' ? 'exclude' : 'include';
    const priority = r2(Math.max(0, n(dto.priority_score ?? 0)));
    await db.insert(portfolioScenarioItems).values({
      tenantId: this.tid(user), scenarioId: Number(s.id), projectId: Number(proj.id),
      decision, priorityScore: priority.toFixed(2), rationale: dto.rationale ?? null,
    }).onConflictDoUpdate({
      target: [portfolioScenarioItems.tenantId, portfolioScenarioItems.scenarioId, portfolioScenarioItems.projectId],
      set: { decision, priorityScore: priority.toFixed(2), rationale: dto.rationale ?? null, updatedAt: sql`now()` },
    });
    return this.analyze(scenarioNo);
  }

  async removeItem(scenarioNo: string, projectCode: string, user: JwtUser) {
    const db = this.db;
    const s = await this.scenarioByNo(scenarioNo);
    if (s.status !== 'draft') throw new BadRequestException({ code: 'SCENARIO_LOCKED', message: 'A committed scenario is read-only', messageTh: 'สถานการณ์ที่ยืนยันแล้วแก้ไขไม่ได้' });
    const [proj] = await db.select({ id: projects.id }).from(projects).where(eq(projects.projectCode, projectCode)).limit(1);
    if (!proj) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: `Project ${projectCode} not found`, messageTh: 'ไม่พบโครงการ' });
    await db.delete(portfolioScenarioItems).where(and(eq(portfolioScenarioItems.scenarioId, Number(s.id)), eq(portfolioScenarioItems.projectId, Number(proj.id))));
    return this.analyze(scenarioNo);
  }

  // The what-if: read the scenario's candidate projects, join the live contract/budget/estimated-cost, and
  // roll up the INCLUDED set (Σ contract/budget/margin) vs the envelope. Read-only — nothing is written.
  async analyze(scenarioNo: string) {
    const db = this.db;
    const s = await this.scenarioByNo(scenarioNo);
    const items = await db.select({
      projectId: portfolioScenarioItems.projectId, decision: portfolioScenarioItems.decision,
      priorityScore: portfolioScenarioItems.priorityScore, rationale: portfolioScenarioItems.rationale,
      code: projects.projectCode, pname: projects.name, pstatus: projects.status,
      contract: projects.contractAmount, budget: projects.budgetAmount, est: projects.estimatedCost,
    })
      .from(portfolioScenarioItems)
      .innerJoin(projects, eq(projects.id, portfolioScenarioItems.projectId))
      .where(eq(portfolioScenarioItems.scenarioId, Number(s.id)));

    const shape = (it: any) => {
      const contract = n(it.contract), budget = n(it.budget), est = n(it.est);
      const margin = r2(contract - est);
      return {
        project_code: it.code, name: it.pname, project_status: it.pstatus, decision: it.decision,
        priority_score: n(it.priorityScore), rationale: it.rationale,
        contract_amount: contract, budget_amount: budget, estimated_cost: est, margin,
        margin_pct: contract > 0 ? r2(margin / contract * 100) : null,
      };
    };
    const rows = items.map(shape).sort((a: any, b: any) => (b.priority_score - a.priority_score) || (b.margin - a.margin));
    const included = rows.filter((r: any) => r.decision === 'include');
    const excluded = rows.filter((r: any) => r.decision === 'exclude');

    const sum = (xs: any[], k: string) => r2(xs.reduce((t, x) => t + x[k], 0));
    const envelope = s.budgetEnvelope != null ? n(s.budgetEnvelope) : null;
    const selectedBudget = sum(included, 'budget_amount');
    const overBy = envelope != null ? r2(selectedBudget - envelope) : null;

    return {
      scenario_no: s.scenarioNo, name: s.name, status: s.status,
      budget_envelope: envelope, objective: s.objective, notes: s.notes,
      created_by: s.createdBy, committed_by: s.committedBy, committed_at: s.committedAt, override_reason: s.overrideReason,
      totals: {
        included_count: included.length, excluded_count: excluded.length,
        selected_contract: sum(included, 'contract_amount'),
        selected_budget: selectedBudget,
        selected_estimated_cost: sum(included, 'estimated_cost'),
        selected_margin: sum(included, 'margin'),
        budget_headroom: envelope != null ? r2(envelope - selectedBudget) : null,
        over_envelope: envelope != null ? selectedBudget > envelope : false,
        over_by: overBy != null && overBy > 0 ? overBy : 0,
      },
      included, excluded,
    };
  }

  // Maker-checker commit (PROJ-25): the committer must differ from the scenario's author, the scenario must be
  // DRAFT, and the included budget must fit the envelope — unless an exec overrides with a reason. On success
  // the GO-set is locked (status='committed'); no project row is touched — the scenario IS the authorised plan.
  async commitScenario(scenarioNo: string, dto: PortfolioCommitDto, user: JwtUser) {
    const db = this.db;
    const s = await this.scenarioByNo(scenarioNo);
    if (s.status !== 'draft') throw new BadRequestException({ code: 'SCENARIO_NOT_DRAFT', message: `Scenario is already ${s.status}`, messageTh: 'สถานการณ์ถูกยืนยันแล้ว' });
    if (s.createdBy === user.username) throw new BadRequestException({ code: 'SOD_SELF_APPROVAL', message: 'The committer must differ from the scenario author (segregation of duties)', messageTh: 'ผู้ยืนยันต้องไม่ใช่ผู้สร้าง (แบ่งแยกหน้าที่)' });

    const analysis = await this.analyze(scenarioNo);
    if (analysis.totals.included_count === 0) throw new BadRequestException({ code: 'NOTHING_SELECTED', message: 'Select at least one project before committing', messageTh: 'ต้องเลือกอย่างน้อยหนึ่งโครงการก่อนยืนยัน' });

    let overrideReason: string | null = null;
    if (analysis.totals.over_envelope) {
      const isExec = (user.permissions ?? []).includes('exec') || user.role === 'exec' || user.role === 'Admin';
      const reason = (dto.override_reason ?? '').trim();
      if (!dto.override || !reason) {
        throw new BadRequestException({ code: 'OVER_ENVELOPE', message: `Selected budget exceeds the envelope by ${analysis.totals.over_by}`, messageTh: 'งบที่เลือกเกินวงเงินที่กำหนด', details: { over_by: analysis.totals.over_by, envelope: analysis.budget_envelope, selected_budget: analysis.totals.selected_budget } });
      }
      if (!isExec) throw new BadRequestException({ code: 'OVERRIDE_REQUIRES_EXEC', message: 'Only an exec may override the budget envelope', messageTh: 'เฉพาะผู้บริหารเท่านั้นที่ข้ามวงเงินได้' });
      overrideReason = reason;
    }

    await db.update(portfolioScenarios).set({
      status: 'committed', committedBy: user.username, committedAt: sql`now()`,
      overrideReason, updatedAt: sql`now()`,
    }).where(eq(portfolioScenarios.id, Number(s.id)));
    return this.analyze(scenarioNo);
  }
}
