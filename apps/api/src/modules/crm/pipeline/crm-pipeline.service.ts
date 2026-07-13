import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, or, desc, inArray, gte, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { crmLeads, crmOpportunities, crmActivities, crmAccounts, crmContacts, crmStageHistory, customerMaster, crmLeadScores, crmFollowupSettings, notifications } from '../../../database/schema';
import { pipelineStages } from '../../../database/schema/pipeline';
import { quotes } from '../../../database/schema/cpq';
import { tenants } from '../../../database/schema/tenants';
import { docCountersTenant } from '../../../database/schema/system';
import { users } from '../../../database/schema/users';
import { DocNumberService } from '../../../common/doc-number.service';
import { MessagingService } from '../../messaging/messaging.service';
import { AutomationService } from '../../automation/automation.service';
import { n, fx } from '../../../database/queries';
import { normalizeName, normalizeKey } from '../../../common/text-similarity';
import { parseCsv, parseXlsx, type ImportError } from '../../masterdata/masterdata.service';
import { newCrmThreadToken, crmThreadMark } from '../crm-thread';
import { CrmPipelineAnalyticsService } from './crm-pipeline-analytics.service';
import type { JwtUser } from './../../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

// CRM-4 (docs/41) — EXPLAINABLE, versioned rules-based lead score (v1). Not a trained model (SOX posture:
// coefficients are code-reviewed + documented, every stored score carries LEAD_SCORE_VERSION and its
// per-factor breakdown). Mirrors the customer_profiles churn/LTV formula pattern in crm.service.ts.
export const LEAD_SCORE_VERSION = 'v1';
export const LEAD_SCORE_COEFFS = {
  // source quality (fit + intent) — the strongest single signal
  source: { referral: 40, partner: 40, event: 30, expo: 30, webinar: 25, inbound: 25, web: 20, import: 10, cold: 10, purchased: 5 } as Record<string, number>,
  sourceDefault: 15,
  hasCompany: 20, noCompany: 5,   // size proxy: a company name ⇒ B2B (bigger deal potential)
  hasEmail: 10, hasPhone: 10,     // contactability
  engaged7d: 20, engaged30d: 10,  // engagement recency: a recently-touched lead is hotter
  gradeA: 70, gradeB: 50, gradeC: 30, // score → grade cut-offs (else D)
} as const;

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

