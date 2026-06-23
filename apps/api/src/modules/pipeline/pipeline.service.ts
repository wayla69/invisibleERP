import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, sql, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { pipelineStages, opportunities, opportunityActivities } from '../../database/schema/pipeline';
import { docCountersTenant } from '../../database/schema/system';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

// Default stages seeded per-tenant on first use
const DEFAULT_STAGES = [
  { name: 'Prospect',     sequence: 1, defaultProbability: 10,  isWon: false, isLost: false },
  { name: 'Qualified',    sequence: 2, defaultProbability: 25,  isWon: false, isLost: false },
  { name: 'Proposal',     sequence: 3, defaultProbability: 50,  isWon: false, isLost: false },
  { name: 'Negotiation',  sequence: 4, defaultProbability: 75,  isWon: false, isLost: false },
  { name: 'Won',          sequence: 5, defaultProbability: 100, isWon: true,  isLost: false },
  { name: 'Lost',         sequence: 6, defaultProbability: 0,   isWon: false, isLost: true  },
];

@Injectable()
export class PipelineService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ── Stages ──

  async seedStages(tenantId: number) {
    const db = this.db as any;
    await db.insert(pipelineStages)
      .values(DEFAULT_STAGES.map((s) => ({ ...s, tenantId, isActive: true })))
      .onConflictDoNothing();
    return db.select().from(pipelineStages).where(eq(pipelineStages.tenantId, tenantId)).orderBy(pipelineStages.sequence);
  }

  async listStages(user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(pipelineStages)
      .where(and(eq(pipelineStages.tenantId, user.tenantId!), eq(pipelineStages.isActive, true)))
      .orderBy(pipelineStages.sequence);
    if (!rows.length) return this.seedStages(user.tenantId!);
    return rows;
  }

  // ── Opportunities ──

  private async nextOppNo(tenantId: number) {
    const db = this.db as any;
    const r = await db.insert(docCountersTenant)
      .values({ docType: 'OPP', tenantId, period: 'all', n: 1 })
      .onConflictDoUpdate({
        target: [docCountersTenant.docType, docCountersTenant.tenantId, docCountersTenant.period],
        set: { n: sql`${docCountersTenant.n} + 1` },
      }).returning({ n: docCountersTenant.n });
    return `OPP-${String(Number(r[0].n)).padStart(5, '0')}`;
  }

  async createOpportunity(dto: { name: string; account_name?: string; stage_name?: string; expected_value?: number; expected_close?: string; assigned_to?: string; notes?: string }, user: JwtUser) {
    const db = this.db as any;
    const tenantId = user.tenantId!;
    const oppNo = await this.nextOppNo(tenantId);

    // Resolve stage (default = first stage "Prospect")
    const stages = await this.listStages(user);
    const stageName = dto.stage_name ?? 'Prospect';
    const stage = stages.find((s: any) => s.name === stageName) ?? stages[0];
    if (!stage) throw new BadRequestException({ code: 'NO_STAGES', message: 'No pipeline stages configured', messageTh: 'ยังไม่ได้ตั้งค่าขั้นตอน pipeline' });

    const [opp] = await db.insert(opportunities).values({
      tenantId, oppNo, name: dto.name,
      accountName: dto.account_name ?? null,
      stageId: Number(stage.id),
      probability: stage.defaultProbability,
      expectedValue: fx(dto.expected_value ?? 0, 4),
      currency: 'THB',
      expectedClose: dto.expected_close ?? null,
      status: 'Open',
      assignedTo: dto.assigned_to ?? user.username,
      notes: dto.notes ?? null,
      createdBy: user.username,
    }).returning();
    return this.fmtOpp(opp, stage);
  }

  async moveStage(oppId: number, dto: { stage_name: string }, user: JwtUser) {
    const db = this.db as any;
    const opp = await this.assertOpp(oppId);
    const stages = await this.listStages(user);
    const stage = stages.find((s: any) => s.name === dto.stage_name);
    if (!stage) throw new BadRequestException({ code: 'STAGE_NOT_FOUND', message: `Stage '${dto.stage_name}' not found` });

    const status = stage.isWon ? 'Won' : stage.isLost ? 'Lost' : 'Open';
    const [updated] = await db.update(opportunities)
      .set({ stageId: Number(stage.id), probability: stage.defaultProbability, status, updatedAt: new Date() })
      .where(eq(opportunities.id, oppId)).returning();
    return this.fmtOpp(updated, stage);
  }

  async closeOpportunity(oppId: number, dto: { outcome: 'Won' | 'Lost'; reason?: string }, user: JwtUser) {
    const db = this.db as any;
    const stages = await this.listStages(user);
    const targetStage = stages.find((s: any) => dto.outcome === 'Won' ? s.isWon : s.isLost) ?? stages[0];
    if (!targetStage) throw new BadRequestException({ code: 'NO_STAGES', message: 'No pipeline stages configured', messageTh: 'ยังไม่ได้ตั้งค่าขั้นตอน pipeline' });
    const set: any = { status: dto.outcome, stageId: Number(targetStage.id), probability: targetStage.defaultProbability, updatedAt: new Date() };
    if (dto.outcome === 'Won') set.winReason = dto.reason ?? null;
    if (dto.outcome === 'Lost') set.lossReason = dto.reason ?? null;
    const [updated] = await db.update(opportunities).set(set).where(eq(opportunities.id, oppId)).returning();
    return this.fmtOpp(updated, targetStage);
  }

  async listOpportunities(filter: { status?: string; stage_name?: string }, user: JwtUser) {
    const db = this.db as any;
    const conds: any[] = [eq(opportunities.tenantId, user.tenantId!)];
    if (filter.status) conds.push(eq(opportunities.status, filter.status));
    const rows = await db.select().from(opportunities).where(and(...conds)).orderBy(desc(opportunities.createdAt));
    return { opportunities: rows.map((o: any) => this.fmtOpp(o)), count: rows.length };
  }

  // ── Activities ──

  async addActivity(oppId: number, dto: { activity_type: string; subject: string; notes?: string; activity_date?: string }, user: JwtUser) {
    const db = this.db as any;
    await this.assertOpp(oppId);
    const [act] = await db.insert(opportunityActivities).values({
      oppId, activityType: dto.activity_type, subject: dto.subject,
      notes: dto.notes ?? null, activityDate: dto.activity_date ?? null,
      completed: false, createdBy: user.username,
    }).returning();
    return { id: Number(act.id), activity_type: act.activityType, subject: act.subject, notes: act.notes, activity_date: act.activityDate, completed: act.completed };
  }

  async listActivities(oppId: number) {
    const db = this.db as any;
    const rows = await db.select().from(opportunityActivities).where(eq(opportunityActivities.oppId, oppId)).orderBy(desc(opportunityActivities.createdAt));
    return { activities: rows.map((a: any) => ({ id: Number(a.id), activity_type: a.activityType, subject: a.subject, notes: a.notes, activity_date: a.activityDate, completed: a.completed })), count: rows.length };
  }

  // ── Forecast ──

  async forecast(user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select({
      stageName: pipelineStages.name,
      probability: pipelineStages.defaultProbability,
      count: sql<string>`count(*)`,
      totalValue: sql<string>`coalesce(sum(${opportunities.expectedValue}),0)`,
      weightedValue: sql<string>`coalesce(sum(${opportunities.expectedValue} * ${pipelineStages.defaultProbability} / 100.0),0)`,
    }).from(opportunities)
      .innerJoin(pipelineStages, eq(opportunities.stageId, pipelineStages.id))
      .where(and(eq(opportunities.tenantId, user.tenantId!), eq(opportunities.status, 'Open')))
      .groupBy(pipelineStages.name, pipelineStages.sequence, pipelineStages.defaultProbability)
      .orderBy(pipelineStages.sequence);

    return {
      by_stage: rows.map((r: any) => ({
        stage: r.stageName, probability: r.probability,
        count: Number(r.count), total_value: round4(n(r.totalValue)),
        weighted_value: round4(n(r.weightedValue)),
      })),
      total_pipeline: round4(rows.reduce((s: number, r: any) => s + n(r.totalValue), 0)),
      weighted_pipeline: round4(rows.reduce((s: number, r: any) => s + n(r.weightedValue), 0)),
    };
  }

  private async assertOpp(id: number) {
    const db = this.db as any;
    const [o] = await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1);
    if (!o) throw new NotFoundException({ code: 'OPP_NOT_FOUND', message: `Opportunity ${id} not found` });
    return o;
  }

  private fmtOpp(o: any, stage?: any) {
    return {
      id: Number(o.id), opp_no: o.oppNo, name: o.name, account_name: o.accountName,
      stage_id: o.stageId ? Number(o.stageId) : null, stage_name: stage?.name ?? null,
      probability: o.probability, expected_value: n(o.expectedValue), currency: o.currency,
      expected_close: o.expectedClose, status: o.status, assigned_to: o.assignedTo,
      win_reason: o.winReason, loss_reason: o.lossReason, notes: o.notes,
      created_by: o.createdBy, created_at: o.createdAt,
    };
  }
}
