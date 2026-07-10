import { Injectable } from '@nestjs/common';
import { CrmPipelineService } from './crm-pipeline.service';
import type { JwtUser } from '../../../common/decorators';

// Batch 2A /api/pipeline routes — CRM-1 unification (migration 0293): this service is now a THIN ADAPTER
// over the unified opportunity spine (crm_opportunities, via CrmPipelineService). Routes and DTO shapes are
// preserved exactly (opp_no OPP-%05d numbering, fmtOpp response shape, stage rows as a bare array); the old
// `opportunities` / `opportunity_activities` tables are read-legacy only — NO write path remains here.
// Behaviour deltas (conscious, REV-17): won/lost are terminal on this route too (OPP_CLOSED on move/close
// of a closed deal), and every stage transition writes crm_stage_history.
@Injectable()
export class PipelineService {
  constructor(private readonly crm: CrmPipelineService) {}

  // ── Stages ──
  seedStages(tenantId: number) { return this.crm.seedStages(tenantId); }
  listStages(user: JwtUser) { return this.crm.listStages(user); }

  // ── Opportunities ──
  createOpportunity(dto: { name: string; account_name?: string; stage_name?: string; expected_value?: number; expected_close?: string; assigned_to?: string; notes?: string }, user: JwtUser) {
    return this.crm.pipelineCreateOpportunity(dto, user);
  }
  moveStage(oppId: number, dto: { stage_name: string }, user: JwtUser) { return this.crm.pipelineMoveStage(oppId, dto, user); }
  closeOpportunity(oppId: number, dto: { outcome: 'Won' | 'Lost'; reason?: string }, user: JwtUser) { return this.crm.pipelineCloseOpportunity(oppId, dto, user); }
  listOpportunities(filter: { status?: string; stage_name?: string }, user: JwtUser) { return this.crm.pipelineListOpportunities(filter, user); }

  // ── Activities ──
  addActivity(oppId: number, dto: { activity_type: string; subject: string; notes?: string; activity_date?: string }, user: JwtUser) {
    return this.crm.pipelineAddActivity(oppId, dto, user);
  }
  listActivities(oppId: number) { return this.crm.pipelineListActivities(oppId); }

  // ── Forecast ──
  forecast(user: JwtUser) { return this.crm.pipelineForecast(user); }
}
