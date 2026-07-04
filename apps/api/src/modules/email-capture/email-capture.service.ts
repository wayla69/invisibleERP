import { Inject, Injectable, Optional, Logger, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { randomInt } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { resolvePermissions, type Role, type Permission } from '@ierp/shared';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenants, users, userPermissions, messageLog } from '../../database/schema';
import { safeEqualStr } from '../../common/crypto';
import type { JwtUser } from '../../common/decorators';
import { MAILER, type Mailer } from '../tax/documents/mailer';
import { TenantMessagingService } from '../messaging/tenant-messaging.service';
import { ApIntakeService } from '../ap-intake/ap-intake.service';
import { INVOICE_DOC_MIME } from '../../common/invoice-doc';

// Email-to-Capture (docs/34 Phase 4). Two halves:
//  (1) a staffer verifies a "send-from" email (a 6-digit code mailed to it) so the system can attribute an
//      inbound bill to them — mirrors the LINE identity link.
//  (2) an inbound-email webhook (one address per tenant, provider posts the parsed mail here) turns each
//      attachment into an AP-intake DRAFT via the same EXP-10 engine the /capture web + LINE lanes use.
// Draft-only: never books a bill or touches the GL; booking stays creditors (SoD/EXP-06).
const CODE_TTL_MS = 15 * 60_000;
const CAPTURE_PERMS = ['pr_raise', 'procurement', 'creditors'];

// Normalized inbound-email payload — the provider-agnostic shape a SendGrid Inbound Parse / Mailgun route /
// Postmark inbound webhook maps onto (see docs/34). Attachments carry base64 bytes + a MIME type.
export interface InboundEmail {
  from: string;
  subject?: string;
  message_id?: string;
  attachments?: { filename?: string; content_type: string; data_base64: string }[];
}

