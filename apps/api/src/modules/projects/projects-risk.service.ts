import { eq, desc, sql } from 'drizzle-orm';
import { NotFoundException } from '@nestjs/common';
import type { DrizzleDb } from '../../database/database.module';
import { projects, projectRisks } from '../../database/schema';
import { ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { clamp15, riskScore, ragFor } from './projects.helpers';
import { shapeRisk } from './projects.shapes';
import type { RiskDto, RiskPatchDto } from './projects.service';

// Risk & issue register sub-service (PPM B4, PROJ-08) — a PLAIN class built in the ProjectsService ctor
// body (not a DI provider), extracted from the facade in the docs/46 Phase-4 projects round. Score =
// prob×impact (risk) / 5×impact (issue); RAG derives from the score band; an open HIGH item with no
// mitigation is the governance exposure the action center surfaces.
export class ProjectsRiskService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly rowOf: (code: string) => Promise<any>,
    // PMO-1: best-effort push to the live action bus (facade-owned; never throws).
    private readonly emitActionFn: (tenantId: number | null | undefined, kind: string, severity: string, projectCode: string, extra?: Record<string, any>) => void,
  ) {}

  // Log a risk (future threat) or issue (materialised problem).
  async addRisk(code: string, dto: RiskDto, user: JwtUser) {
    const db = this.db;
    const p = await this.rowOf(code);
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    const kind = dto.kind === 'issue' ? 'issue' : 'risk';
    const impact = clamp15(dto.impact ?? 1);
    const probability = kind === 'issue' ? null : clamp15(dto.probability ?? 1);
    const score = riskScore(kind, probability, impact);
    await db.insert(projectRisks).values({
      projectId: Number(p.id), tenantId, kind, title: dto.title, status: 'open',
      probability, impact, score, rag: ragFor(score), owner: dto.owner ?? null,
      mitigation: dto.mitigation ?? null, dueDate: dto.due_date ?? null, createdBy: user.username,
    });
    // PMO-1: an open HIGH risk with no mitigation plan (PROJ-08 exposure) pushes to the action center.
    if (ragFor(score) === 'red' && !dto.mitigation) this.emitActionFn(tenantId, 'risk_unmitigated_high', 'high', code, { title: dto.title, score });
    return this.listRisks(code);
  }

  async listRisks(code: string) {
    const db = this.db;
    const p = await this.rowOf(code);
    const rows = (await db.select().from(projectRisks).where(eq(projectRisks.projectId, Number(p.id))).orderBy(desc(projectRisks.score), desc(projectRisks.id))).map(shapeRisk);
    const open = rows.filter((r: any) => r.status !== 'closed');
    const high_open = open.filter((r: any) => r.rag === 'red');
    return {
      project_code: code, risks: rows, count: rows.length,
      summary: {
        open: open.length, closed: rows.length - open.length,
        risks: rows.filter((r: any) => r.kind === 'risk').length, issues: rows.filter((r: any) => r.kind === 'issue').length,
        high_open: high_open.length,
        // PROJ-08: open HIGH items with no mitigation plan — the unmitigated exposure that must be surfaced.
        unmitigated_high: high_open.filter((r: any) => !r.mitigation).length,
      },
    };
  }

  // Update a risk/issue: status (closing stamps closed_at), mitigation, owner, due, or a re-score (prob/impact →
  // score + rag recomputed). Returns the refreshed register.
  async patchRisk(riskId: number, dto: RiskPatchDto, user: JwtUser) {
    const db = this.db;
    const [r] = await db.select().from(projectRisks).where(eq(projectRisks.id, Number(riskId))).limit(1);
    if (!r) throw new NotFoundException({ code: 'RISK_NOT_FOUND', message: `Risk ${riskId} not found`, messageTh: 'ไม่พบความเสี่ยง' });
    const set: any = {};
    if (dto.title != null) set.title = dto.title;
    if (dto.owner != null) set.owner = dto.owner;
    if (dto.mitigation != null) set.mitigation = dto.mitigation;
    if (dto.due_date != null) set.dueDate = dto.due_date;
    if (dto.status != null) {
      set.status = dto.status;
      set.closedAt = dto.status === 'closed' ? new Date() : null;
    }
    if (dto.probability != null || dto.impact != null) {
      const impact = clamp15(dto.impact ?? r.impact);
      const probability = r.kind === 'issue' ? null : clamp15(dto.probability ?? r.probability ?? 1);
      const score = riskScore(r.kind, probability, impact);
      set.impact = impact; set.probability = probability; set.score = score; set.rag = ragFor(score);
    }
    await db.update(projectRisks).set(set).where(eq(projectRisks.id, Number(riskId)));
    const [proj] = await db.select().from(projects).where(eq(projects.id, Number(r.projectId))).limit(1);
    return this.listRisks(proj!.projectCode);
  }

  // Portfolio top-risks roll-up (Track A tie-in): every open risk/issue across the caller's projects, ranked by
  // score; `high` are the red (HIGH) ones and `unmitigated_high` the subset with no mitigation plan (PROJ-08).
  async topRisks(_user: JwtUser) {
    const db = this.db;
    const rows = (await db.select().from(projectRisks).where(sql`${projectRisks.status} <> 'closed'`)).map(shapeRisk);
    const projRows = await db.select().from(projects);
    const pById = new Map<number, any>(projRows.map((p: any) => [Number(p.id), p]));
    const enriched = rows
      .map((r: any) => ({ ...r, project_code: pById.get(r.project_id)?.projectCode ?? null, project_name: pById.get(r.project_id)?.name ?? null }))
      .sort((a: any, b: any) => b.score - a.score);
    const high = enriched.filter((r: any) => r.rag === 'red');
    return {
      as_of: ymd(), open_count: enriched.length, high_count: high.length,
      unmitigated_high_count: high.filter((r: any) => !r.mitigation).length,
      top: enriched.slice(0, 20),
    };
  }
}
