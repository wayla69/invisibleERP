import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { crmLeads, crmOpportunities, crmActivities, crmAccounts, crmContacts, crmStageHistory, customerMaster } from '../../../database/schema';
import { pipelineStages } from '../../../database/schema/pipeline';
import { docCountersTenant } from '../../../database/schema/system';
import { users } from '../../../database/schema/users';
import { DocNumberService } from '../../../common/doc-number.service';
import { n, fx } from '../../../database/queries';
import { normalizeName, normalizeKey } from '../../../common/text-similarity';
import type { JwtUser } from './../../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

// Default stages seeded per-tenant on first use (CRM-1 unification: the ONE stage master is the
// tenant-configurable pipeline_stages; these six defaults mirror the pre-0293 hardcoded machine).
const DEFAULT_STAGES = [
  { name: 'Prospect',     sequence: 1, defaultProbability: 10,  isWon: false, isLost: false },
  { name: 'Qualified',    sequence: 2, defaultProbability: 25,  isWon: false, isLost: false },
  { name: 'Proposal',     sequence: 3, defaultProbability: 50,  isWon: false, isLost: false },
  { name: 'Negotiation',  sequence: 4, defaultProbability: 75,  isWon: false, isLost: false },
  { name: 'Won',          sequence: 5, defaultProbability: 100, isWon: true,  isLost: false },
  { name: 'Lost',         sequence: 6, defaultProbability: 0,   isWon: false, isLost: true  },
];
// The legacy REV-17 lowercase stage strings ↔ the default stage names. The legacy `stage` column stays in
// sync (back-compat for every reader/harness pinned to the lowercase machine); a custom tenant stage syncs
// its own name into `stage`.
const STAGE_NAME_BY_LEGACY: Record<string, string> = {
  prospecting: 'Prospect', qualification: 'Qualified', proposal: 'Proposal',
  negotiation: 'Negotiation', won: 'Won', lost: 'Lost',
};
const LEGACY_BY_STAGE_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(STAGE_NAME_BY_LEGACY).map(([legacy, name]) => [name, legacy]));

type StageRow = { id: number | null; name: string; sequence: number; defaultProbability: number; isWon: boolean | null; isLost: boolean | null; isActive?: boolean | null; tenantId?: number | null };

