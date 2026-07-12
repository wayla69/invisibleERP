import { Inject, Injectable, Logger, BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { serviceCases, caseEmailMessages } from '../../database/schema/service-cases';
import { docCountersTenant } from '../../database/schema/system';
import { tenants } from '../../database/schema/tenants';
import { verifyInboundWebhook } from '../../common/webhook-auth';
import { TenantMessagingService } from '../messaging/tenant-messaging.service';
import { newCaseThreadToken, caseThreadMark, parseCaseThreadToken } from './case-thread';
import type { JwtUser } from '../../common/decorators';

// Normalized inbound-email payload (provider-agnostic SendGrid/Mailgun/Postmark shape) — same as CRM-6 inbound.
export interface CaseInboundEmail {
  from: string;
  subject?: string;
  text?: string;
  message_id?: string;
  in_reply_to?: string;
  references?: string;
}

const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
const OPEN_STATES = ['new', 'open', 'pending'] as const; // a case that can still receive work / threading

// SVC-4 — Service Cloud: Support Cases + Email-to-Case (SVC-04 control). Net-new customer-service surface,
// distinct from the #666 subscription/SLA ServiceService and the SVC-2 warranty registry. A case has a governed
// status lifecycle (new → open → pending → resolved → closed, reopen → open) and an append-only email trail; an
// Email-to-Case webhook threads a customer reply onto its case (via the per-case thread token, else the sender's
// open case) or opens a NEW case, so no inbound customer email is dropped. Append-only; no GL post in v1.
@Injectable()
export class ServiceCasesService {
  private readonly logger = new Logger('ServiceCases');
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly tenantMsg: TenantMessagingService,
  ) {}

  private norm(email: string) { return (email ?? '').trim().toLowerCase(); }

  private async nextCaseNo(tenantId: number) {
    const r = await this.db.insert(docCountersTenant)
      .values({ docType: 'CASE', tenantId, period: 'all', n: 1 })
      .onConflictDoUpdate({
        target: [docCountersTenant.docType, docCountersTenant.tenantId, docCountersTenant.period],
        set: { n: sql`${docCountersTenant.n} + 1` },
      }).returning({ n: docCountersTenant.n });
    return `CASE-${String(Number(r[0]!.n)).padStart(5, '0')}`;
  }

  // ── Authenticated Case surface ─────────────────────────────────────────────
  async listCases(user: JwtUser, status?: string) {
    const conds = [];
    if (user.tenantId != null) conds.push(eq(serviceCases.tenantId, user.tenantId));
    if (status && status !== 'all') conds.push(eq(serviceCases.status, status));
    const rows = await this.db.select().from(serviceCases)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(serviceCases.id)).limit(500);
    return { cases: rows.map(fmtCase), count: rows.length };
  }

  async getCase(user: JwtUser, id: number) {
    const c = await this.loadCase(user, id);
    const msgs = await this.db.select().from(caseEmailMessages)
      .where(eq(caseEmailMessages.caseId, c.id)).orderBy(caseEmailMessages.id);
    return { case: fmtCase(c), messages: msgs.map(fmtMsg) };
  }

  async createCase(user: JwtUser, dto: { subject: string; description?: string; priority?: string; contact_email?: string; customer_name?: string; assignee?: string }) {
    const tenantId = user.tenantId ?? null;
    const priority = PRIORITIES.includes((dto.priority ?? '') as (typeof PRIORITIES)[number]) ? dto.priority! : 'P3';
    const caseNo = await this.nextCaseNo(user.tenantId!);
    const token = newCaseThreadToken();
    const assignee = dto.assignee?.trim() || null;
    const [row] = await this.db.insert(serviceCases).values({
      tenantId, caseNo, subject: dto.subject.trim(), description: dto.description ?? null,
      status: assignee ? 'open' : 'new', priority, source: 'manual',
      contactEmail: dto.contact_email ? this.norm(dto.contact_email) : null,
      customerName: dto.customer_name ?? null, assignee, threadToken: token, createdBy: user.username,
    }).returning();
    return fmtCase(row!);
  }

  async assignCase(user: JwtUser, id: number, dto: { assignee: string }) {
    const c = await this.loadCase(user, id);
    if (c.status === 'closed') throw new BadRequestException({ code: 'CASE_CLOSED', message: `Case ${c.caseNo} is closed`, messageTh: `เคส ${c.caseNo} ปิดแล้ว` });
    const assignee = (dto.assignee ?? '').trim();
    if (!assignee) throw new BadRequestException({ code: 'ASSIGNEE_REQUIRED', message: 'Assignee is required', messageTh: 'ต้องระบุผู้รับผิดชอบ' });
    const [row] = await this.db.update(serviceCases)
      .set({ assignee, status: c.status === 'new' ? 'open' : c.status })
      .where(eq(serviceCases.id, c.id)).returning();
    return fmtCase(row!);
  }

  // Move a case to 'pending' (waiting on the customer). Allowed from an active state only.
  async setPending(user: JwtUser, id: number) {
    const c = await this.loadCase(user, id);
    if (!(OPEN_STATES as readonly string[]).includes(c.status)) throw this.notActive(c.caseNo, c.status);
    const [row] = await this.db.update(serviceCases).set({ status: 'pending' }).where(eq(serviceCases.id, c.id)).returning();
    return fmtCase(row!);
  }

  async resolveCase(user: JwtUser, id: number, dto: { note?: string }) {
    const c = await this.loadCase(user, id);
    if (!(OPEN_STATES as readonly string[]).includes(c.status)) throw this.notActive(c.caseNo, c.status);
    const [row] = await this.db.update(serviceCases)
      .set({ status: 'resolved', resolvedAt: new Date(), resolutionNote: dto.note ?? c.resolutionNote })
      .where(eq(serviceCases.id, c.id)).returning();
    return fmtCase(row!);
  }

  async closeCase(user: JwtUser, id: number) {
    const c = await this.loadCase(user, id);
    if (c.status === 'closed') throw new BadRequestException({ code: 'CASE_ALREADY_CLOSED', message: `Case ${c.caseNo} is already closed`, messageTh: `เคส ${c.caseNo} ปิดแล้ว` });
    const [row] = await this.db.update(serviceCases)
      .set({ status: 'closed', closedAt: new Date() })
      .where(eq(serviceCases.id, c.id)).returning();
    return fmtCase(row!);
  }

  async reopenCase(user: JwtUser, id: number) {
    const c = await this.loadCase(user, id);
    if (c.status !== 'resolved' && c.status !== 'closed') throw new BadRequestException({ code: 'CASE_NOT_CLOSED', message: `Case ${c.caseNo} is not resolved/closed`, messageTh: `เคส ${c.caseNo} ยังไม่ได้ปิด` });
    const [row] = await this.db.update(serviceCases)
      .set({ status: 'open', resolvedAt: null, closedAt: null })
      .where(eq(serviceCases.id, c.id)).returning();
    return fmtCase(row!);
  }

  // Record an outbound reply we send to the customer, carrying the case thread token so their reply threads back.
  async addReply(user: JwtUser, id: number, dto: { body: string; subject?: string; to?: string }) {
    const c = await this.loadCase(user, id);
    if (c.status === 'closed') throw new BadRequestException({ code: 'CASE_CLOSED', message: `Case ${c.caseNo} is closed`, messageTh: `เคส ${c.caseNo} ปิดแล้ว` });
    const token = c.threadToken ?? newCaseThreadToken();
    const subject = (dto.subject ?? `Re: ${c.subject}`).slice(0, 500);
    const body = `${dto.body}\n\n${caseThreadMark(token)}`;
    await this.db.insert(caseEmailMessages).values({
      tenantId: c.tenantId, caseId: c.id, direction: 'outbound',
      fromAddr: user.username, toAddr: dto.to ?? c.contactEmail ?? null,
      subject, bodyPreview: body.slice(0, 2000), threadToken: token, createdBy: user.username,
    });
    // Sending a reply moves a pending case back to 'open' (ball back in our court is false, but it is active).
    if (c.status === 'pending') await this.db.update(serviceCases).set({ status: 'open' }).where(eq(serviceCases.id, c.id));
    if (!c.threadToken) await this.db.update(serviceCases).set({ threadToken: token }).where(eq(serviceCases.id, c.id));
    return { case_no: c.caseNo, replied: true };
  }

  private notActive(caseNo: string, status: string) {
    return new BadRequestException({ code: 'CASE_NOT_ACTIVE', message: `Case ${caseNo} is not active (status=${status})`, messageTh: `เคส ${caseNo} ไม่อยู่ในสถานะที่ดำเนินการได้` });
  }

  private async loadCase(user: JwtUser, id: number) {
    const conds = [eq(serviceCases.id, id)];
    if (user.tenantId != null) conds.push(eq(serviceCases.tenantId, user.tenantId));
    const [c] = await this.db.select().from(serviceCases).where(and(...conds)).limit(1);
    if (!c) throw new NotFoundException({ code: 'CASE_NOT_FOUND', message: 'Case not found', messageTh: 'ไม่พบเคส' });
    return c;
  }

  // ── Email-to-Case webhook: a customer email → threaded onto its case, or a NEW case. ──
  async handleInbound(tenantCode: string, secret: string | undefined, payload: CaseInboundEmail, sig?: { rawBody?: Buffer | string; signature?: string; timestamp?: string }) {
    const [t] = await this.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, tenantCode)).limit(1);
    if (!t) throw new UnauthorizedException({ code: 'UNKNOWN_TENANT', message: 'Unknown tenant code', messageTh: 'ไม่พบรหัสบริษัท' });
    const tenantId = Number(t.id);
    this.assertSecret(await this.tenantMsg.resolveCreds(tenantId, 'email'), secret, sig);

    const from = this.norm(payload?.from ?? '');
    if (!from) return { received: true, created: false, skipped: 'no_sender' };

    // Provider-redelivery dedupe on the Message-ID.
    const msgId = String(payload?.message_id ?? '').slice(0, 200);
    if (msgId) {
      const [dup] = await this.db.select({ id: caseEmailMessages.id }).from(caseEmailMessages)
        .where(and(eq(caseEmailMessages.tenantId, tenantId), eq(caseEmailMessages.messageId, msgId))).limit(1);
      if (dup) return { received: true, created: false, skipped: 'duplicate' };
    }

    const subject = payload?.subject ? String(payload.subject).slice(0, 500) : null;
    const text = payload?.text != null ? String(payload.text) : '';
    const bodyPreview = text.slice(0, 2000);
    const token = parseCaseThreadToken(subject, text, payload?.in_reply_to, payload?.references);

    const matched = await this.matchCase(tenantId, from, token);
    if (matched) {
      // Threading onto an existing case; if it had been resolved/closed, reopen it (the customer replied).
      if (matched.status === 'resolved' || matched.status === 'closed') {
        await this.db.update(serviceCases).set({ status: 'open', resolvedAt: null, closedAt: null }).where(eq(serviceCases.id, matched.id));
      }
      await this.logMessage(tenantId, matched.id, from, subject, bodyPreview, matched.threadToken ?? token, msgId);
      return { received: true, created: false, case_id: Number(matched.id), case_no: matched.caseNo, matched_by: token && matched.threadToken === token ? 'thread_token' : 'contact_email' };
    }

    // No match → open a NEW case from the email.
    const caseNo = await this.nextCaseNo(tenantId);
    const newToken = newCaseThreadToken();
    const [created] = await this.db.insert(serviceCases).values({
      tenantId, caseNo, subject: subject ?? `Email from ${from}`, description: bodyPreview,
      status: 'open', priority: 'P3', source: 'email', contactEmail: from, customerName: from,
      threadToken: newToken, createdBy: `email:${from}`,
    }).returning();
    await this.logMessage(tenantId, Number(created!.id), from, subject, bodyPreview, newToken, msgId);
    return { received: true, created: true, case_id: Number(created!.id), case_no: caseNo, matched_by: 'new_case' };
  }

  // Match precedence: (1) per-case thread token; (2) sender address → their most-recent OPEN case. Nothing ⇒ null.
  private async matchCase(tenantId: number, from: string, token: string | null) {
    if (token) {
      const [c] = await this.db.select().from(serviceCases)
        .where(and(eq(serviceCases.tenantId, tenantId), eq(serviceCases.threadToken, token))).limit(1);
      if (c) return c;
    }
    const [c] = await this.db.select().from(serviceCases)
      .where(and(eq(serviceCases.tenantId, tenantId), eq(serviceCases.contactEmail, from), inArray(serviceCases.status, [...OPEN_STATES])))
      .orderBy(desc(serviceCases.id)).limit(1);
    return c ?? null;
  }

  private async logMessage(tenantId: number, caseId: number, from: string, subject: string | null, bodyPreview: string, token: string | null, msgId: string) {
    try {
      await this.db.insert(caseEmailMessages).values({
        tenantId, caseId, direction: 'inbound', fromAddr: from, subject, bodyPreview,
        threadToken: token, messageId: msgId || null, createdBy: `email:${from}`,
      });
    } catch (e) { this.logger.warn(`case inbound log failed: ${(e as { message?: string })?.message ?? e}`); }
  }

  // Mirror CRM-6/email-capture auth: a configured HMAC secret requires a valid signature over the raw body (with
  // an optional freshness timestamp); else the legacy static shared-secret compare; with neither configured,
  // fail-closed in production but accept in dev/test so the feature is exercisable without creds.
  private assertSecret(creds: Record<string, unknown> | null, provided: string | undefined, sig?: { rawBody?: Buffer | string; signature?: string; timestamp?: string }) {
    const staticSecret = creds?.secret as string | undefined;
    const hmacSecret = (creds?.hmac_secret ?? creds?.hmacSecret) as string | undefined;
    const auth = verifyInboundWebhook({ rawBody: sig?.rawBody, staticSecret, providedSecret: provided, hmacSecret, signature: sig?.signature, timestamp: sig?.timestamp });
    if (auth === 'stale') throw new UnauthorizedException({ code: 'WEBHOOK_STALE', message: 'Inbound timestamp outside the allowed window (possible replay)', messageTh: 'เวลาของ inbound หมดอายุ (อาจเป็นการส่งซ้ำ)' });
    if (auth === 'bad') throw new UnauthorizedException({ code: 'BAD_INBOUND_SECRET', message: 'Invalid inbound secret', messageTh: 'รหัสยืนยัน inbound ไม่ถูกต้อง' });
    if (auth === 'unconfigured') {
      if (process.env.NODE_ENV === 'production') throw new UnauthorizedException({ code: 'INBOUND_UNVERIFIED', message: 'Email-to-Case inbound secret not configured', messageTh: 'ยังไม่ได้ตั้งค่ารหัสยืนยัน inbound' });
      this.logger.warn('email-to-case inbound accepted UNVERIFIED (no secret; dev/test only)');
    }
  }
}

function fmtCase(c: typeof serviceCases.$inferSelect) {
  return {
    id: Number(c.id), case_no: c.caseNo, subject: c.subject, description: c.description,
    status: c.status, priority: c.priority, source: c.source,
    contact_email: c.contactEmail, customer_name: c.customerName, assignee: c.assignee,
    thread_token: c.threadToken, opened_at: c.openedAt, resolved_at: c.resolvedAt, closed_at: c.closedAt,
    resolution_note: c.resolutionNote, created_by: c.createdBy, created_at: c.createdAt,
  };
}

function fmtMsg(m: typeof caseEmailMessages.$inferSelect) {
  return {
    id: Number(m.id), direction: m.direction, from: m.fromAddr, to: m.toAddr, subject: m.subject,
    body_preview: m.bodyPreview, message_id: m.messageId, created_by: m.createdBy, created_at: m.createdAt,
  };
}