@Injectable()
export class EmailCaptureService {
  private readonly logger = new Logger('EmailCapture');
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly tenantMsg: TenantMessagingService,
    private readonly moduleRef: ModuleRef,
    @Optional() @Inject(MAILER) private readonly mailer: Mailer | null,
  ) {}

  // ApIntakeService resolved lazily from the root container (same reason as the LINE webhook: avoid a
  // circular module graph while reusing the one capture engine).
  private apIntakeSvc(): ApIntakeService | null {
    try { return this.moduleRef.get(ApIntakeService, { strict: false }); } catch { return null; }
  }

  private norm(email: string) { return (email ?? '').trim().toLowerCase(); }

  private captureInbox(tenantCode: string) {
    const domain = process.env.CAPTURE_EMAIL_DOMAIN || 'bills.example.com';
    return `capture-${tenantCode.toLowerCase()}@${domain}`;
  }

  // JwtUser carries no DB id — resolve the caller's row by their (globally-unique) username.
  private async loadMe(user: JwtUser) {
    const [u] = await this.db.select().from(users).where(eq(users.username, user.username)).limit(1);
    return u ?? null;
  }

  private async effectivePerms(u: { id: number; role: string }): Promise<string[]> {
    const rows = await this.db.select({ perm: userPermissions.perm }).from(userPermissions).where(eq(userPermissions.userId, Number(u.id)));
    const overrides = rows.map((r: any) => r.perm as Permission);
    return resolvePermissions(u.role as Role, overrides.length ? overrides : null);
  }

  // ── (1a) Register: park a pending verification and mail the code to the address. ──
  async register(email: string, user: JwtUser) {
    const addr = this.norm(email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) throw new BadRequestException({ code: 'BAD_EMAIL', message: 'Invalid email', messageTh: 'อีเมลไม่ถูกต้อง' });
    const me = await this.loadMe(user);
    if (!me) throw new BadRequestException({ code: 'NO_USER', message: 'User not found', messageTh: 'ไม่พบผู้ใช้' });
    // Not already verified-owned by ANOTHER user in the same tenant (attribution must be unambiguous).
    const conds: any[] = [eq(users.captureEmail, addr)];
    if (user.tenantId != null) conds.push(eq(users.tenantId, user.tenantId));
    const owners = await this.db.select({ id: users.id, code: users.captureEmailCode }).from(users).where(and(...conds));
    if (owners.some((o: any) => o.code == null && Number(o.id) !== Number(me.id))) {
      throw new BadRequestException({ code: 'EMAIL_TAKEN', message: 'Email already linked to another user', messageTh: 'อีเมลนี้ถูกผูกกับผู้ใช้อื่นแล้ว' });
    }
    const code = String(randomInt(100_000, 1_000_000));
    await this.db.update(users)
      .set({ captureEmail: addr, captureEmailCode: code, captureEmailExpiresAt: new Date(Date.now() + CODE_TTL_MS) })
      .where(eq(users.id, Number(me.id)));
    // Best-effort mail: registration still succeeds (the code is stored) if SMTP is down — the user can
    // re-request. Never leak the code in the API response.
    let sent = false;
    if (this.mailer) {
      try {
        await this.mailer.send({
          from: process.env.CAPTURE_EMAIL_FROM || process.env.SMTP_FROM || 'no-reply@example.com',
          to: addr,
          subject: 'รหัสยืนยันอีเมลสำหรับเก็บบิล (Capture email verification)',
          text: `รหัสยืนยันของคุณคือ ${code} (หมดอายุใน 15 นาที)\nYour capture-email verification code is ${code} (expires in 15 minutes).`,
        });
        sent = true;
      } catch (e: any) { this.logger.warn(`capture-email code send failed: ${e?.message ?? e}`); }
    }
    return { pending: true, email: addr, sent };
  }

  // ── (1b) Verify: confirm the mailed code → the address is now a verified sender identity. ──
  async verify(code: string, user: JwtUser) {
    const u = await this.loadMe(user);
    if (!u || !u.captureEmail || !u.captureEmailCode) throw new BadRequestException({ code: 'NO_PENDING', message: 'No pending verification — register first', messageTh: 'ยังไม่มีอีเมลรอยืนยัน กรุณาลงทะเบียนก่อน' });
    if (u.captureEmailExpiresAt && new Date(u.captureEmailExpiresAt).getTime() < Date.now()) throw new BadRequestException({ code: 'CODE_EXPIRED', message: 'Code expired — register again', messageTh: 'รหัสหมดอายุ กรุณาลงทะเบียนใหม่' });
    if (!safeEqualStr(String(code ?? '').trim(), u.captureEmailCode)) throw new BadRequestException({ code: 'BAD_CODE', message: 'Wrong code', messageTh: 'รหัสยืนยันไม่ถูกต้อง' });
    await this.db.update(users).set({ captureEmailCode: null, captureEmailExpiresAt: null }).where(eq(users.id, Number(u.id)));
    return { verified: true, email: u.captureEmail };
  }

  async status(user: JwtUser) {
    const u = await this.loadMe(user);
    let inbox = '';
    if (user.tenantId != null) {
      const [t] = await this.db.select({ code: tenants.code }).from(tenants).where(eq(tenants.id, user.tenantId)).limit(1);
      if (t?.code) inbox = this.captureInbox(t.code);
    }
    return { email: u?.captureEmail ?? null, verified: !!(u?.captureEmail && !u?.captureEmailCode), inbox_address: inbox };
  }

  // ── (2) Inbound webhook: a forwarded bill → AP-intake draft(s), attributed to the verified sender. ──
  async handleInbound(tenantCode: string, secret: string | undefined, payload: InboundEmail) {
    const [t] = await this.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, tenantCode)).limit(1);
    if (!t) throw new UnauthorizedException({ code: 'UNKNOWN_TENANT', message: 'Unknown shop code', messageTh: 'ไม่พบรหัสร้าน' });
    const tenantId = Number(t.id);
    this.assertSecret(await this.tenantMsg.resolveCreds(tenantId, 'email'), secret);

    const from = this.norm(payload?.from ?? '');
    if (!from) return { received: true, captured: 0, skipped: 'no_sender' };

    // Webhook-redelivery dedupe on the provider message id (same mechanism as the LINE channel).
    const msgId = String(payload?.message_id ?? '').slice(0, 200);
    if (msgId) {
      const [dup] = await this.db.select({ id: messageLog.id }).from(messageLog)
        .where(and(eq(messageLog.tenantId, tenantId), eq(messageLog.providerRef, `email:msg:${msgId}`))).limit(1);
      if (dup) return { received: true, captured: 0, skipped: 'duplicate' };
    }

    // Resolve the VERIFIED sender in this tenant (capture_email set + code cleared).
    const [sender] = await this.db.select().from(users)
      .where(and(eq(users.captureEmail, from), eq(users.tenantId, tenantId))).limit(1);
    if (!sender || sender.captureEmailCode != null || sender.isActive === false) return { received: true, captured: 0, skipped: 'unknown_sender' };
    const perms = await this.effectivePerms(sender);
    if (!CAPTURE_PERMS.some((p) => perms.includes(p))) return { received: true, captured: 0, skipped: 'no_permission' };

    const apIntake = this.apIntakeSvc();
    if (!apIntake) return { received: true, captured: 0, skipped: 'unavailable' };
    const jwtUser: JwtUser = { username: sender.username, role: sender.role, customerName: null, tenantId, permissions: perms };

    const atts = (payload?.attachments ?? []).filter((a) => a && a.data_base64 && INVOICE_DOC_MIME.includes(String(a.content_type ?? '').toLowerCase()));
    const intakes: string[] = [];
    for (const a of atts) {
      const dataUrl = `data:${String(a.content_type).toLowerCase()};base64,${a.data_base64}`;
      try {
        const r: any = await apIntake.capture({ file_name: (a.filename ?? 'email-bill').slice(0, 200), data_url: dataUrl }, jwtUser);
        intakes.push(r.intake_no);
      } catch (e: any) { this.logger.warn(`email capture skipped one attachment: ${e?.response?.code ?? e?.message ?? e}`); }
    }
    // Record receipt (dedupe anchor + audit) even when nothing was capturable. Best-effort.
    try {
      await this.db.insert(messageLog).values({
        tenantId, memberId: null, channel: 'email', recipient: from,
        body: `[capture] ${intakes.length} draft(s)${payload?.subject ? ` · ${String(payload.subject).slice(0, 80)}` : ''}`,
        campaign: 'email_capture', status: 'received', provider: 'email',
        providerRef: msgId ? `email:msg:${msgId}` : null, createdBy: `email:${from}`,
      });
    } catch (e: any) { this.logger.warn(`email capture receipt log failed: ${e?.message ?? e}`); }
    return { received: true, captured: intakes.length, intakes, skipped: intakes.length ? null : 'no_valid_attachment' };
  }

  // Mirror the LINE webhook's auth stance: a configured shared secret must match; with none, reject in prod
  // (cannot authenticate) but accept in dev/test so the feature is exercisable without provider creds.
  private assertSecret(creds: Record<string, any> | null, provided: string | undefined) {
    const secret = creds?.secret as string | undefined;
    if (secret) {
      if (!provided || !safeEqualStr(secret, provided)) throw new UnauthorizedException({ code: 'BAD_INBOUND_SECRET', message: 'Invalid inbound secret', messageTh: 'รหัสยืนยัน inbound ไม่ถูกต้อง' });
      return;
    }
    if (process.env.NODE_ENV === 'production') throw new UnauthorizedException({ code: 'INBOUND_UNVERIFIED', message: 'Email inbound secret not configured', messageTh: 'ยังไม่ได้ตั้งค่ารหัสยืนยัน inbound' });
    this.logger.warn('email inbound accepted UNVERIFIED (no secret; dev/test only)');
  }
}