// CRM sales pipeline (REV-17) — the ONE opportunity spine after the CRM-1 unification (migration 0294):
// leads → opportunities (stage machine over the tenant-configurable pipeline_stages, every transition
// audited in crm_stage_history) → activities, on the customer-of-record. Lost is terminal and requires a
// reason (crm route); won is terminal and weights to 100%. The legacy /api/pipeline routes are thin
// adapters over the same table (pipeline* methods below) — the old `opportunities` table is read-legacy.
@Injectable()
export class CrmPipelineService {
  private readonly analytics: CrmPipelineAnalyticsService;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    // CRM-4: emit pipeline events into the no-code rules engine + send deal comms. @Optional so partial
    // harnesses (and the /api/pipeline-only paths) still construct without the automation/messaging graph.
    @Optional() private readonly automation?: AutomationService,
    @Optional() private readonly messaging?: MessagingService,
  ) {
    this.analytics = new CrmPipelineAnalyticsService(db);
  }

  // CRM-4 — emit a pipeline event into the automation engine (best-effort; a rules failure never blocks the
  // write). Reuses the SAME AutomationService.runEvent path the loyalty/NPS events ride.
  private async emitEvent(event: string, payload: Record<string, any>, user: JwtUser) {
    if (!this.automation) return;
    try { await this.automation.runEvent(event, payload, user); } catch { /* best-effort */ }
  }

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
    // CRM-4: round-robin assignment per pipeline — an explicit owner wins, else rotate the configured
    // round-robin owners, else fall back to the creator.
    const owner = dto.owner ?? (await this.nextRoundRobinOwner(user)) ?? user.username;
    await db.insert(crmLeads).values({ tenantId: user.tenantId ?? null, leadNo, name: dto.name, company: dto.company ?? null, email: dto.email ?? null, phone: dto.phone ?? null, source: dto.source ?? null, status: 'new', owner, notes: dto.notes ?? null, createdBy: user.username });
    // CRM-4: score the lead (grade A–D) + emit lead.created into the automation engine.
    const score = await this.scoreLead(leadNo, user).catch(() => null);
    await this.emitEvent('lead.created', { lead_no: leadNo, name: dto.name, company: dto.company ?? null, source: dto.source ?? null, owner, grade: score?.grade ?? null }, user);
    return { lead_no: leadNo, name: dto.name, status: 'new', owner, grade: score?.grade ?? null, score: score?.score ?? null };
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
    // CRM-2 board enrichment (additive): resolve the linked account's display name/number and when the deal
    // entered its CURRENT stage (max crm_stage_history.changed_at) so the kanban can show age-in-stage.
    const accIds = [...new Set(rows.map((o: any) => o.accountId).filter((x: any) => x != null).map(Number))];
    const accRows = accIds.length
      ? await db.select({ id: crmAccounts.id, accountNo: crmAccounts.accountNo, name: crmAccounts.name }).from(crmAccounts).where(inArray(crmAccounts.id, accIds))
      : [];
    const accById = new Map(accRows.map((a: any) => [Number(a.id), a]));
    const oppIds = rows.map((o: any) => Number(o.id));
    const histRows = oppIds.length
      ? await db.select({ oppId: crmStageHistory.opportunityId, at: sql<string>`max(${crmStageHistory.changedAt})` })
          .from(crmStageHistory).where(inArray(crmStageHistory.opportunityId, oppIds)).groupBy(crmStageHistory.opportunityId)
      : [];
    const enteredAt = new Map(histRows.map((h: any) => [Number(h.oppId), h.at]));
    const opportunities = rows.map((o: any) => {
      const acc = o.accountId != null ? accById.get(Number(o.accountId)) : undefined;
      return {
        ...shapeOpp(o),
        account_no: acc?.accountNo ?? null,
        account_name: acc?.name ?? o.accountName ?? null,
        stage_entered_at: enteredAt.get(Number(o.id)) ?? o.createdAt,
      };
    });
    return { opportunities, count: rows.length };
  }

  // Deal detail (CRM-2 workspace): the opportunity + its linked account/primary contact, the append-only
  // stage-history trail, its activities (incl. the originating lead's, when converted), the CPQ quotes
  // linked on quotes.crm_opportunity_id, and the nearest undone task (the "next step").
  async getOpportunity(oppNo: string, user: JwtUser) {
    const db = this.db;
    const o = await this.oppByNo(oppNo, user);
    const [account] = o.accountId != null
      ? await db.select().from(crmAccounts).where(eq(crmAccounts.id, Number(o.accountId))).limit(1)
      : [undefined];
    const [contact] = o.primaryContactId != null
      ? await db.select().from(crmContacts).where(eq(crmContacts.id, Number(o.primaryContactId))).limit(1)
      : [undefined];
    const histRows = await db.select().from(crmStageHistory).where(eq(crmStageHistory.opportunityId, Number(o.id))).orderBy(crmStageHistory.id);
    const actConds = [and(eq(crmActivities.entityType, 'opportunity'), eq(crmActivities.entityNo, oppNo))];
    if (o.leadNo) actConds.push(and(eq(crmActivities.entityType, 'lead'), eq(crmActivities.entityNo, o.leadNo)));
    const actRows = await db.select().from(crmActivities).where(actConds.length > 1 ? or(...actConds) : actConds[0]).orderBy(desc(crmActivities.id)).limit(300);
    const quoteRows = await db.select().from(quotes).where(eq(quotes.crmOpportunityId, Number(o.id))).orderBy(desc(quotes.id)).limit(100);
    const activities = actRows.map(shapeActivity);
    const nextTask = activities
      .filter((a) => a.type === 'task' && !a.done)
      .sort((a, b) => String(a.due_date ?? '9999-12-31').localeCompare(String(b.due_date ?? '9999-12-31')))[0] ?? null;
    return {
      ...shapeOpp(o),
      account: account ? { account_no: account.accountNo, name: account.name, customer_no: account.customerNo ?? null, industry: account.industry ?? null, phone: account.phone ?? null, email: account.email ?? null } : null,
      primary_contact: contact ? { id: Number(contact.id), name: contact.name, email: contact.email ?? null, phone: contact.phone ?? null, role: contact.role } : null,
      history: histRows.map((h: any) => ({ id: Number(h.id), from_stage: h.fromStage, to_stage: h.toStage, changed_by: h.changedBy, changed_at: h.changedAt })),
      activities,
      quotes: quoteRows.map((q: any) => ({ id: Number(q.id), quote_no: q.quoteNo, status: q.status, total: n(q.total), issued_date: q.issuedDate ?? null, expires_date: q.expiresDate ?? null, created_at: q.createdAt })),
      next_task: nextTask,
    };
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
  async setStage(oppNo: string, stage: string, dto: { lost_reason?: string; win_reason?: string; probability?: number }, user: JwtUser) {
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
    if (status !== 'Open') {
      set.closedAt = new Date();
      if (status === 'Lost') set.lostReason = dto.lost_reason ?? null;
      if (status === 'Won' && dto.win_reason) set.winReason = dto.win_reason; // CRM-2: optional win note on the governed route
    }
    await db.update(crmOpportunities).set(set).where(eq(crmOpportunities.id, Number(o.id)));
    await this.recordStage(o.tenantId != null ? Number(o.tenantId) : null, Number(o.id), o.stage, legacyName, user.username);
    // CRM-4: emit stage-change + terminal deal events into the automation engine.
    await this.emitEvent('opp.stage_changed', { opp_no: oppNo, from_stage: o.stage, to_stage: legacyName, owner: o.owner, amount: n(o.amount), status }, user);
    if (status === 'Won') await this.emitEvent('deal.won', { opp_no: oppNo, amount: n(o.amount), owner: o.owner, win_reason: dto.win_reason ?? null }, user);
    if (status === 'Lost') await this.emitEvent('deal.lost', { opp_no: oppNo, amount: n(o.amount), owner: o.owner, lost_reason: dto.lost_reason ?? null }, user);
    return { opp_no: oppNo, stage: legacyName, probability: set.probability };
  }

  // Stage-transition audit trail for one opportunity (REV-17 evidence).
  async stageHistory(oppNo: string, user: JwtUser) {
    const db = this.db;
    const o = await this.oppByNo(oppNo, user);
    const rows = await db.select().from(crmStageHistory).where(eq(crmStageHistory.opportunityId, Number(o.id))).orderBy(crmStageHistory.id);
    return { opp_no: oppNo, history: rows.map((h: any) => ({ id: Number(h.id), from_stage: h.fromStage, to_stage: h.toStage, changed_by: h.changedBy, changed_at: h.changedAt })), count: rows.length };
  }

  // ── Pipeline analytics (docs/46 Phase 4b cut 1) ────────────────────────
  // The read-only analytics cluster (weighted summary, win/loss, CRM-5 funnel/velocity, source ROI,
  // forecast categories) lives in CrmPipelineAnalyticsService (ctor-BODY construction — docs/38 recipe).
  // Thin delegators keep the public API — and the BI providers riding it — byte-identical.
  pipelineSummary(user: JwtUser) { return this.analytics.pipelineSummary(user); }
  winLoss(user: JwtUser, dto?: { months?: number }) { return this.analytics.winLoss(user, dto); }
  funnel(user: JwtUser, dto?: { months?: number }) { return this.analytics.funnel(user, dto); }
  sourceRoi(user: JwtUser, dto?: { months?: number }) { return this.analytics.sourceRoi(user, dto); }
  forecast(user: JwtUser, dto?: { months?: number; quotas?: Record<string, number> }) { return this.analytics.forecast(user, dto); }

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
    return { activities: rows.map(shapeActivity), count: rows.length };
  }

  // Mark an activity done/undone (CRM-2 workspace: complete the "next step" task from the deal timeline).
  async setActivityDone(id: number, done: boolean, user: JwtUser) {
    const db = this.db;
    const conds = [eq(crmActivities.id, id)];
    if (user.tenantId != null) conds.push(eq(crmActivities.tenantId, user.tenantId));
    const [a] = await db.select().from(crmActivities).where(and(...conds)).limit(1);
    if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Activity not found', messageTh: 'ไม่พบกิจกรรมนี้' });
    const [row] = await db.update(crmActivities).set({ done }).where(eq(crmActivities.id, id)).returning();
    return shapeActivity(row);
  }

  // ── Lead capture (CRM-2) ───────────────────────────────────────────────

  // Public website-form capture → a 'web' lead. Tenant resolution: an explicit tenant_code wins; a
  // single-tenant install needs none. The caller is anonymous (no JWT) — the edge rate limiter gives this
  // path its own strict per-IP bucket (see common/edge.ts), and the controller silently drops honeypot hits
  // before this method runs. Responds { ok: true } only (no lead number leaks to the public caller).
  async webToLead(dto: { name: string; company?: string; email?: string; phone?: string; message?: string; source?: string; tenant_code?: string }) {
    const db = this.db;
    let tenantId: number | null = null;
    if (dto.tenant_code) {
      const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, dto.tenant_code)).limit(1);
      if (!t) throw new BadRequestException({ code: 'TENANT_NOT_FOUND', message: 'Unknown tenant code', messageTh: 'ไม่พบรหัสบริษัทนี้' });
      tenantId = Number(t.id);
    } else {
      const ts = await db.select({ id: tenants.id }).from(tenants).limit(2);
      if (ts.length === 1) tenantId = Number(ts[0]!.id);
      else throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'tenant_code is required on a multi-tenant install', messageTh: 'ต้องระบุ tenant_code' });
    }
    const leadNo = await this.docNo.nextDaily('LEAD');
    const source = dto.source?.trim().slice(0, 60) || 'web';
    await db.insert(crmLeads).values({
      tenantId, leadNo, name: dto.name.trim().slice(0, 200), company: dto.company?.trim().slice(0, 200) || null,
      email: dto.email?.trim().slice(0, 200) || null, phone: dto.phone?.trim().slice(0, 60) || null,
      source, status: 'new',
      notes: dto.message?.trim().slice(0, 2000) || null, createdBy: 'web-to-lead',
    });
    // CRM-4: score the inbound lead + emit lead.created (best-effort; the anonymous caller still gets { ok }).
    const sysUser = { username: 'web-to-lead', tenantId, role: 'System', customerName: null, permissions: [] } as unknown as JwtUser;
    try {
      const sc = await this.scoreLead(leadNo, sysUser);
      await this.emitEvent('lead.created', { lead_no: leadNo, name: dto.name, company: dto.company ?? null, source, owner: null, grade: sc.grade }, sysUser);
    } catch { /* best-effort */ }
    return { ok: true };
  }

  // Bulk lead import (CRM-2 wizard) — accepts csv / base64 xlsx / pre-parsed rows (the masterdata engine's
  // parsers, reused). Header contract: Name (required) + Company/Email/Phone/Source/Owner/Notes. dry_run
  // validates and reports per-row errors without writing; the commit skips invalid rows and numbers each
  // created lead through the normal LEAD- counter.
  static readonly LEAD_IMPORT_HEADERS = ['Name', 'Company', 'Email', 'Phone', 'Source', 'Owner', 'Notes'] as const;

  async importLeads(input: { format?: 'rows' | 'csv' | 'xlsx'; csv?: string; xlsx?: string; rows?: Record<string, any>[]; dry_run?: boolean }, user: JwtUser) {
    const rows: Record<string, any>[] = input.format === 'xlsx'
      ? await parseXlsx(Buffer.from(input.xlsx ?? '', 'base64'))
      : input.format === 'csv' ? parseCsv(input.csv ?? '') : (input.rows ?? []);
    if (!rows.length) throw new BadRequestException({ code: 'NO_ROWS', message: 'No rows to import', messageTh: 'ไม่มีข้อมูลให้นำเข้า' });
    if (!Object.keys(rows[0] ?? {}).includes('Name')) {
      throw new BadRequestException({ code: 'MISSING_COLUMNS', message: `Missing required column: Name`, messageTh: 'ขาดคอลัมน์ที่จำเป็น: Name' });
    }
    const errors: ImportError[] = [];
    const prepared: { rowNo: number; value: Record<string, any> }[] = [];
    rows.forEach((raw, i) => {
      const rowNo = i + 1;
      const name = String(raw['Name'] ?? '').trim();
      if (!name) { errors.push({ row: rowNo, column: 'Name', code: 'REQUIRED_EMPTY', message: `'Name' is required`, messageTh: `ต้องระบุ 'Name'` }); return; }
      const pick = (h: string, max: number) => { const v = String(raw[h] ?? '').trim(); return v ? v.slice(0, max) : null; };
      prepared.push({ rowNo, value: {
        name: name.slice(0, 200), company: pick('Company', 200), email: pick('Email', 200), phone: pick('Phone', 60),
        source: pick('Source', 60) ?? 'import', owner: pick('Owner', 60) ?? user.username, notes: pick('Notes', 2000),
      } });
    });
    if (input.dry_run) return { entity: 'crm_leads', dry_run: true, total: rows.length, valid: prepared.length, invalid: errors.length, errors };
    const db = this.db;
    // Allocate the LEAD- numbers up-front (the counter bump is atomic on its own row), then insert the
    // batch in one transaction so a mid-batch failure rolls the rows back together.
    const numbered: { leadNo: string; value: Record<string, any> }[] = [];
    for (const p of prepared) numbered.push({ leadNo: await this.docNo.nextDaily('LEAD'), value: p.value });
    let imported = 0;
    await db.transaction(async (tx: any) => {
      for (const p of numbered) {
        await tx.insert(crmLeads).values({ tenantId: user.tenantId ?? null, leadNo: p.leadNo, ...p.value, status: 'new', createdBy: user.username });
        imported++;
      }
    });
    return { entity: 'crm_leads', dry_run: false, total: rows.length, imported, skipped: rows.length - imported, errors };
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
    // CRM-4: emit stage-change + terminal deal events (legacy /api/pipeline route, same spine).
    await this.emitEvent('opp.stage_changed', { opp_no: opp.oppNo, from_stage: opp.stage, to_stage: this.legacyNameOf(stage), owner: opp.owner, amount: n(opp.amount), status }, user);
    if (status === 'Won') await this.emitEvent('deal.won', { opp_no: opp.oppNo, amount: n(opp.amount), owner: opp.owner, win_reason: null }, user);
    if (status === 'Lost') await this.emitEvent('deal.lost', { opp_no: opp.oppNo, amount: n(opp.amount), owner: opp.owner, lost_reason: null }, user);
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
    // CRM-4: emit stage-change + terminal deal events (legacy /api/pipeline close route).
    await this.emitEvent('opp.stage_changed', { opp_no: opp.oppNo, from_stage: opp.stage, to_stage: legacyName, owner: opp.owner, amount: n(opp.amount), status: dto.outcome }, user);
    await this.emitEvent(dto.outcome === 'Won' ? 'deal.won' : 'deal.lost',
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

  // Account lookup shared with createOpportunity (full accounts CRUD lives in CrmAccountsService).
  private async accountByNo(accountNo: string, user: JwtUser) {
    const db = this.db;
    const conds = [eq(crmAccounts.accountNo, accountNo)];
    if (user.tenantId != null) conds.push(eq(crmAccounts.tenantId, user.tenantId));
    const [a] = await db.select().from(crmAccounts).where(and(...conds)).limit(1);
    if (!a) throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND', message: 'Account not found', messageTh: 'ไม่พบบัญชีลูกค้า' });
    return a;
  }

  // ── CRM-4: lead scoring (explainable, versioned rules) ───────────────────
  private computeLeadScore(lead: { source: string | null; company: string | null; email: string | null; phone: string | null }, recentActivityDays: number | null) {
    const C = LEAD_SCORE_COEFFS;
    const breakdown: { factor: string; points: number; detail: string }[] = [];
    const src = String(lead.source ?? '').toLowerCase().trim();
    const srcPts = C.source[src] ?? C.sourceDefault;
    breakdown.push({ factor: 'source', points: srcPts, detail: src || 'unknown' });
    const sizePts = lead.company ? C.hasCompany : C.noCompany;
    breakdown.push({ factor: 'size', points: sizePts, detail: lead.company ? 'company (B2B)' : 'individual' });
    const emailPts = lead.email ? C.hasEmail : 0;
    breakdown.push({ factor: 'email', points: emailPts, detail: lead.email ? 'reachable' : 'no email' });
    const phonePts = lead.phone ? C.hasPhone : 0;
    breakdown.push({ factor: 'phone', points: phonePts, detail: lead.phone ? 'reachable' : 'no phone' });
    const engPts = recentActivityDays == null ? 0 : recentActivityDays <= 7 ? C.engaged7d : recentActivityDays <= 30 ? C.engaged30d : 0;
    breakdown.push({ factor: 'engagement', points: engPts, detail: recentActivityDays == null ? 'no activity' : `last touch ${recentActivityDays}d ago` });
    const score = Math.max(0, Math.min(100, srcPts + sizePts + emailPts + phonePts + engPts));
    const grade = score >= C.gradeA ? 'A' : score >= C.gradeB ? 'B' : score >= C.gradeC ? 'C' : 'D';
    return { score, grade, breakdown };
  }

  // (Re)score one lead and upsert crm_lead_scores. Idempotent on (tenant, lead) — re-scoring a lead with no
  // new signal produces the same grade. The breakdown is persisted so a rep sees WHY the lead graded A–D.
  async scoreLead(leadNo: string, user: JwtUser) {
    const db = this.db;
    const l = await this.leadByNo(leadNo, user);
    const [lastAct] = await db.select({ at: crmActivities.createdAt }).from(crmActivities)
      .where(and(eq(crmActivities.entityType, 'lead'), eq(crmActivities.entityNo, leadNo)))
      .orderBy(desc(crmActivities.createdAt)).limit(1);
    const recentDays = lastAct?.at ? Math.floor((Date.now() - new Date(lastAct.at).getTime()) / 86_400_000) : null;
    const { score, grade, breakdown } = this.computeLeadScore(l, recentDays);
    const tenantId = l.tenantId != null ? Number(l.tenantId) : (user.tenantId ?? null);
    await db.insert(crmLeadScores).values({ tenantId, leadNo, score, grade, version: LEAD_SCORE_VERSION, breakdown, scoredAt: new Date() })
      .onConflictDoUpdate({ target: [crmLeadScores.tenantId, crmLeadScores.leadNo], set: { score, grade, version: LEAD_SCORE_VERSION, breakdown, scoredAt: new Date() } });
    return { lead_no: leadNo, score, grade, version: LEAD_SCORE_VERSION, breakdown };
  }

  // Read the stored score (score on first read if none yet).
  async getLeadScore(leadNo: string, user: JwtUser) {
    const db = this.db;
    await this.leadByNo(leadNo, user); // tenant guard + existence
    const [row] = await db.select().from(crmLeadScores).where(eq(crmLeadScores.leadNo, leadNo)).limit(1);
    if (!row) return this.scoreLead(leadNo, user);
    return { lead_no: leadNo, score: Number(row.score), grade: row.grade, version: row.version, breakdown: row.breakdown ?? [], scored_at: row.scoredAt };
  }

  // ── CRM-4: follow-up discipline settings + round-robin ───────────────────
  async getFollowupSettings(_user: JwtUser) {
    const [row] = await this.db.select().from(crmFollowupSettings).limit(1); // RLS scopes to caller's tenant
    return {
      sla_hours: row ? Number(row.slaHours) : 24,
      rotting_days: row ? Number(row.rottingDays) : 7,
      round_robin_owners: (row?.roundRobinOwners as string[] | null) ?? [],
      rr_cursor: row ? Number(row.rrCursor) : 0,
      updated_by: row?.updatedBy ?? null, updated_at: row?.updatedAt ?? null,
    };
  }

  async putFollowupSettings(dto: { sla_hours?: number; rotting_days?: number; round_robin_owners?: string[] }, user: JwtUser) {
    const db = this.db;
    const owners = Array.isArray(dto.round_robin_owners) ? dto.round_robin_owners.map((o) => String(o).trim()).filter(Boolean).slice(0, 50) : undefined;
    const [existing] = await db.select().from(crmFollowupSettings).limit(1);
    const set: Record<string, unknown> = { updatedBy: user.username, updatedAt: new Date() };
    if (dto.sla_hours != null) set.slaHours = Math.max(1, Math.floor(dto.sla_hours));
    if (dto.rotting_days != null) set.rottingDays = Math.max(1, Math.floor(dto.rotting_days));
    if (owners !== undefined) { set.roundRobinOwners = owners; set.rrCursor = 0; }
    if (existing) await db.update(crmFollowupSettings).set(set).where(eq(crmFollowupSettings.id, Number(existing.id)));
    else await db.insert(crmFollowupSettings).values({ tenantId: user.tenantId ?? null, slaHours: (set.slaHours as number) ?? 24, rottingDays: (set.rottingDays as number) ?? 7, roundRobinOwners: (set.roundRobinOwners as string[]) ?? [], rrCursor: 0, updatedBy: user.username });
    return this.getFollowupSettings(user);
  }

  // Pick the next round-robin owner and advance the cursor (null when none configured).
  private async nextRoundRobinOwner(_user: JwtUser): Promise<string | null> {
    const db = this.db;
    const [row] = await db.select().from(crmFollowupSettings).limit(1);
    const owners = (row?.roundRobinOwners as string[] | null) ?? [];
    if (!row || !owners.length) return null;
    const idx = Number(row.rrCursor) % owners.length;
    await db.update(crmFollowupSettings).set({ rrCursor: (Number(row.rrCursor) + 1) % owners.length }).where(eq(crmFollowupSettings.id, Number(row.id)));
    return owners[idx] ?? null;
  }

  // Assign (or re-assign) a lead's owner — explicit owner wins, else rotate the round-robin.
  async assignLead(leadNo: string, dto: { owner?: string }, user: JwtUser) {
    const db = this.db;
    const l = await this.leadByNo(leadNo, user);
    const owner = dto.owner?.trim() || (await this.nextRoundRobinOwner(user));
    if (!owner) throw new BadRequestException({ code: 'NO_ROUND_ROBIN', message: 'No round-robin owners configured; pass an explicit owner', messageTh: 'ยังไม่ได้ตั้งค่าผู้รับผิดชอบแบบวน — โปรดระบุผู้รับผิดชอบ' });
    await db.update(crmLeads).set({ owner }).where(eq(crmLeads.id, Number(l.id)));
    return { lead_no: leadNo, owner };
  }

  // ── CRM-4: follow-up center (detective control REV-22) ───────────────────
  // ONE severity-ranked "what needs me now" worklist for the sales team, assembled from signals the pipeline
  // already produces — pure aggregation, posts nothing (mirrors the PROJ-11 action-center pattern):
  //  • SLA breach: a NEW lead untouched (no activity logged) past sla_hours (leads must be touched in time);
  //  • overdue activity: an open follow-up task whose due date has passed;
  //  • rotting deal: an OPEN opportunity with no activity for rotting_days.
  async followUpCenter(user: JwtUser, opts?: { sla_hours?: number; rotting_days?: number }) {
    const db = this.db;
    const settings = await this.getFollowupSettings(user);
    const slaHours = opts?.sla_hours != null && Number(opts.sla_hours) > 0 ? Math.floor(Number(opts.sla_hours)) : settings.sla_hours;
    const rottingDays = opts?.rotting_days != null && Number(opts.rotting_days) > 0 ? Math.floor(Number(opts.rotting_days)) : settings.rotting_days;
    const now = Date.now();
    const today = new Date(now + 7 * 3600_000).toISOString().slice(0, 10); // Asia/Bangkok business day
    const items: { kind: string; severity: 'high' | 'medium' | 'low'; ref: string; title_th: string; title_en: string; owner: string | null; as_of: string; meta: Record<string, any> }[] = [];
    const SEV_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const push = (kind: string, severity: 'high' | 'medium' | 'low', ref: string, titleTh: string, titleEn: string, owner: string | null, meta: Record<string, any> = {}) =>
      items.push({ kind, severity, ref, title_th: titleTh, title_en: titleEn, owner, as_of: today, meta });

    // 1. SLA-breached leads (REV-22): status 'new', created > sla_hours ago, no activity logged yet.
    const openLeads = await db.select().from(crmLeads).where(eq(crmLeads.status, 'new')).orderBy(desc(crmLeads.id)).limit(500);
    for (const l of openLeads) {
      const created = l.createdAt ? new Date(l.createdAt).getTime() : now;
      const hours = (now - created) / 3600_000;
      if (hours < slaHours) continue;
      const [act] = await db.select({ id: crmActivities.id }).from(crmActivities).where(and(eq(crmActivities.entityType, 'lead'), eq(crmActivities.entityNo, l.leadNo))).limit(1);
      if (act) continue; // already touched
      push('lead_sla_breach', 'high', l.leadNo, `ลีดยังไม่ถูกติดต่อเกิน SLA (${Math.floor(hours)} ชม.): ${l.name}`, `Lead untouched past SLA (${Math.floor(hours)}h): ${l.name}`, l.owner ?? null, { name: l.name, hours_since_created: Math.floor(hours), sla_hours: slaHours, source: l.source ?? null });
    }

    // 2. Overdue follow-up tasks: an open task whose due date has passed.
    const tasks = await db.select().from(crmActivities).where(and(eq(crmActivities.type, 'task'), eq(crmActivities.done, false))).orderBy(crmActivities.dueDate).limit(500);
    for (const t of tasks) {
      if (!t.dueDate || String(t.dueDate) >= today) continue;
      push('activity_overdue', 'medium', t.entityNo, `งานติดตามเลยกำหนด: ${t.subject ?? t.entityNo} (${t.dueDate})`, `Follow-up task overdue: ${t.subject ?? t.entityNo} (${t.dueDate})`, t.owner ?? null, { entity_type: t.entityType, entity_no: t.entityNo, subject: t.subject, due_date: t.dueDate });
    }

    // 3. Rotting deals: an OPEN opportunity with no activity for rotting_days.
    const openOpps = await db.select().from(crmOpportunities).where(eq(crmOpportunities.status, 'Open')).orderBy(desc(crmOpportunities.id)).limit(500);
    for (const o of openOpps) {
      const [lastAct] = await db.select({ at: crmActivities.createdAt }).from(crmActivities).where(and(eq(crmActivities.entityType, 'opportunity'), eq(crmActivities.entityNo, o.oppNo))).orderBy(desc(crmActivities.createdAt)).limit(1);
      const anchor = lastAct?.at ? new Date(lastAct.at).getTime() : (o.createdAt ? new Date(o.createdAt).getTime() : now);
      const idleDays = Math.floor((now - anchor) / 86_400_000);
      if (idleDays < rottingDays) continue;
      push('deal_rotting', 'medium', o.oppNo, `ดีลไม่มีความเคลื่อนไหว ${idleDays} วัน: ${o.name}`, `Deal idle ${idleDays}d: ${o.name}`, o.owner ?? null, { name: o.name, idle_days: idleDays, rotting_days: rottingDays, amount: n(o.amount), stage: o.stage });
    }

    items.sort((a, b) => (SEV_RANK[a.severity]! - SEV_RANK[b.severity]!) || String(a.ref).localeCompare(String(b.ref)));
    const by_kind: Record<string, number> = {};
    for (const it of items) by_kind[it.kind] = (by_kind[it.kind] ?? 0) + 1;
    const summary = {
      total: items.length,
      high: items.filter((i) => i.severity === 'high').length,
      medium: items.filter((i) => i.severity === 'medium').length,
      low: items.filter((i) => i.severity === 'low').length,
      by_kind,
    };
    return { as_of: today, sla_hours: slaHours, rotting_days: rottingDays, summary, items };
  }

  // The schedulable daily follow-up digest (BI report type crm_followup_digest). Computes the follow-up
  // center, fires lead.stagnant into the automation engine per SLA-breached lead (rules can escalate), and
  // drops a single digest notification on the alerts/notifications rail. Read-only — posts nothing to the GL.
  async runFollowUpSweep(user: JwtUser) {
    const center = await this.followUpCenter(user);
    const breaches = center.items.filter((i) => i.kind === 'lead_sla_breach');
    for (const b of breaches) {
      await this.emitEvent('lead.stagnant', { lead_no: b.ref, name: b.meta.name ?? b.ref, owner: b.owner, source: b.meta.source ?? null, hours_since_created: b.meta.hours_since_created ?? null, sla_hours: center.sla_hours }, user);
    }
    if (center.summary.total > 0) {
      const bk = center.summary.by_kind;
      try {
        await this.db.insert(notifications).values({
          targetTenantId: user.tenantId ?? null, targetRole: null,
          message: `สรุปการติดตามงานขาย: ${center.summary.total} รายการต้องดำเนินการ (ลีดเกิน SLA ${bk.lead_sla_breach ?? 0} · งานเลยกำหนด ${bk.activity_overdue ?? 0} · ดีลค้าง ${bk.deal_rotting ?? 0})`,
          messageEn: `Sales follow-up digest: ${center.summary.total} item(s) need action (SLA-breached leads ${bk.lead_sla_breach ?? 0} · overdue tasks ${bk.activity_overdue ?? 0} · rotting deals ${bk.deal_rotting ?? 0})`,
        });
      } catch { /* never throw from the notification rail */ }
    }
    return { as_of: center.as_of, total: center.summary.total, sla_breaches: breaches.length, overdue_activities: center.summary.by_kind.activity_overdue ?? 0, rotting_deals: center.summary.by_kind.deal_rotting ?? 0 };
  }

  // ── CRM-4: sales comms from the deal timeline (email / LINE via messaging, merge fields) ──────────────
  static readonly COMMS_MERGE_FIELDS = ['opp.name', 'opp.no', 'opp.amount', 'opp.stage', 'account.name', 'contact.name', 'contact.email', 'owner', 'sender'] as const;

  mergeFields() { return { fields: [...CrmPipelineService.COMMS_MERGE_FIELDS] }; }

  private commsContext(opp: any, account: any, contact: any, user: JwtUser): Record<string, string> {
    return {
      'opp.name': opp.name ?? '', 'opp.no': opp.oppNo ?? '', 'opp.amount': n(opp.amount).toLocaleString('en-US'), 'opp.stage': opp.stage ?? '',
      'account.name': account?.name ?? opp.accountName ?? '', 'contact.name': contact?.name ?? '', 'contact.email': contact?.email ?? '',
      owner: opp.owner ?? user.username, sender: user.username,
    };
  }

  // Presentation-only {{field}} substitution (document-templates merge-field style); an unknown token is left
  // verbatim so a typo is visible rather than silently dropped.
  private renderMergeFields(template: string, ctx: Record<string, string>): string {
    return String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => (k in ctx ? ctx[k]! : `{{${k}}}`));
  }

  // Send an email / LINE / SMS from a deal — merge fields resolved from the opportunity + account + contact,
  // dispatched through the existing MessagingService, and LOGGED as a timeline activity (a completed touch).
  async sendComms(oppNo: string, dto: { channel: 'email' | 'line' | 'sms'; to?: string; subject?: string; body: string; contact_id?: number }, user: JwtUser) {
    const db = this.db;
    if (!this.messaging) throw new BadRequestException({ code: 'MESSAGING_UNAVAILABLE', message: 'Messaging service not available', messageTh: 'ระบบส่งข้อความไม่พร้อมใช้งาน' });
    const o = await this.oppByNo(oppNo, user);
    const [account] = o.accountId != null ? await db.select().from(crmAccounts).where(eq(crmAccounts.id, Number(o.accountId))).limit(1) : [undefined];
    const contactId = dto.contact_id ?? (o.primaryContactId != null ? Number(o.primaryContactId) : null);
    const [contact] = contactId != null ? await db.select().from(crmContacts).where(eq(crmContacts.id, contactId)).limit(1) : [undefined];
    let to = dto.to?.trim() || null;
    if (!to && contact) to = dto.channel === 'email' ? (contact.email ?? null) : dto.channel === 'line' ? (contact.lineId ?? null) : (contact.phone ?? null);
    if (!to) throw new BadRequestException({ code: 'NO_RECIPIENT', message: `No ${dto.channel} recipient on the contact — pass an explicit 'to'`, messageTh: 'ไม่พบผู้รับสำหรับช่องทางนี้' });
    const ctx = this.commsContext(o, account, contact, user);
    const body = this.renderMergeFields(dto.body, ctx);
    const subject = dto.subject ? this.renderMergeFields(dto.subject, ctx) : null;
    // CRM-6: stamp a deterministic reply-threading token and embed it in the dispatched message (subject +
    // body footer) so an inbound reply carrying `[ref:<token>]` threads back to THIS deal even when the
    // sender replies from a different address than the one on file. Only meaningful for email today.
    const threadToken = newCrmThreadToken();
    const composed = subject ? `${subject}\n\n${body}` : body;
    const dispatchBody = dto.channel === 'email' ? `${composed}\n\n${crmThreadMark(threadToken)}` : composed;
    const dispatchSubject = dto.channel === 'email' && subject ? `${subject} ${crmThreadMark(threadToken)}` : subject;
    const res = await this.messaging.send({ to, channel: dto.channel, body: dispatchBody, campaign: 'crm_comms' }, user);
    // Log the send as a timeline activity so it shows in the deal history + Customer-360.
    await db.insert(crmActivities).values({
      tenantId: o.tenantId != null ? Number(o.tenantId) : (user.tenantId ?? null), entityType: 'opportunity', entityNo: oppNo,
      type: dto.channel === 'email' ? 'email' : 'note', subject: subject ?? `${dto.channel.toUpperCase()} → ${to}`,
      notes: body.slice(0, 2000), done: true, owner: user.username, source: 'comms', threadToken, createdBy: user.username,
    });
    return { opp_no: oppNo, channel: dto.channel, to, status: (res as { status?: string })?.status ?? 'sent', subject: dispatchSubject, body, thread_token: threadToken };
  }
}

