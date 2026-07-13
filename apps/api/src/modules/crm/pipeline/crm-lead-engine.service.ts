import { BadRequestException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import type { DrizzleDb } from '../../../database/database.module';
import { crmLeads, crmOpportunities, crmActivities, crmLeadScores, crmFollowupSettings, notifications } from '../../../database/schema';
import { n } from '../../../database/queries';
import type { JwtUser } from './../../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

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

// The facade's lead lookup + automation-event primitives arrive as callback ports (docs/38 pattern) so
// this class never imports the facade at runtime.
export interface LeadEnginePorts {
  leadByNo(leadNo: string, user: JwtUser): Promise<any>;
  emitEvent(event: string, payload: Record<string, any>, user: JwtUser): Promise<void>;
}

// docs/46 Phase 4b cut 3 — the CRM-4 lead ENGINE (explainable scoring, follow-up discipline settings +
// round-robin assignment, the REV-22 follow-up center and its schedulable sweep), moved VERBATIM out of
// crm-pipeline.service.ts. A plain class constructed in the CrmPipelineService constructor BODY; the facade
// keeps thin delegators, so the public API — and the crm_followup_digest BI provider — are byte-identical.
export class CrmLeadEngineService {
  constructor(private readonly db: DrizzleDb, private readonly ports: LeadEnginePorts) {}

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
    const l = await this.ports.leadByNo(leadNo, user);
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
    await this.ports.leadByNo(leadNo, user); // tenant guard + existence
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

  // Pick the next round-robin owner and advance the cursor (null when none configured). Public: the
  // facade's createLead also rotates the same cursor for auto-assignment.
  async nextRoundRobinOwner(_user: JwtUser): Promise<string | null> {
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
    const l = await this.ports.leadByNo(leadNo, user);
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
      await this.ports.emitEvent('lead.stagnant', { lead_no: b.ref, name: b.meta.name ?? b.ref, owner: b.owner, source: b.meta.source ?? null, hours_since_created: b.meta.hours_since_created ?? null, sla_hours: center.sla_hours }, user);
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
}