// CRM sales pipeline (REV-17) — the ONE opportunity spine after the CRM-1 unification (migration 0293):
// leads → opportunities (stage machine over the tenant-configurable pipeline_stages, every transition
// audited in crm_stage_history) → activities, on the customer-of-record. Lost is terminal and requires a
// reason (crm route); won is terminal and weights to 100%. The legacy /api/pipeline routes are thin
// adapters over the same table (pipeline* methods below) — the old `opportunities` table is read-legacy.
@Injectable()
export class CrmPipelineService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly docNo: DocNumberService) {}

  // ── Stages (tenant-configurable master; seeded on first use) ───────────
  async seedStages(tenantId: number) {
    const db = this.db;
    await db.insert(pipelineStages)
      .values(DEFAULT_STAGES.map((s) => ({ ...s, tenantId, isActive: true })))
      .onConflictDoNothing();
    return db.select().from(pipelineStages).where(eq(pipelineStages.tenantId, tenantId)).orderBy(pipelineStages.sequence);
  }

  // Raw stage rows for the tenant (the /api/pipeline/stages contract: a bare array of DB rows). A user
  // without a tenant (HQ god) gets the in-memory defaults (id null — the stage machine still runs off the
  // legacy stage strings for those rows).
  async listStages(user: JwtUser): Promise<StageRow[]> {
    if (user.tenantId == null) return DEFAULT_STAGES.map((s, i) => ({ ...s, id: null, isActive: true, tenantId: null, sequence: i + 1 }));
    const db = this.db;
    const rows = await db.select().from(pipelineStages)
      .where(and(eq(pipelineStages.tenantId, user.tenantId), eq(pipelineStages.isActive, true)))
      .orderBy(pipelineStages.sequence);
    if (!rows.length) return this.seedStages(user.tenantId) as Promise<StageRow[]>;
    return rows as StageRow[];
  }

  // Resolve a stage by its configured name OR its legacy lowercase alias ('proposal' → 'Proposal').
  private resolveStage(stages: StageRow[], input: string): StageRow | undefined {
    const byAlias = STAGE_NAME_BY_LEGACY[input];
    return stages.find((s) => s.name === input)
      ?? (byAlias ? stages.find((s) => s.name === byAlias) : undefined)
      ?? stages.find((s) => s.name.toLowerCase() === input.toLowerCase());
  }

  private legacyNameOf(stage: StageRow): string { return LEGACY_BY_STAGE_NAME[stage.name] ?? stage.name; }
  private statusOf(stage: StageRow): 'Open' | 'Won' | 'Lost' { return stage.isWon ? 'Won' : stage.isLost ? 'Lost' : 'Open'; }

  // Append-only stage audit (REV-17): creation (fromStage null) + every transition, both routes.
  private async recordStage(tenantId: number | null, opportunityId: number, fromStage: string | null, toStage: string, username: string) {
    await this.db.insert(crmStageHistory).values({ tenantId, opportunityId, fromStage, toStage, changedBy: username });
  }

  private async userIdByUsername(username: string | null | undefined): Promise<number | null> {
    if (!username) return null;
    const [u] = await this.db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    return u ? Number(u.id) : null;
  }

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

  // Find-or-create the CRM account for a converting lead (matched on the normalised company name within
  // the tenant — the full duplicate-governance 409 lives on the explicit /api/crm/accounts create).
  private async ensureAccountForLead(l: { name: string; company: string | null; email: string | null; phone: string | null }, customerNo: string | null, user: JwtUser) {
    const db = this.db;
    const name = l.company || l.name;
    const key = normalizeName(name);
    const conds = [eq(crmAccounts.status, 'active')];
    if (user.tenantId != null) conds.push(eq(crmAccounts.tenantId, user.tenantId));
    const rows = await db.select().from(crmAccounts).where(and(...conds)).orderBy(desc(crmAccounts.id)).limit(500);
    const existing = rows.find((a: any) => normalizeName(a.name) === key);
    if (existing) {
      if (customerNo && !existing.customerNo) await db.update(crmAccounts).set({ customerNo }).where(eq(crmAccounts.id, Number(existing.id)));
      return existing;
    }
    const accountNo = await this.docNo.nextDaily('ACC');
    const ownerUserId = await this.userIdByUsername(user.username);
    const [created] = await db.insert(crmAccounts).values({
      tenantId: user.tenantId ?? null, accountNo, name, email: l.email ?? null, phone: l.phone ?? null,
      customerNo: customerNo ?? null, ownerUserId, status: 'active', createdBy: user.username,
    }).returning();
    return created!;
  }

  // Find-or-create the primary contact under the account (matched on normalised email/phone, else name).
  private async ensureContactForLead(accountId: number, l: { name: string; email: string | null; phone: string | null }, user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(crmContacts).where(and(eq(crmContacts.accountId, accountId), eq(crmContacts.status, 'active'))).limit(200);
    const existing = rows.find((c: any) =>
      (l.email && normalizeKey(c.email) === normalizeKey(l.email))
      || (l.phone && normalizeKey(c.phone) === normalizeKey(l.phone))
      || normalizeName(c.name) === normalizeName(l.name));
    if (existing) return existing;
    const [created] = await db.insert(crmContacts).values({
      tenantId: user.tenantId ?? null, accountId, name: l.name, email: l.email ?? null, phone: l.phone ?? null,
      role: 'other', status: 'active', createdBy: user.username,
    }).returning();
    return created!;
  }

  // Convert a qualified lead → a customer-of-record (customer_master) + a CRM account/contact + an
  // opportunity. Idempotency: a lead already converted is rejected so it can't spawn duplicates.
  async convertLead(leadNo: string, dto: { opportunity_name?: string; amount?: number; expected_close_date?: string; customer_no?: string }, user: JwtUser) {
    const db = this.db;
    const l = await this.leadByNo(leadNo, user);
    if (l.status === 'converted') throw new BadRequestException({ code: 'LEAD_CONVERTED', message: 'Lead already converted', messageTh: 'ลีดถูกแปลงแล้ว' });
    if (l.status === 'lost') throw new BadRequestException({ code: 'LEAD_LOST', message: 'A lost lead cannot be converted', messageTh: 'ลีดที่เสียแล้วแปลงไม่ได้' });
    // attach to an existing customer-of-record, or create one from the lead
    let customerNo = dto.customer_no ?? null;
    if (!customerNo) {
      customerNo = await this.docNo.nextDaily('CUS');
      await db.insert(customerMaster).values({ tenantId: user.tenantId ?? null, customerNo, name: l.company || l.name, kind: l.company ? 'company' : 'person', email: l.email ?? null, phone: l.phone ?? null, status: 'active', notes: `Converted from ${leadNo}`, createdBy: user.username });
    }
    // CRM-1: the conversion also creates/links the account + primary contact (the CRM-side party model).
    const account = await this.ensureAccountForLead(l, customerNo, user);
    const contact = await this.ensureContactForLead(Number(account.id), l, user);
    const oppNo = await this.docNo.nextDaily('OPP');
    const stages = await this.listStages(user);
    const stage = this.resolveStage(stages, 'qualification');
    const owner = l.owner ?? user.username;
    const [opp] = await db.insert(crmOpportunities).values({
      tenantId: user.tenantId ?? null, oppNo, customerNo, name: dto.opportunity_name || `${l.company || l.name} opportunity`,
      stage: 'qualification', stageId: stage?.id ?? null, status: 'Open',
      amount: dto.amount != null ? String(dto.amount) : '0', probability: stage?.defaultProbability ?? 25,
      expectedCloseDate: dto.expected_close_date ?? null, owner, ownerUserId: await this.userIdByUsername(owner),
      accountId: Number(account.id), primaryContactId: Number(contact.id),
      leadNo, createdBy: user.username,
    }).returning({ id: crmOpportunities.id });
    await this.recordStage(user.tenantId ?? null, Number(opp!.id), null, 'qualification', user.username);
    await db.update(crmLeads).set({ status: 'converted', customerNo }).where(eq(crmLeads.id, Number(l.id)));
    return { lead_no: leadNo, status: 'converted', customer_no: customerNo, opp_no: oppNo, account_no: account.accountNo, contact_id: Number(contact.id) };
  }

  // ── Opportunities (crm route) ──────────────────────────────────────────
  async createOpportunity(dto: { name: string; customer_no?: string; amount?: number; probability?: number; expected_close_date?: string; owner?: string; account_no?: string; primary_contact_id?: number }, user: JwtUser) {
    const db = this.db;
    const oppNo = await this.docNo.nextDaily('OPP');
    const stages = await this.listStages(user);
    const stage = this.resolveStage(stages, 'prospecting');
    const owner = dto.owner ?? user.username;
    let accountId: number | null = null;
    if (dto.account_no) accountId = Number((await this.accountByNo(dto.account_no, user)).id);
    const [opp] = await db.insert(crmOpportunities).values({
      tenantId: user.tenantId ?? null, oppNo, customerNo: dto.customer_no ?? null, name: dto.name,
      stage: 'prospecting', stageId: stage?.id ?? null, status: 'Open',
      amount: dto.amount != null ? String(dto.amount) : '0', probability: dto.probability ?? stage?.defaultProbability ?? 10,
      expectedCloseDate: dto.expected_close_date ?? null, owner, ownerUserId: await this.userIdByUsername(owner),
      accountId, primaryContactId: dto.primary_contact_id ?? null, createdBy: user.username,
    }).returning({ id: crmOpportunities.id });
    await this.recordStage(user.tenantId ?? null, Number(opp!.id), null, 'prospecting', user.username);
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
  // default probability tracks the stage row (pipeline_stages.default_probability — the seeded defaults
  // mirror the legacy weights: prospecting 10 → qualification 25 → proposal 50 → negotiation 75).
  async setStage(oppNo: string, stage: string, dto: { lost_reason?: string; probability?: number }, user: JwtUser) {
    const db = this.db;
    const stages = await this.listStages(user);
    const target = this.resolveStage(stages, stage);
    if (!target) throw new BadRequestException({ code: 'BAD_STAGE', message: `Unknown stage ${stage}`, messageTh: 'สถานะไม่ถูกต้อง' });
    const o = await this.oppByNo(oppNo, user);
    if (o.status !== 'Open') throw new BadRequestException({ code: 'OPP_CLOSED', message: `Opportunity is already ${o.stage}`, messageTh: 'โอกาสการขายปิดแล้ว' });
    const legacyName = this.legacyNameOf(target);
    const status = this.statusOf(target);
    if (status === 'Lost' && !dto.lost_reason) throw new BadRequestException({ code: 'LOST_REASON_REQUIRED', message: 'A lost reason is required', messageTh: 'ต้องระบุเหตุผลที่เสียโอกาส' });
    const set: any = { stage: legacyName, stageId: target.id ?? null, status, probability: dto.probability ?? target.defaultProbability ?? o.probability };
    if (status !== 'Open') { set.closedAt = new Date(); if (status === 'Lost') set.lostReason = dto.lost_reason ?? null; }
    await db.update(crmOpportunities).set(set).where(eq(crmOpportunities.id, Number(o.id)));
    await this.recordStage(o.tenantId != null ? Number(o.tenantId) : null, Number(o.id), o.stage, legacyName, user.username);
    return { opp_no: oppNo, stage: legacyName, probability: set.probability };
  }

  // Stage-transition audit trail for one opportunity (REV-17 evidence).
  async stageHistory(oppNo: string, user: JwtUser) {
    const db = this.db;
    const o = await this.oppByNo(oppNo, user);
    const rows = await db.select().from(crmStageHistory).where(eq(crmStageHistory.opportunityId, Number(o.id))).orderBy(crmStageHistory.id);
    return { opp_no: oppNo, history: rows.map((h: any) => ({ id: Number(h.id), from_stage: h.fromStage, to_stage: h.toStage, changed_by: h.changedBy, changed_at: h.changedAt })), count: rows.length };
  }

  // Weighted pipeline forecast: open opportunities by stage (count + amount + Σ amount×probability), plus
  // won/lost totals. The weighted figure is the revenue forecast finance can rely on. Open/won/lost is
  // decided by the derived status (so a custom tenant stage flagged is_won/is_lost buckets correctly).
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
      if (o.status === 'Won') wonAmount = round2(wonAmount + amt);
      else if (o.status === 'Lost') lostAmount = round2(lostAmount + amt);
      else { openAmount = round2(openAmount + amt); weightedForecast = round2(weightedForecast + amt * prob / 100); }
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
      const amt = n(o.amount), s = o.status, owner = o.owner || 'unassigned';
      byOwner[owner] = byOwner[owner] ?? { won: 0, lost: 0, open: 0, won_amount: 0, lost_amount: 0 };
      if (s === 'Won') { byOwner[owner].won++; byOwner[owner].won_amount = round2(byOwner[owner].won_amount + amt); }
      else if (s === 'Lost') {
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
        if (s === 'Won') { byMonth[m].won++; byMonth[m].won_amount = round2(byMonth[m].won_amount + amt); }
        else if (s === 'Lost') byMonth[m].lost++;
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

  // ── /api/pipeline adapter (Batch 2A routes preserved; ONE write path — this spine) ──────────────────
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
    const stages = await this.listStages(user);
    const stageName = dto.stage_name ?? 'Prospect';
    const stage = stages.find((s) => s.name === stageName) ?? stages[0];
    if (!stage) throw new BadRequestException({ code: 'NO_STAGES', message: 'No pipeline stages configured', messageTh: 'ยังไม่ได้ตั้งค่าขั้นตอน pipeline' });
    const owner = dto.assigned_to ?? user.username;
    const [opp] = await db.insert(crmOpportunities).values({
      tenantId, oppNo, name: dto.name,
      accountName: dto.account_name ?? null,
      stage: this.legacyNameOf(stage), stageId: stage.id ?? null, status: this.statusOf(stage),
      probability: stage.defaultProbability,
      amount: fx(dto.expected_value ?? 0, 2), currency: 'THB',
      expectedCloseDate: dto.expected_close ?? null,
      owner, ownerUserId: await this.userIdByUsername(owner),
      notes: dto.notes ?? null, createdBy: user.username,
    }).returning();
    await this.recordStage(tenantId, Number(opp!.id), null, this.legacyNameOf(stage), user.username);
    return this.fmtPipelineOpp(opp, stage);
  }

  async pipelineMoveStage(oppId: number, dto: { stage_name: string }, user: JwtUser) {
    const db = this.db;
    const opp = await this.oppById(oppId);
    const stages = await this.listStages(user);
    const stage = stages.find((s) => s.name === dto.stage_name);
    if (!stage) throw new BadRequestException({ code: 'STAGE_NOT_FOUND', message: `Stage '${dto.stage_name}' not found` });
    // CRM-1: won/lost are terminal on EVERY route now (REV-17 — a closed deal can't silently re-open).
    if (opp.status !== 'Open') throw new BadRequestException({ code: 'OPP_CLOSED', message: `Opportunity is already ${opp.status}`, messageTh: 'โอกาสการขายปิดแล้ว' });
    const status = this.statusOf(stage);
    const set: any = { stage: this.legacyNameOf(stage), stageId: stage.id ?? null, probability: stage.defaultProbability, status };
    if (status !== 'Open') set.closedAt = new Date();
    const [updated] = await db.update(crmOpportunities).set(set).where(eq(crmOpportunities.id, oppId)).returning();
    await this.recordStage(opp.tenantId != null ? Number(opp.tenantId) : null, oppId, opp.stage, this.legacyNameOf(stage), user.username);
    return this.fmtPipelineOpp(updated, stage);
  }

  async pipelineCloseOpportunity(oppId: number, dto: { outcome: 'Won' | 'Lost'; reason?: string }, user: JwtUser) {
    const db = this.db;
    const opp = await this.oppById(oppId);
    if (opp.status !== 'Open') throw new BadRequestException({ code: 'OPP_CLOSED', message: `Opportunity is already ${opp.status}`, messageTh: 'โอกาสการขายปิดแล้ว' });
    const stages = await this.listStages(user);
    const targetStage = stages.find((s) => (dto.outcome === 'Won' ? s.isWon : s.isLost)) ?? stages[0];
    if (!targetStage) throw new BadRequestException({ code: 'NO_STAGES', message: 'No pipeline stages configured', messageTh: 'ยังไม่ได้ตั้งค่าขั้นตอน pipeline' });
    const legacyName = this.legacyNameOf(targetStage);
    const set: any = { status: dto.outcome, stage: legacyName, stageId: targetStage.id ?? null, probability: targetStage.defaultProbability, closedAt: new Date() };
    if (dto.outcome === 'Won') set.winReason = dto.reason ?? null;
    if (dto.outcome === 'Lost') set.lostReason = dto.reason ?? null;
    const [updated] = await db.update(crmOpportunities).set(set).where(eq(crmOpportunities.id, oppId)).returning();
    await this.recordStage(opp.tenantId != null ? Number(opp.tenantId) : null, oppId, opp.stage, legacyName, user.username);
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

  // Account lookup shared with createOpportunity (full accounts CRUD lives in CrmAccountsService).
  private async accountByNo(accountNo: string, user: JwtUser) {
    const db = this.db;
    const conds = [eq(crmAccounts.accountNo, accountNo)];
    if (user.tenantId != null) conds.push(eq(crmAccounts.tenantId, user.tenantId));
    const [a] = await db.select().from(crmAccounts).where(and(...conds)).limit(1);
    if (!a) throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND', message: 'Account not found', messageTh: 'ไม่พบบัญชีลูกค้า' });
    return a;
  }
}

function shapeLead(l: any) {
  return { lead_no: l.leadNo, name: l.name, company: l.company, email: l.email, phone: l.phone, source: l.source, status: l.status, owner: l.owner, customer_no: l.customerNo, lost_reason: l.lostReason, notes: l.notes, created_at: l.createdAt };
}
function shapeOpp(o: any) {
  return { opp_no: o.oppNo, customer_no: o.customerNo, name: o.name, stage: o.stage, status: o.status, stage_id: o.stageId != null ? Number(o.stageId) : null, amount: n(o.amount), currency: o.currency, probability: Number(o.probability), weighted: round2(n(o.amount) * (Number(o.probability) || 0) / 100), expected_close_date: o.expectedCloseDate, owner: o.owner, account_id: o.accountId != null ? Number(o.accountId) : null, primary_contact_id: o.primaryContactId != null ? Number(o.primaryContactId) : null, lost_reason: o.lostReason, win_reason: o.winReason ?? null, lead_no: o.leadNo, created_at: o.createdAt, closed_at: o.closedAt };
}
