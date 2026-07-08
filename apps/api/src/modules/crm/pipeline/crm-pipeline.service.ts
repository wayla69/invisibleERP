import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { crmLeads, crmOpportunities, crmActivities, customerMaster } from '../../../database/schema';
import { blindIndex } from '../../../database/encrypted-column';
import { DocNumberService } from '../../../common/doc-number.service';
import { n } from '../../../database/queries';
import type { JwtUser } from './../../../common/decorators';

const STAGES = ['prospecting', 'qualification', 'proposal', 'negotiation', 'won', 'lost'] as const;
const OPEN_STAGES = ['prospecting', 'qualification', 'proposal', 'negotiation'];
const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// CRM sales pipeline (REV-17): leads → opportunities (controlled stage machine) → activities, on the
// customer-of-record. Lost is terminal and requires a reason; won is terminal and weights to 100%.
@Injectable()
export class CrmPipelineService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly docNo: DocNumberService) {}

  // ── Leads ──────────────────────────────────────────────────────────────
  async createLead(dto: { name: string; company?: string; email?: string; phone?: string; source?: string; owner?: string; notes?: string }, user: JwtUser) {
    const db = this.db;
    const leadNo = await this.docNo.nextDaily('LEAD');
    await db.insert(crmLeads).values({ tenantId: user.tenantId ?? null, leadNo, name: dto.name, company: dto.company ?? null, email: dto.email ?? null, phone: dto.phone ?? null, source: dto.source ?? null, status: 'new', owner: dto.owner ?? user.username, notes: dto.notes ?? null, createdBy: user.username });
    return { lead_no: leadNo, name: dto.name, status: 'new' };
  }

  async listLeads(status: string | undefined, _user: JwtUser) {
    const db = this.db;
    const where = status ? eq(crmLeads.status, status) : undefined;
    const rows = await db.select().from(crmLeads).where(where).orderBy(desc(crmLeads.id)).limit(300);
    return { leads: rows.map(shapeLead), count: rows.length };
  }

  private async leadByNo(leadNo: string, user: JwtUser) {
    const db = this.db;
    const conds = [eq(crmLeads.leadNo, leadNo)];
    if (user.tenantId != null) conds.push(eq(crmLeads.tenantId, user.tenantId));
    const [l] = await db.select().from(crmLeads).where(and(...conds)).limit(1);
    if (!l) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Lead not found', messageTh: 'ไม่พบลีด' });
    return l;
  }

  async qualifyLead(leadNo: string, user: JwtUser) {
    const db = this.db;
    const l = await this.leadByNo(leadNo, user);
    if (l.status === 'converted' || l.status === 'lost') throw new BadRequestException({ code: 'LEAD_CLOSED', message: 'Lead is already closed', messageTh: 'ลีดนี้ปิดแล้ว' });
    await db.update(crmLeads).set({ status: 'qualified' }).where(eq(crmLeads.id, Number(l.id)));
    return { lead_no: leadNo, status: 'qualified' };
  }

  async loseLead(leadNo: string, reason: string | undefined, user: JwtUser) {
    const db = this.db;
    const l = await this.leadByNo(leadNo, user);
    if (l.status === 'converted') throw new BadRequestException({ code: 'LEAD_CONVERTED', message: 'Lead already converted', messageTh: 'ลีดถูกแปลงแล้ว' });
    await db.update(crmLeads).set({ status: 'lost', lostReason: reason ?? null }).where(eq(crmLeads.id, Number(l.id)));
    return { lead_no: leadNo, status: 'lost' };
  }

  // Convert a qualified lead → a customer-of-record (customer_master) + an opportunity. Idempotency: a lead
  // already converted is rejected so it can't spawn duplicate customers/opportunities.
  async convertLead(leadNo: string, dto: { opportunity_name?: string; amount?: number; expected_close_date?: string; customer_no?: string }, user: JwtUser) {
    const db = this.db;
    const l = await this.leadByNo(leadNo, user);
    if (l.status === 'converted') throw new BadRequestException({ code: 'LEAD_CONVERTED', message: 'Lead already converted', messageTh: 'ลีดถูกแปลงแล้ว' });
    if (l.status === 'lost') throw new BadRequestException({ code: 'LEAD_LOST', message: 'A lost lead cannot be converted', messageTh: 'ลีดที่เสียแล้วแปลงไม่ได้' });
    // attach to an existing customer-of-record, or create one from the lead
    let customerNo = dto.customer_no ?? null;
    if (!customerNo) {
      customerNo = await this.docNo.nextDaily('CUS');
      await db.insert(customerMaster).values({ tenantId: user.tenantId ?? null, customerNo, name: l.company || l.name, kind: l.company ? 'company' : 'person', email: l.email ?? null, emailBidx: blindIndex(l.email), phone: l.phone ?? null, phoneBidx: blindIndex(l.phone), status: 'active', notes: `Converted from ${leadNo}`, createdBy: user.username });
    }
    const oppNo = await this.docNo.nextDaily('OPP');
    await db.insert(crmOpportunities).values({ tenantId: user.tenantId ?? null, oppNo, customerNo, name: dto.opportunity_name || `${l.company || l.name} opportunity`, stage: 'qualification', amount: dto.amount != null ? String(dto.amount) : '0', probability: 25, expectedCloseDate: dto.expected_close_date ?? null, owner: l.owner ?? user.username, leadNo, createdBy: user.username });
    await db.update(crmLeads).set({ status: 'converted', customerNo }).where(eq(crmLeads.id, Number(l.id)));
    return { lead_no: leadNo, status: 'converted', customer_no: customerNo, opp_no: oppNo };
  }

  // ── Opportunities ──────────────────────────────────────────────────────
  async createOpportunity(dto: { name: string; customer_no?: string; amount?: number; probability?: number; expected_close_date?: string; owner?: string }, user: JwtUser) {
    const db = this.db;
    const oppNo = await this.docNo.nextDaily('OPP');
    await db.insert(crmOpportunities).values({ tenantId: user.tenantId ?? null, oppNo, customerNo: dto.customer_no ?? null, name: dto.name, stage: 'prospecting', amount: dto.amount != null ? String(dto.amount) : '0', probability: dto.probability ?? 10, expectedCloseDate: dto.expected_close_date ?? null, owner: dto.owner ?? user.username, createdBy: user.username });
    return { opp_no: oppNo, name: dto.name, stage: 'prospecting' };
  }

  async listOpportunities(stage: string | undefined, _user: JwtUser) {
    const db = this.db;
    const where = stage ? eq(crmOpportunities.stage, stage) : undefined;
    const rows = await db.select().from(crmOpportunities).where(where).orderBy(desc(crmOpportunities.id)).limit(300);
    return { opportunities: rows.map(shapeOpp), count: rows.length };
  }

  private async oppByNo(oppNo: string, user: JwtUser) {
    const db = this.db;
    const conds = [eq(crmOpportunities.oppNo, oppNo)];
    if (user.tenantId != null) conds.push(eq(crmOpportunities.tenantId, user.tenantId));
    const [o] = await db.select().from(crmOpportunities).where(and(...conds)).limit(1);
    if (!o) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Opportunity not found', messageTh: 'ไม่พบโอกาสการขาย' });
    return o;
  }

  // Move an opportunity through the stage machine. won/lost are terminal; lost requires a reason; the
  // default probability tracks the stage (prospecting 10 → qualification 25 → proposal 50 → negotiation 75).
  async setStage(oppNo: string, stage: string, dto: { lost_reason?: string; probability?: number }, user: JwtUser) {
    const db = this.db;
    if (!STAGES.includes(stage as any)) throw new BadRequestException({ code: 'BAD_STAGE', message: `Unknown stage ${stage}`, messageTh: 'สถานะไม่ถูกต้อง' });
    const o = await this.oppByNo(oppNo, user);
    if (o.stage === 'won' || o.stage === 'lost') throw new BadRequestException({ code: 'OPP_CLOSED', message: `Opportunity is already ${o.stage}`, messageTh: 'โอกาสการขายปิดแล้ว' });
    if (stage === 'lost' && !dto.lost_reason) throw new BadRequestException({ code: 'LOST_REASON_REQUIRED', message: 'A lost reason is required', messageTh: 'ต้องระบุเหตุผลที่เสียโอกาส' });
    const stageProb: Record<string, number> = { prospecting: 10, qualification: 25, proposal: 50, negotiation: 75, won: 100, lost: 0 };
    const set: any = { stage, probability: dto.probability ?? stageProb[stage] ?? o.probability };
    if (stage === 'won' || stage === 'lost') { set.closedAt = new Date(); if (stage === 'lost') set.lostReason = dto.lost_reason ?? null; }
    await db.update(crmOpportunities).set(set).where(eq(crmOpportunities.id, Number(o.id)));
    return { opp_no: oppNo, stage, probability: set.probability };
  }

  // Weighted pipeline forecast: open opportunities by stage (count + amount + Σ amount×probability), plus
  // won/lost totals. The weighted figure is the revenue forecast finance can rely on.
  async pipelineSummary(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(crmOpportunities);
    const byStage: Record<string, { count: number; amount: number; weighted: number }> = {};
    let openAmount = 0, weightedForecast = 0, wonAmount = 0, lostAmount = 0;
    for (const o of rows) {
      const amt = n(o.amount); const prob = Number(o.probability) || 0;
      const s = o.stage;
      byStage[s] = byStage[s] ?? { count: 0, amount: 0, weighted: 0 };
      byStage[s].count++; byStage[s].amount = round2(byStage[s].amount + amt); byStage[s].weighted = round2(byStage[s].weighted + amt * prob / 100);
      if (OPEN_STAGES.includes(s)) { openAmount = round2(openAmount + amt); weightedForecast = round2(weightedForecast + amt * prob / 100); }
      else if (s === 'won') wonAmount = round2(wonAmount + amt);
      else if (s === 'lost') lostAmount = round2(lostAmount + amt);
    }
    const closed = wonAmount + lostAmount;
    return { by_stage: byStage, open_amount: openAmount, weighted_forecast: weightedForecast, won_amount: wonAmount, lost_amount: lostAmount, win_rate: closed > 0 ? round2(wonAmount / closed) : 0 };
  }

  // Win/loss analytics for the dashboard: the headline summary plus breakdowns by loss reason, by owner (with
  // each owner's win rate), and a monthly won/lost/win-rate trend — everything a sales leader needs to see why
  // deals are won or lost. Tenant-scoped by RLS.
  async winLoss(user: JwtUser, dto?: { months?: number }) {
    const db = this.db;
    const rows = await db.select().from(crmOpportunities);
    const months = Math.max(1, Math.min(24, dto?.months ?? 6));
    const lossReasons: Record<string, { count: number; amount: number }> = {};
    const byOwner: Record<string, { won: number; lost: number; open: number; won_amount: number; lost_amount: number }> = {};
    const byMonth: Record<string, { month: string; won: number; lost: number; created: number; won_amount: number }> = {};
    for (const o of rows) {
      const amt = n(o.amount), s = o.stage, owner = o.owner || 'unassigned';
      byOwner[owner] = byOwner[owner] ?? { won: 0, lost: 0, open: 0, won_amount: 0, lost_amount: 0 };
      if (s === 'won') { byOwner[owner].won++; byOwner[owner].won_amount = round2(byOwner[owner].won_amount + amt); }
      else if (s === 'lost') {
        byOwner[owner].lost++; byOwner[owner].lost_amount = round2(byOwner[owner].lost_amount + amt);
        const reason = o.lostReason || 'ไม่ระบุ (unspecified)';
        lossReasons[reason] = lossReasons[reason] ?? { count: 0, amount: 0 };
        lossReasons[reason].count++; lossReasons[reason].amount = round2(lossReasons[reason].amount + amt);
      } else byOwner[owner].open++;
      // Monthly velocity, keyed on the creation month (YYYY-MM).
      const m = o.createdAt ? new Date(o.createdAt).toISOString().slice(0, 7) : null;
      if (m) {
        byMonth[m] = byMonth[m] ?? { month: m, won: 0, lost: 0, created: 0, won_amount: 0 };
        byMonth[m].created++;
        if (s === 'won') { byMonth[m].won++; byMonth[m].won_amount = round2(byMonth[m].won_amount + amt); }
        else if (s === 'lost') byMonth[m].lost++;
      }
    }
    const loss_reasons = Object.entries(lossReasons).map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.amount - a.amount);
    const by_owner = Object.entries(byOwner).map(([owner, v]) => {
      const decided = v.won + v.lost;
      return { owner, ...v, win_rate: decided > 0 ? round2((v.won / decided) * 100) : 0 };
    }).sort((a, b) => b.won_amount - a.won_amount);
    const monthly = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)).slice(-months)
      .map((m) => ({ ...m, win_rate_pct: (m.won + m.lost) > 0 ? round2((m.won / (m.won + m.lost)) * 100) : 0 }));
    return { summary: await this.pipelineSummary(user), loss_reasons, by_owner, monthly };
  }

  // ── Activities ─────────────────────────────────────────────────────────
  async logActivity(dto: { entity_type: 'lead' | 'opportunity'; entity_no: string; type: string; subject?: string; notes?: string; due_date?: string; done?: boolean }, user: JwtUser) {
    const db = this.db;
    await db.insert(crmActivities).values({ tenantId: user.tenantId ?? null, entityType: dto.entity_type, entityNo: dto.entity_no, type: dto.type, subject: dto.subject ?? null, notes: dto.notes ?? null, dueDate: dto.due_date ?? null, done: dto.done ?? false, owner: user.username, createdBy: user.username });
    return { entity_type: dto.entity_type, entity_no: dto.entity_no, type: dto.type };
  }

  async listActivities(entityType: string | undefined, entityNo: string | undefined, _user: JwtUser) {
    const db = this.db;
    const conds: any[] = [];
    if (entityType) conds.push(eq(crmActivities.entityType, entityType));
    if (entityNo) conds.push(eq(crmActivities.entityNo, entityNo));
    const rows = await db.select().from(crmActivities).where(conds.length ? and(...conds) : undefined).orderBy(desc(crmActivities.id)).limit(300);
    return { activities: rows.map((a: any) => ({ id: Number(a.id), entity_type: a.entityType, entity_no: a.entityNo, type: a.type, subject: a.subject, notes: a.notes, due_date: a.dueDate, done: a.done === true, owner: a.owner, created_at: a.createdAt })), count: rows.length };
  }
}

function shapeLead(l: any) {
  return { lead_no: l.leadNo, name: l.name, company: l.company, email: l.email, phone: l.phone, source: l.source, status: l.status, owner: l.owner, customer_no: l.customerNo, lost_reason: l.lostReason, notes: l.notes, created_at: l.createdAt };
}
function shapeOpp(o: any) {
  return { opp_no: o.oppNo, customer_no: o.customerNo, name: o.name, stage: o.stage, amount: n(o.amount), currency: o.currency, probability: Number(o.probability), weighted: round2(n(o.amount) * (Number(o.probability) || 0) / 100), expected_close_date: o.expectedCloseDate, owner: o.owner, lost_reason: o.lostReason, lead_no: o.leadNo, created_at: o.createdAt, closed_at: o.closedAt };
}