function shapeActivity(a: any) {
  return { id: Number(a.id), entity_type: a.entityType, entity_no: a.entityNo, type: a.type, subject: a.subject, notes: a.notes, due_date: a.dueDate, done: a.done === true, owner: a.owner, created_at: a.createdAt };
}
function shapeLead(l: any) {
  return { lead_no: l.leadNo, name: l.name, company: l.company, email: l.email, phone: l.phone, source: l.source, status: l.status, owner: l.owner, customer_no: l.customerNo, lost_reason: l.lostReason, notes: l.notes, created_at: l.createdAt };
}
function shapeOpp(o: any) {
  return { opp_no: o.oppNo, customer_no: o.customerNo, name: o.name, stage: o.stage, status: o.status, stage_id: o.stageId != null ? Number(o.stageId) : null, amount: n(o.amount), currency: o.currency, probability: Number(o.probability), weighted: round2(n(o.amount) * (Number(o.probability) || 0) / 100), expected_close_date: o.expectedCloseDate, owner: o.owner, account_id: o.accountId != null ? Number(o.accountId) : null, primary_contact_id: o.primaryContactId != null ? Number(o.primaryContactId) : null, lost_reason: o.lostReason, win_reason: o.winReason ?? null, lead_no: o.leadNo, created_at: o.createdAt, closed_at: o.closedAt };
}
