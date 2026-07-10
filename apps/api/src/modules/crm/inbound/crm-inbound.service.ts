import { Inject, Injectable, Logger, UnauthorizedException, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { tenants } from '../../../database/schema/tenants';
import { crmInboundMessages, crmActivities, crmContacts, crmOpportunities, crmLeads } from '../../../database/schema/crm-pipeline';
import { verifyInboundWebhook } from '../../../common/webhook-auth';
import { TenantMessagingService } from '../../messaging/tenant-messaging.service';
import { parseCrmThreadToken } from '../crm-thread';
import type { JwtUser } from '../../../common/decorators';

// CRM-6 (docs/41 CRM-4 note): inbound email capture → CRM (the deferred 2-way side of CRM-4's outbound deal
// comms). Mirrors email-capture's AP rail — a per-tenant CRM inbound address receives customer replies; the
// provider (SendGrid Inbound Parse / Mailgun route / …) posts the parsed mail (normalized shape) to
// /api/crm/email/inbound/<tenant code> authenticated by the per-tenant email shared secret / HMAC (webhook-auth
// L-2). Each inbound is matched to an open opportunity/lead and logged as a timeline activity; an unmatched
// inbound is parked in a review queue. Append-only: never posts to the GL, never mutates a deal's stage.

// Normalized inbound-email payload — the provider-agnostic shape a SendGrid/Mailgun/Postmark inbound webhook
// maps onto. `text` is the plain-text body; the reply may carry the thread token in the subject, body, or the
// In-Reply-To / References headers.
export interface CrmInboundEmail {
  from: string;
  subject?: string;
  text?: string;
  message_id?: string;
  in_reply_to?: string;
  references?: string;
}

interface Match {
  entityType: 'opportunity' | 'lead';
  entityNo: string;
  owner: string | null;
  contactId: number | null;
  matchedBy: 'thread_token' | 'contact_email' | 'lead_email' | 'manual';
}

@Injectable()
export class CrmInboundService {
  private readonly logger = new Logger('CrmInbound');
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly tenantMsg: TenantMessagingService,
  ) {}

  private norm(email: string) { return (email ?? '').trim().toLowerCase(); }

  // ── Inbound webhook: a customer reply → matched timeline activity, else the review queue. ──
  async handleInbound(tenantCode: string, secret: string | undefined, payload: CrmInboundEmail, sig?: { rawBody?: Buffer | string; signature?: string; timestamp?: string }) {
    const [t] = await this.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, tenantCode)).limit(1);
    if (!t) throw new UnauthorizedException({ code: 'UNKNOWN_TENANT', message: 'Unknown tenant code', messageTh: 'ไม่พบรหัสบริษัท' });
    const tenantId = Number(t.id);
    this.assertSecret(await this.tenantMsg.resolveCreds(tenantId, 'email'), secret, sig);

    const from = this.norm(payload?.from ?? '');
    if (!from) return { received: true, matched: false, skipped: 'no_sender' };

    // Provider-redelivery dedupe on the Message-ID (same anchor email-capture uses).
    const msgId = String(payload?.message_id ?? '').slice(0, 200);
    if (msgId) {
      const [dup] = await this.db.select({ id: crmInboundMessages.id }).from(crmInboundMessages)
        .where(and(eq(crmInboundMessages.tenantId, tenantId), eq(crmInboundMessages.messageId, msgId))).limit(1);
      if (dup) return { received: true, matched: false, skipped: 'duplicate' };
    }

    const subject = payload?.subject ? String(payload.subject).slice(0, 500) : null;
    const text = payload?.text != null ? String(payload.text) : '';
    const bodyPreview = text.slice(0, 2000);
    const token = parseCrmThreadToken(subject, text, payload?.in_reply_to, payload?.references);

    const match = await this.resolveMatch(tenantId, from, token);
    if (match) {
      const [act] = await this.db.insert(crmActivities).values({
        tenantId, entityType: match.entityType, entityNo: match.entityNo,
        type: 'email', subject: subject ?? `Inbound email ← ${from}`, notes: bodyPreview,
        done: true, owner: match.owner ?? null, source: 'inbound', threadToken: token, createdBy: `email:${from}`,
      }).returning({ id: crmActivities.id });
      const activityId = act ? Number(act.id) : null;
      await this.log(tenantId, from, subject, bodyPreview, token, msgId, {
        matchStatus: 'matched', matchedBy: match.matchedBy, matchedEntityType: match.entityType,
        matchedEntityNo: match.entityNo, matchedContactId: match.contactId, activityId, resolved: true,
      });
      return { received: true, matched: true, matched_by: match.matchedBy, entity_type: match.entityType, entity_no: match.entityNo, activity_id: activityId };
    }

    // Unmatched → the review queue (no timeline activity is fabricated on a guessed deal).
    await this.log(tenantId, from, subject, bodyPreview, token, msgId, { matchStatus: 'unmatched', reviewReason: token ? 'unknown_thread' : 'no_match', resolved: false });
    return { received: true, matched: false, queued: true, review_reason: token ? 'unknown_thread' : 'no_match' };
  }

  // Match precedence: (1) reply-threading token → the originating activity's entity (deterministic, address-
  // independent); (2) sender address → a CRM contact → their most-recent OPEN opportunity; (3) sender address
  // → an OPEN lead. Nothing found ⇒ null (review queue).
  private async resolveMatch(tenantId: number, from: string, token: string | null): Promise<Match | null> {
    if (token) {
      const [a] = await this.db.select().from(crmActivities)
        .where(and(eq(crmActivities.tenantId, tenantId), eq(crmActivities.threadToken, token))).orderBy(desc(crmActivities.id)).limit(1);
      if (a) {
        const entityType = a.entityType === 'lead' ? 'lead' : 'opportunity';
        const owner = await this.ownerOf(tenantId, entityType, a.entityNo);
        return { entityType, entityNo: a.entityNo, owner, contactId: null, matchedBy: 'thread_token' };
      }
    }

    const [contact] = await this.db.select().from(crmContacts)
      .where(and(eq(crmContacts.tenantId, tenantId), eq(crmContacts.email, from))).orderBy(desc(crmContacts.id)).limit(1);
    if (contact) {
      const conds = [eq(crmOpportunities.tenantId, tenantId), eq(crmOpportunities.status, 'Open'), eq(crmOpportunities.primaryContactId, Number(contact.id))];
      let [opp] = await this.db.select().from(crmOpportunities).where(and(...conds)).orderBy(desc(crmOpportunities.id)).limit(1);
      if (!opp && contact.accountId != null) {
        [opp] = await this.db.select().from(crmOpportunities)
          .where(and(eq(crmOpportunities.tenantId, tenantId), eq(crmOpportunities.status, 'Open'), eq(crmOpportunities.accountId, Number(contact.accountId))))
          .orderBy(desc(crmOpportunities.id)).limit(1);
      }
      if (opp) return { entityType: 'opportunity', entityNo: opp.oppNo, owner: opp.owner ?? null, contactId: Number(contact.id), matchedBy: 'contact_email' };
    }

    const [lead] = await this.db.select().from(crmLeads)
      .where(and(eq(crmLeads.tenantId, tenantId), eq(crmLeads.email, from))).orderBy(desc(crmLeads.id)).limit(1);
    if (lead && (lead.status === 'new' || lead.status === 'qualified')) {
      return { entityType: 'lead', entityNo: lead.leadNo, owner: lead.owner ?? null, contactId: contact ? Number(contact.id) : null, matchedBy: 'lead_email' };
    }
    return null;
  }

  private async ownerOf(tenantId: number, entityType: 'opportunity' | 'lead', entityNo: string): Promise<string | null> {
    if (entityType === 'opportunity') {
      const [o] = await this.db.select({ owner: crmOpportunities.owner }).from(crmOpportunities)
        .where(and(eq(crmOpportunities.tenantId, tenantId), eq(crmOpportunities.oppNo, entityNo))).limit(1);
      return o?.owner ?? null;
    }
    const [l] = await this.db.select({ owner: crmLeads.owner }).from(crmLeads)
      .where(and(eq(crmLeads.tenantId, tenantId), eq(crmLeads.leadNo, entityNo))).limit(1);
    return l?.owner ?? null;
  }

  private async log(tenantId: number, from: string, subject: string | null, bodyPreview: string, token: string | null, msgId: string, extra: Record<string, unknown>) {
    try {
      await this.db.insert(crmInboundMessages).values({
        tenantId, fromAddr: from, subject, bodyPreview, threadToken: token,
        messageId: msgId || null, createdBy: `email:${from}`, ...extra,
      });
    } catch (e) { this.logger.warn(`crm inbound log failed: ${(e as { message?: string })?.message ?? e}`); }
  }

  // ── Review queue (authenticated CRM surface) ──────────────────────────────
  async reviewQueue(user: JwtUser) {
    const rows = await this.db.select().from(crmInboundMessages)
      .where(and(eq(crmInboundMessages.matchStatus, 'unmatched'), eq(crmInboundMessages.resolved, false)))
      .orderBy(desc(crmInboundMessages.id)).limit(200);
    void user;
    return { messages: rows.map(shapeInbound), count: rows.length };
  }

  async listRecent(user: JwtUser, limit = 100) {
    const rows = await this.db.select().from(crmInboundMessages).orderBy(desc(crmInboundMessages.id)).limit(Math.min(Math.max(limit, 1), 500));
    void user;
    return { messages: rows.map(shapeInbound), count: rows.length };
  }

  // Manually attach a queued inbound message to an opportunity/lead — logs the timeline activity that the
  // automatic matcher couldn't, and resolves the queue item. The linker is the maker (createdBy on the
  // activity); a plain triage action, not a segregated approval.
  async link(id: number, dto: { entity_type: 'opportunity' | 'lead'; entity_no: string }, user: JwtUser) {
    const conds = [eq(crmInboundMessages.id, id)];
    if (user.tenantId != null) conds.push(eq(crmInboundMessages.tenantId, user.tenantId));
    const [msg] = await this.db.select().from(crmInboundMessages).where(and(...conds)).limit(1);
    if (!msg) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Inbound message not found', messageTh: 'ไม่พบข้อความขาเข้า' });
    if (msg.resolved) throw new BadRequestException({ code: 'ALREADY_RESOLVED', message: 'Message already resolved', messageTh: 'ข้อความนี้ถูกจัดการแล้ว' });
    const tenantId = user.tenantId ?? (msg.tenantId != null ? Number(msg.tenantId) : null);
    const owner = tenantId != null ? await this.ownerOf(tenantId, dto.entity_type, dto.entity_no) : null;
    const [act] = await this.db.insert(crmActivities).values({
      tenantId, entityType: dto.entity_type, entityNo: dto.entity_no,
      type: 'email', subject: msg.subject ?? `Inbound email ← ${msg.fromAddr}`, notes: msg.bodyPreview,
      done: true, owner, source: 'inbound', threadToken: msg.threadToken ?? null, createdBy: user.username,
    }).returning({ id: crmActivities.id });
    const activityId = act ? Number(act.id) : null;
    await this.db.update(crmInboundMessages).set({
      matchStatus: 'matched', matchedBy: 'manual', matchedEntityType: dto.entity_type, matchedEntityNo: dto.entity_no,
      activityId, resolved: true, resolvedBy: user.username, resolvedAt: new Date(),
    }).where(eq(crmInboundMessages.id, id));
    return { id, matched: true, entity_type: dto.entity_type, entity_no: dto.entity_no, activity_id: activityId };
  }

  // Dismiss a queued inbound message (spam / not actionable) — resolves it without creating an activity.
  async dismiss(id: number, user: JwtUser) {
    const conds = [eq(crmInboundMessages.id, id)];
    if (user.tenantId != null) conds.push(eq(crmInboundMessages.tenantId, user.tenantId));
    const [msg] = await this.db.select().from(crmInboundMessages).where(and(...conds)).limit(1);
    if (!msg) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Inbound message not found', messageTh: 'ไม่พบข้อความขาเข้า' });
    await this.db.update(crmInboundMessages).set({ resolved: true, resolvedBy: user.username, resolvedAt: new Date(), reviewReason: 'dismissed' }).where(eq(crmInboundMessages.id, id));
    return { id, dismissed: true };
  }

  // Mirror email-capture's auth stance: a configured HMAC secret requires a valid signature over the raw body
  // (with an optional freshness timestamp); otherwise the legacy static shared-secret compare; with neither
  // configured, fail-closed in production but accept in dev/test so the feature is exercisable without creds.
  private assertSecret(creds: Record<string, unknown> | null, provided: string | undefined, sig?: { rawBody?: Buffer | string; signature?: string; timestamp?: string }) {
    const staticSecret = creds?.secret as string | undefined;
    const hmacSecret = (creds?.hmac_secret ?? creds?.hmacSecret) as string | undefined;
    const auth = verifyInboundWebhook({ rawBody: sig?.rawBody, staticSecret, providedSecret: provided, hmacSecret, signature: sig?.signature, timestamp: sig?.timestamp });
    if (auth === 'stale') throw new UnauthorizedException({ code: 'WEBHOOK_STALE', message: 'Inbound timestamp outside the allowed window (possible replay)', messageTh: 'เวลาของ inbound หมดอายุ (อาจเป็นการส่งซ้ำ)' });
    if (auth === 'bad') throw new UnauthorizedException({ code: 'BAD_INBOUND_SECRET', message: 'Invalid inbound secret', messageTh: 'รหัสยืนยัน inbound ไม่ถูกต้อง' });
    if (auth === 'unconfigured') {
      if (process.env.NODE_ENV === 'production') throw new UnauthorizedException({ code: 'INBOUND_UNVERIFIED', message: 'CRM email inbound secret not configured', messageTh: 'ยังไม่ได้ตั้งค่ารหัสยืนยัน inbound' });
      this.logger.warn('crm email inbound accepted UNVERIFIED (no secret; dev/test only)');
    }
  }
}

function shapeInbound(m: typeof crmInboundMessages.$inferSelect) {
  return {
    id: Number(m.id), from: m.fromAddr, subject: m.subject, body_preview: m.bodyPreview, thread_token: m.threadToken,
    match_status: m.matchStatus, matched_by: m.matchedBy, matched_entity_type: m.matchedEntityType, matched_entity_no: m.matchedEntityNo,
    activity_id: m.activityId != null ? Number(m.activityId) : null, review_reason: m.reviewReason, resolved: m.resolved === true,
    resolved_by: m.resolvedBy, resolved_at: m.resolvedAt, created_at: m.createdAt,
  };
}
