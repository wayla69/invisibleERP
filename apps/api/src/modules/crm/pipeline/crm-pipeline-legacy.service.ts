import { BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../../database/database.module';
import { crmOpportunities, crmActivities } from '../../../database/schema';
import { pipelineStages } from '../../../database/schema/pipeline';
import { docCountersTenant } from '../../../database/schema/system';
import { n, fx } from '../../../database/queries';
import type { JwtUser } from './../../../common/decorators';
import type { StageRow } from './crm-pipeline.service';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

// The facade's stage-machine primitives arrive as callback ports (docs/38 pattern) so this class never
// imports the facade at runtime — the StageRow type import above is type-only (erased at compile time).
export interface PipelineLegacyPorts {
  listStages(user: JwtUser): Promise<StageRow[]>;
  legacyNameOf(stage: StageRow): string;
  statusOf(stage: StageRow): 'Open' | 'Won' | 'Lost';
  recordStage(tenantId: number | null, opportunityId: number, fromStage: string | null, toStage: string, username: string): Promise<void>;
  userIdByUsername(username: string | null | undefined): Promise<number | null>;
  emitEvent(event: string, payload: Record<string, any>, user: JwtUser): Promise<void>;
}

// docs/46 Phase 4b cut 2 — the legacy /api/pipeline ADAPTER cluster (Batch 2A routes preserved; ONE write
// path — the unified crm_opportunities spine, per CRM-1), moved VERBATIM out of crm-pipeline.service.ts.
// A plain class constructed in the CrmPipelineService constructor BODY; the facade keeps thin delegators,
// so PipelineService (the /api/pipeline controller adapter) and every response shape are byte-identical.
export class CrmPipelineLegacyService {
  constructor(private readonly db: DrizzleDb, private readonly ports: PipelineLegacyPorts) {}

  // Legacy per-tenant OPP-%05d numbering for the adapter route (disjoint from the crm route's daily format,
  // so the shared (tenant_id, opp_no) unique key can never collide across the two).
  private async nextPipelineOppNo(tenantId: number) {
    const db = this.db;
    const r = await db.insert(docCountersTenant)
      .values({ docType: 'OPP', tenantId, period: 'all', n: 1 })
      .onConflictDoUpdate({
        target: [docCountersTenant.docType, docCountersTenant.tenantId, docCountersTenant.period],
        set: { n: sql`${docCountersTenant.n} + 1` },
      }).returning({ n: docCountersTenant.n });
    return `OPP-${String(Number(r[0]!.n)).padStart(5, '0')}`;
  }

  private async oppById(id: number) {
    const db = this.db;
    const [o] = await db.select().from(crmOpportunities).where(eq(crmOpportunities.id, id)).limit(1);
    if (!o) throw new NotFoundException({ code: 'OPP_NOT_FOUND', message: `Opportunity ${id} not found` });
    return o;
  }

  async pipelineCreateOpportunity(dto: { name: string; account_name?: string; stage_name?: string; expected_value?: number; expected_close?: string; assigned_to?: string; notes?: string }, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId!;
    const oppNo = await this.nextPipelineOppNo(tenantId);
    // Resolve stage (default = first stage "Prospect"; an unknown stage_name falls back to the first stage —
    // legacy Batch 2A behaviour preserved)
    const stages = await this.ports.listStages(user);
    const stageName = dto.stage_name ?? 'Prospect';
    const stage = stages.find((s) => s.name === stageName) ?? stages[0];
    if (!stage) throw new BadRequestException({ code: 'NO_STAGES', message: 'No pipeline stages configured', messageTh: 'ยังไม่ได้ตั้งค่าขั้นตอน pipeline' });
    const owner = dto.assigned_to ?? user.username;
    const [opp] = await db.insert(crmOpportunities).values({
      tenantId, oppNo, name: dto.name,
      accountName: dto.account_name ?? null,
      stage: this.ports.legacyNameOf(stage), stageId: stage.id ?? null, status: this.ports.statusOf(stage),
      probability: stage.defaultProbability,
      amount: fx(dto.expected_value ?? 0, 2), currency: 'THB',
      expectedCloseDate: dto.expected_close ?? null,
      owner, ownerUserId: await this.ports.userIdByUsername(owner),
      notes: dto.notes ?? null, createdBy: user.username,
    }).returning();
    await this.ports.recordStage(tenantId, Number(opp!.id), null, this.ports.legacyNameOf(stage), user.username);
    return this.fmtPipelineOpp(opp, stage);
  }

  async pipelineMoveStage(oppId: number, dto: { stage_name: string }, user: JwtUser) {
    const db = this.db;
    const opp = await this.oppById(oppId);
    const stages = await this.ports.listStages(user);
    const stage = stages.find((s) => s.name === dto.stage_name);
    if (!stage) throw new BadRequestException({ code: 'STAGE_NOT_FOUND', message: `Stage '${dto.stage_name}' not found` });
    // CRM-1: won/lost are terminal on EVERY route now (REV-17 — a closed deal can't silently re-open).
    if (opp.status !== 'Open') throw new BadRequestException({ code: 'OPP_CLOSED', message: `Opportunity is already ${opp.status}`, messageTh: 'โอกาสการขายปิดแล้ว' });
    const status = this.ports.statusOf(stage);
    const set: any = { stage: this.ports.legacyNameOf(stage), stageId: stage.id ?? null, probability: stage.defaultProbability, status };
    if (status !== 'Open') set.closedAt = new Date();
    const [updated] = await db.update(crmOpportunities).set(set).where(eq(crmOpportunities.id, oppId)).returning();
    await this.ports.recordStage(opp.tenantId != null ? Number(opp.tenantId) : null, oppId, opp.stage, this.ports.legacyNameOf(stage), user.username);
    // CRM-4: emit stage-change + terminal deal events (legacy /api/pipeline route, same spine).
    await this.ports.emitEvent('opp.stage_changed', { opp_no: opp.oppNo, from_stage: opp.stage, to_stage: this.ports.legacyNameOf(stage), owner: opp.owner, amount: n(opp.amount), status }, user);
    if (status === 'Won') await this.ports.emitEvent('deal.won', { opp_no: opp.oppNo, amount: n(opp.amount), owner: opp.owner, win_reason: null }, user);
    if (status === 'Lost') await this.ports.emitEvent('deal.lost', { opp_no: opp.oppNo, amount: n(opp.amount), owner: opp.owner, lost_reason: null }, user);
    return this.fmtPipelineOpp(updated, stage);
  }

  async pipelineCloseOpportunity(oppId: number, dto: { outcome: 'Won' | 'Lost'; reason?: string }, user: JwtUser) {
    const db = this.db;
    const opp = await this.oppById(oppId);
    if (opp.status !== 'Open') throw new BadRequestException({ code: 'OPP_CLOSED', message: `Opportunity is already ${opp.status}`, messageTh: 'โอกาสการขายปิดแล้ว' });
    const stages = await this.ports.listStages(user);
    const targetStage = stages.find((s) => (dto.outcome === 'Won' ? s.isWon : s.isLost)) ?? stages[0];
    if (!targetStage) throw new BadRequestException({ code: 'NO_STAGES', message: 'No pipeline stages configured', messageTh: 'ยังไม่ได้ตั้งค่าขั้นตอน pipeline' });
    const legacyName = this.ports.legacyNameOf(targetStage);
    const set: any = { status: dto.outcome, stage: legacyName, stageId: targetStage.id ?? null, probability: targetStage.defaultProbability, closedAt: new Date() };
    if (dto.outcome === 'Won') set.winReason = dto.reason ?? null;
    if (dto.outcome === 'Lost') set.lostReason = dto.reason ?? null;
    const [updated] = await db.update(crmOpportunities).set(set).where(eq(crmOpportunities.id, oppId)).returning();
    await this.ports.recordStage(opp.tenantId != null ? Number(opp.tenantId) : null, oppId, opp.stage, legacyName, user.username);
    // CRM-4: emit stage-change + terminal deal events (legacy /api/pipeline close route).
    await this.ports.emitEvent('opp.stage_changed', { opp_no: opp.oppNo, from_stage: opp.stage, to_stage: legacyName, owner: opp.owner, amount: n(opp.amount), status: dto.outcome }, user);
    await this.ports.emitEvent(dto.outcome === 'Won' ? 'deal.won' : 'deal.lost',
      dto.outcome === 'Won'
        ? { opp_no: opp.oppNo, amount: n(opp.amount), owner: opp.owner, win_reason: dto.reason ?? null }
        : { opp_no: opp.oppNo, amount: n(opp.amount), owner: opp.owner, lost_reason: dto.reason ?? null }, user);
    return this.fmtPipelineOpp(updated, targetStage);
  }

  async pipelineListOpportunities(filter: { status?: string; stage_name?: string }, user: JwtUser) {
    const db = this.db;
    const conds: any[] = [eq(crmOpportunities.tenantId, user.tenantId!)];
    if (filter.status) conds.push(eq(crmOpportunities.status, filter.status));
    const rows = await db.select().from(crmOpportunities).where(and(...conds)).orderBy(desc(crmOpportunities.createdAt));
    return { opportunities: rows.map((o: any) => this.fmtPipelineOpp(o)), count: rows.length };
  }

  async pipelineAddActivity(oppId: number, dto: { activity_type: string; subject: string; notes?: string; activity_date?: string }, user: JwtUser) {
    const db = this.db;
    const opp = await this.oppById(oppId);
    const [act] = await db.insert(crmActivities).values({
      tenantId: opp.tenantId != null ? Number(opp.tenantId) : null,
      entityType: 'opportunity', entityNo: opp.oppNo,
      type: dto.activity_type, subject: dto.subject ?? null, notes: dto.notes ?? null,
      dueDate: dto.activity_date ?? null, done: false, owner: user.username,
      source: 'pipeline', createdBy: user.username,
    }).returning();
    return { id: Number(act!.id), activity_type: act!.type, subject: act!.subject, notes: act!.notes, activity_date: act!.dueDate, completed: act!.done === true };
  }

  async pipelineListActivities(oppId: number) {
    const db = this.db;
    const opp = await this.oppById(oppId);
    const rows = await db.select().from(crmActivities)
      .where(and(eq(crmActivities.entityType, 'opportunity'), eq(crmActivities.entityNo, opp.oppNo)))
      .orderBy(desc(crmActivities.createdAt));
    return { activities: rows.map((a: any) => ({ id: Number(a.id), activity_type: a.type, subject: a.subject, notes: a.notes, activity_date: a.dueDate, completed: a.done === true })), count: rows.length };
  }

  async pipelineForecast(user: JwtUser) {
    const db = this.db;
    const rows = await db.select({
      stageName: pipelineStages.name,
      probability: pipelineStages.defaultProbability,
      count: sql<string>`count(*)`,
      totalValue: sql<string>`coalesce(sum(${crmOpportunities.amount}),0)`,
      weightedValue: sql<string>`coalesce(sum(${crmOpportunities.amount} * ${pipelineStages.defaultProbability} / 100.0),0)`,
    }).from(crmOpportunities)
      .innerJoin(pipelineStages, eq(crmOpportunities.stageId, pipelineStages.id))
      .where(and(eq(crmOpportunities.tenantId, user.tenantId!), eq(crmOpportunities.status, 'Open')))
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

  // Legacy Batch 2A response shape (fmtOpp) mapped off the unified spine row.
  private fmtPipelineOpp(o: any, stage?: StageRow) {
    return {
      id: Number(o.id), opp_no: o.oppNo, name: o.name, account_name: o.accountName ?? null,
      stage_id: o.stageId != null ? Number(o.stageId) : null, stage_name: stage?.name ?? null,
      probability: o.probability, expected_value: n(o.amount), currency: o.currency,
      expected_close: o.expectedCloseDate, status: o.status, assigned_to: o.owner,
      win_reason: o.winReason ?? null, loss_reason: o.lostReason ?? null, notes: o.notes ?? null,
      created_by: o.createdBy, created_at: o.createdAt,
    };
  }
}
