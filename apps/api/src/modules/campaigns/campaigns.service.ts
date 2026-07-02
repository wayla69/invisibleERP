import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { eq, and, desc, inArray, lte } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { loyaltyCampaigns, posMembers, messageLog, customerProfiles } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { resolveMessageGateway } from '../messaging/gateways';
import { SavedSegmentsService } from '../loyalty/saved-segments.service';
import { bucketPct } from '../marketing/marketing-automation.service';
import type { JwtUser } from '../../common/decorators';

// CRM Phase 4 — campaign orchestration. A segmented, optionally-scheduled broadcast over the messaging
// gateways. Sends are IDEMPOTENT (a 'sent'/cancelled campaign won't re-send — status flips under FOR UPDATE),
// respect PDPA marketing consent (opted-out members are logged 'skipped'), and audit every recipient in
// message_log (campaign = the campaign_code). EVERY query is explicitly tenant-scoped (RLS is bypassed for
// Admin / the cron sweep) — the existing ad-hoc /api/messaging/blast leans on RLS; campaigns do not.
@Injectable()
export class CampaignsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    // Saved-segment audience resolution (Phase F1) — the whitelisted/bound rule engine stays the only gate.
    private readonly savedSegments: SavedSegmentsService,
  ) {}

  private tid(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบบริบทร้านค้า' });
    return user.tenantId;
  }

  async listCampaigns(user: JwtUser, q: { status?: string } = {}) {
    const db = this.db; const tenantId = this.tid(user);
    const conds: any[] = [eq(loyaltyCampaigns.tenantId, tenantId)];
    if (q.status) conds.push(eq(loyaltyCampaigns.status, q.status));
    const rows = await db.select().from(loyaltyCampaigns).where(and(...conds)).orderBy(desc(loyaltyCampaigns.id));
    return { campaigns: rows.map(shape), count: rows.length };
  }

  async upsertCampaign(user: JwtUser, dto: any) {
    const db = this.db; const tenantId = this.tid(user);
    if (dto.audience === 'segment' && !dto.segment) throw new BadRequestException({ code: 'NO_SEGMENT', message: 'segment required for a segment campaign', messageTh: 'ต้องระบุกลุ่ม RFM' });
    if (dto.audience === 'tier' && !dto.tier) throw new BadRequestException({ code: 'NO_TIER', message: 'tier required for a tier campaign', messageTh: 'ต้องระบุระดับสมาชิก' });
    if (dto.audience === 'saved_segment') {
      if (!dto.saved_segment_id) throw new BadRequestException({ code: 'NO_SAVED_SEGMENT', message: 'saved_segment_id required for a saved-segment campaign', messageTh: 'ต้องระบุเซกเมนต์ที่บันทึกไว้' });
      // Fail fast on an unknown/foreign segment at create time (send would 404 anyway).
      await this.savedSegments.membersForSend(db, tenantId, Number(dto.saved_segment_id));
    }
    const scheduleAt = dto.schedule_at ? new Date(dto.schedule_at) : null;
    const vals: any = { name: dto.name, channel: dto.channel ?? 'sms', audience: dto.audience ?? 'all', segment: dto.segment ?? null, tier: dto.tier ?? null, savedSegmentId: dto.audience === 'saved_segment' ? Number(dto.saved_segment_id) : null, body: dto.body, variantBBody: dto.variant_b_body ?? null, splitBPct: dto.variant_b_body ? Math.min(90, Math.max(0, Number(dto.split_b_pct ?? 0))) : 0, scheduleAt, status: scheduleAt ? 'scheduled' : 'draft' };
    if (dto.id) {
      // Only an un-sent campaign may be edited.
      const [cur] = await db.select({ status: loyaltyCampaigns.status }).from(loyaltyCampaigns).where(and(eq(loyaltyCampaigns.id, dto.id), eq(loyaltyCampaigns.tenantId, tenantId))).limit(1);
      if (!cur) throw new NotFoundException({ code: 'CAMPAIGN_NOT_FOUND', message: 'Campaign not found', messageTh: 'ไม่พบแคมเปญ' });
      if (cur.status === 'sent') throw new ConflictException({ code: 'ALREADY_SENT', message: 'A sent campaign cannot be edited', messageTh: 'แคมเปญที่ส่งแล้วแก้ไขไม่ได้' });
      const [r] = await db.update(loyaltyCampaigns).set(vals).where(and(eq(loyaltyCampaigns.id, dto.id), eq(loyaltyCampaigns.tenantId, tenantId))).returning();
      return shape(r);
    }
    const campaignCode = await this.docNo.nextDaily('CMP');
    const [r] = await db.insert(loyaltyCampaigns).values({ ...vals, tenantId, campaignCode, createdBy: user.username }).returning();
    return shape(r);
  }

  async cancelCampaign(user: JwtUser, id: number) {
    const db = this.db; const tenantId = this.tid(user);
    const [r] = await db.update(loyaltyCampaigns).set({ status: 'cancelled' }).where(and(eq(loyaltyCampaigns.id, id), eq(loyaltyCampaigns.tenantId, tenantId), inArray(loyaltyCampaigns.status, ['draft', 'scheduled']))).returning();
    if (!r) throw new ConflictException({ code: 'CANNOT_CANCEL', message: 'Only a draft/scheduled campaign can be cancelled', messageTh: 'ยกเลิกได้เฉพาะแคมเปญร่าง/ตั้งเวลา' });
    return shape(r);
  }

  // Send now. At-most-once is made DURABLE by CLAIMING the campaign first: an atomic guarded UPDATE flips
  // draft|scheduled → sent and (because the route is @NoTx — auto-commit base pool) commits BEFORE any
  // gateway delivery. So a crash mid-delivery leaves the campaign 'sent' and it can NEVER re-fire (a second
  // send / the cron → 0 rows claimed → ALREADY_SENT). Delivery + each message_log audit row then also
  // auto-commit, so the audit is durable too. (Gateway sends are irreversible; we must not put them inside a
  // transaction whose rollback would re-open the campaign.)
  async sendCampaign(user: JwtUser, id: number) {
    const db = this.db; const tenantId = this.tid(user);
    const [claimed] = await db.update(loyaltyCampaigns).set({ status: 'sent', sentAt: new Date() })
      .where(and(eq(loyaltyCampaigns.id, id), eq(loyaltyCampaigns.tenantId, tenantId), inArray(loyaltyCampaigns.status, ['draft', 'scheduled']))).returning();
    if (!claimed) {
      const [c] = await db.select({ status: loyaltyCampaigns.status }).from(loyaltyCampaigns).where(and(eq(loyaltyCampaigns.id, id), eq(loyaltyCampaigns.tenantId, tenantId))).limit(1);
      if (!c) throw new NotFoundException({ code: 'CAMPAIGN_NOT_FOUND', message: 'Campaign not found', messageTh: 'ไม่พบแคมเปญ' });
      if (c.status === 'cancelled') throw new ConflictException({ code: 'CAMPAIGN_CANCELLED', message: 'Campaign was cancelled', messageTh: 'แคมเปญถูกยกเลิก' });
      throw new ConflictException({ code: 'ALREADY_SENT', message: 'Campaign already sent', messageTh: 'แคมเปญถูกส่งไปแล้ว' });
    }
    const members = await this.resolveAudience(db, tenantId, claimed);
    let sent = 0, skipped = 0, failed = 0;
    for (const m of members) {
      // Body-only A/B (G2): deterministic per-member split — same member always gets the same variant.
      const body = claimed.variantBBody && bucketPct(Number(claimed.id), Number(m.id)) < Number(claimed.splitBPct ?? 0)
        ? claimed.variantBBody : claimed.body;
      const r = await this.deliver(db, tenantId, m, claimed.channel, body, claimed.campaignCode, user.username);
      if (r === 'sent') sent++; else if (r === 'skipped') skipped++; else failed++;
    }
    await db.update(loyaltyCampaigns).set({ targeted: members.length, sentCount: sent, skippedCount: skipped, failedCount: failed }).where(and(eq(loyaltyCampaigns.id, id), eq(loyaltyCampaigns.tenantId, tenantId)));
    return { campaign_code: claimed.campaignCode, status: 'sent', targeted: members.length, sent, skipped, failed };
  }

  // Cron entry (the @NoTx run-due route, NOT the sweep's big transaction — so each claim commits durably).
  // Admin/HQ runs every tenant's due campaigns; a tenant-scoped caller runs only its own.
  async runDueAll(user: JwtUser) {
    const db = this.db;
    let tenantIds: number[];
    if (user.role === 'Admin' || user.tenantId == null) {
      const rows = await db.selectDistinct({ tid: loyaltyCampaigns.tenantId }).from(loyaltyCampaigns).where(and(eq(loyaltyCampaigns.status, 'scheduled'), lte(loyaltyCampaigns.scheduleAt, new Date())));
      tenantIds = rows.map((r: any) => Number(r.tid)).filter((x: number) => x > 0);
    } else tenantIds = [this.tid(user)];
    let totalSent = 0; const results: any[] = [];
    for (const tid of tenantIds) { const ran = await this.runDue(tid, user.username); totalSent += ran; results.push({ tenant_id: tid, campaigns_sent: ran }); }
    return { tenants_processed: tenantIds.length, campaigns_sent: totalSent, results };
  }

  // Send every scheduled campaign whose time has come, for one tenant. Best-effort per campaign (claim-first
  // means a campaign that partially sent stays 'sent' and is never re-picked).
  async runDue(tenantId: number, createdBy = 'system:campaign-cron'): Promise<number> {
    const db = this.db;
    const due = await db.select({ id: loyaltyCampaigns.id }).from(loyaltyCampaigns).where(and(eq(loyaltyCampaigns.tenantId, tenantId), eq(loyaltyCampaigns.status, 'scheduled'), lte(loyaltyCampaigns.scheduleAt, new Date())));
    let ran = 0;
    for (const d of due) {
      try { await this.sendCampaign({ tenantId, username: createdBy } as any, Number(d.id)); ran++; } catch { /* keep going */ }
    }
    return ran;
  }

  // Resolve the audience to a tenant-scoped, active member list.
  private async resolveAudience(tx: any, tenantId: number, c: any): Promise<any[]> {
    if (c.audience === 'saved_segment') {
      // Saved custom segment (Phase F1) — rules resolved at SEND time (fresh membership), tenant-scoped.
      // A segment deleted after the campaign was created resolves to an empty audience (the campaign is
      // already claimed 'sent' at this point — throwing would strand it half-delivered).
      if (!c.savedSegmentId) return [];
      try { return await this.savedSegments.membersForSend(tx, tenantId, Number(c.savedSegmentId)); } catch { return []; }
    }
    if (c.audience === 'segment') {
      const profs = await tx.select({ memberId: customerProfiles.memberId }).from(customerProfiles).where(and(eq(customerProfiles.tenantId, tenantId), eq(customerProfiles.rfmSegment, c.segment)));
      const ids = profs.map((p: any) => Number(p.memberId)).filter(Boolean);
      return ids.length ? await tx.select().from(posMembers).where(and(eq(posMembers.tenantId, tenantId), inArray(posMembers.id, ids), eq(posMembers.active, true))) : [];
    }
    if (c.audience === 'tier') {
      return await tx.select().from(posMembers).where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.tier, c.tier), eq(posMembers.active, true)));
    }
    const members = await tx.select().from(posMembers).where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.active, true)));
    if (c.audience === 'birthdays_today') {
      const bkk = new Date(Date.now() + 7 * 3600_000); const mo = bkk.getUTCMonth() + 1, day = bkk.getUTCDate();
      return members.filter((m: any) => { if (!m.birthday) return false; const d = new Date(String(m.birthday) + 'T00:00:00Z'); return d.getUTCMonth() + 1 === mo && d.getUTCDate() === day; });
    }
    return members; // 'all'
  }

  // Deliver one message (PDPA opt-out → skip) and audit it in message_log.
  private async deliver(tx: any, tenantId: number, member: any, channel: string, body: string, campaignCode: string, createdBy: string): Promise<'sent' | 'skipped' | 'failed'> {
    if (member.marketingOptIn === false) {
      await tx.insert(messageLog).values({ tenantId, memberId: Number(member.id), channel, recipient: null, body, campaign: campaignCode, status: 'skipped', provider: null, error: 'opted out', createdBy });
      return 'skipped';
    }
    const recipient = channel === 'email' ? member.email : member.phone;
    if (!recipient) {
      await tx.insert(messageLog).values({ tenantId, memberId: Number(member.id), channel, recipient: null, body, campaign: campaignCode, status: 'failed', provider: null, error: 'no contact', createdBy });
      return 'failed';
    }
    const gw = resolveMessageGateway(channel as any);
    const res = await gw.send(recipient, body);
    await tx.insert(messageLog).values({ tenantId, memberId: Number(member.id), channel, recipient, body, campaign: campaignCode, status: res.status, provider: res.provider, error: res.error ?? null, createdBy });
    return res.status === 'sent' ? 'sent' : 'failed';
  }
}

function shape(c: any) {
  return {
    id: Number(c.id), campaign_code: c.campaignCode, name: c.name, channel: c.channel, audience: c.audience,
    segment: c.segment, tier: c.tier, saved_segment_id: c.savedSegmentId != null ? Number(c.savedSegmentId) : null, body: c.body, variant_b_body: c.variantBBody ?? null, split_b_pct: Number(c.splitBPct ?? 0), schedule_at: c.scheduleAt, status: c.status,
    targeted: Number(c.targeted ?? 0), sent_count: Number(c.sentCount ?? 0), skipped_count: Number(c.skippedCount ?? 0), failed_count: Number(c.failedCount ?? 0),
    created_at: c.createdAt, sent_at: c.sentAt,
  };
}
