import { Controller, Post, Get, Delete, Param, Req, Headers, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { createHmac, randomBytes } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { resolvePermissions, type Role, type Permission } from '@ierp/shared';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenants, posMembers, messageLog, users, userPermissions, purchaseRequests } from '../../database/schema';
import { safeEqualStr } from '../../common/crypto';
import { isUniqueViolation } from '../../common/db-error';
import { Public, NoTx, Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { TenantMessagingService } from './tenant-messaging.service';
import { replyLine, type SendResult } from './gateways';
import { ProcurementService } from '../procurement/procurement.service';

// LINE Messaging API webhook (follow / unfollow / message …). Public + no JWT: authenticity is the LINE
// signature (`X-Line-Signature` = base64 HMAC-SHA256 of the RAW body under the tenant's Channel Secret).
// One OA = one tenant, so the URL carries the shop code: each tenant points its LINE webhook at
// /api/line/webhook/<code>. @NoTx (system caller) — every write is scoped by the resolved tenant_id
// explicitly (RLS is bypassed here).
//
// Chat commands (0227 — LINE chat → PR): a STAFF user who has linked their LINE account (one-time code
// from /requisitions) can raise a Purchase Requisition from the OA chat. Only messages matching a command
// (`link …` / `pr …` / `status …`) are handled; anything else is ignored silently so customers keep
// chatting with the OA freely. A chat-raised PR goes through the exact same createPr path as the web —
// same doc numbering, status log, and approval-workflow routing (PR remains a request until Procurement
// approves; PO/GR stay on their own SoD-guarded flows).
@Injectable()
export class LineWebhookService {
  private readonly logger = new Logger('LineWebhook');
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly tenantMsg: TenantMessagingService,
    private readonly moduleRef: ModuleRef,
  ) {}

  // ProcurementService is resolved lazily from the root container instead of importing ProcurementModule:
  // Messaging → Procurement → Platform → Automation → Messaging would be a circular module graph. The
  // root singleton carries the approval-workflow wiring, so chat PRs route through the same engine.
  private procurementSvc(): ProcurementService | null {
    try { return this.moduleRef.get(ProcurementService, { strict: false }); } catch { return null; }
  }

  async handle(tenantCode: string, rawBody: Buffer | undefined, signature: string | undefined, parsed: any) {
    const db = this.db;
    const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, tenantCode)).limit(1);
    if (!t) throw new UnauthorizedException({ code: 'UNKNOWN_TENANT', message: 'Unknown shop code', messageTh: 'ไม่พบรหัสร้าน' });
    const tenantId = Number(t.id);

    const creds = await this.tenantMsg.resolveCreds(tenantId, 'line');
    const secret = creds?.secret as string | undefined;
    const body = this.verify(secret, rawBody, signature, parsed);
    const token = (creds?.token as string | undefined) ?? process.env.LINE_CHANNEL_TOKEN;

    let followed = 0, unfollowed = 0, chat = 0;
    for (const ev of body?.events ?? []) {
      const userId = ev?.source?.userId;
      if (!userId) continue;
      if (ev.type === 'follow') { await this.onFollow(tenantId, userId); followed++; }
      else if (ev.type === 'unfollow') { await this.onUnfollow(tenantId, userId); unfollowed++; }
      else if (ev.type === 'message' && ev.message?.type === 'text') { if (await this.onChatMessage(tenantId, token, ev)) chat++; }
    }
    return { received: true, followed, unfollowed, chat };
  }

  // Verify the LINE signature over the RAW body when a Channel Secret is configured (fail closed on a bad/
  // missing signature). No secret: reject in prod (cannot authenticate), accept the parsed body in dev/test.
  private verify(secret: string | undefined, rawBody: Buffer | undefined, signature: string | undefined, parsed: any) {
    if (secret) {
      const expected = createHmac('sha256', secret).update(rawBody ?? Buffer.from('')).digest('base64');
      if (!signature || !safeEqualStr(expected, signature)) {
        throw new UnauthorizedException({ code: 'BAD_WEBHOOK_SIGNATURE', message: 'Invalid LINE signature', messageTh: 'ลายเซ็น webhook ไม่ถูกต้อง' });
      }
      try { return JSON.parse((rawBody ?? Buffer.from('{}')).toString('utf8')); } catch { return parsed ?? {}; }
    }
    const env = process.env.NODE_ENV;
    if (env !== 'development' && env !== 'test') {
      throw new UnauthorizedException({ code: 'WEBHOOK_UNVERIFIED', message: 'LINE channel secret not configured', messageTh: 'ยังไม่ได้ตั้งค่ารหัสยืนยัน webhook' });
    }
    this.logger.warn(`LINE webhook accepted UNVERIFIED for tenant (no channel secret; dev/test only)`);
    return parsed ?? {};
  }

  // Following the OA auto-enrols (or re-activates) a member keyed by the LINE userId — so a walk-in who adds
  // the OA becomes a reachable member. Idempotent + tenant-scoped; logs a follow event for auditing.
  private async onFollow(tenantId: number, lineUserId: string) {
    const db = this.db;
    const [existing] = await db.select().from(posMembers).where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.lineUserId, lineUserId))).limit(1);
    if (existing) {
      if (existing.active === false) await db.update(posMembers).set({ active: true, lastUpdated: new Date() }).where(eq(posMembers.id, existing.id));
    } else {
      try {
        const [row] = await db.insert(posMembers).values({
          tenantId, memberCode: 'M-TMP', lineUserId, marketingOptIn: true, active: true,
          balance: '0', lifetime: '0', createdBy: 'system:line-follow',
        }).returning();
        await db.update(posMembers).set({ memberCode: `M-${String(row!.id).padStart(6, '0')}` }).where(eq(posMembers.id, row!.id));
      } catch (e: any) { if (!isUniqueViolation(e)) throw e; /* raced another follow → fine */ }
    }
    await this.log(tenantId, lineUserId, 'follow');
  }

  // Unfollowing is recorded (for follower analytics) but does NOT deactivate the member or touch their points
  // — membership and points outlive the OA relationship; they simply become unreachable over LINE.
  private async onUnfollow(tenantId: number, lineUserId: string) {
    await this.log(tenantId, lineUserId, 'unfollow');
  }

  private async log(tenantId: number, recipient: string, kind: 'follow' | 'unfollow') {
    const db = this.db;
    try {
      await db.insert(messageLog).values({ tenantId, memberId: null, channel: 'line', recipient, body: `[oa:${kind}]`, campaign: `oa_${kind}`, status: 'received', provider: 'line', createdBy: 'system:line-webhook' });
    } catch { /* audit best-effort */ }
  }

  // ── LINE chat → PR (0227) ─────────────────────────────────────────────────

  private static readonly CHAT_USAGE =
    'รูปแบบคำสั่ง:\n• pr <รหัสสินค้า> <จำนวน> [เหตุผล] — สร้างคำขอซื้อ (หลายรายการคั่นด้วย , หรือขึ้นบรรทัดใหม่)\n• status <เลขที่ PR> — เช็คสถานะคำขอซื้อ\nเช่น  pr A4-PAPER 10 กระดาษหมด, TONER-85A 2';

  private static readonly NOT_LINKED =
    'ยังไม่ได้เชื่อมบัญชีพนักงาน — เปิดหน้า "คำขอซื้อ (PR)" ในระบบ ERP กด "เชื่อมต่อ LINE" เพื่อรับรหัส แล้วพิมพ์ link <รหัส> ที่นี่';

  // Handle one inbound text message. Returns true when the text was a recognised command (link / pr /
  // status); any other text is a customer conversation → not our business, no reply, no log.
  private async onChatMessage(tenantId: number, token: string | undefined, ev: any): Promise<boolean> {
    const lineUserId = String(ev?.source?.userId ?? '');
    const text = String(ev?.message?.text ?? '').trim();
    const msgId = String(ev?.message?.id ?? '');
    if (!lineUserId || !text) return false;

    const linkM = /^link\s+([A-Za-z0-9]{4,24})$/i.exec(text);
    const statusM = /^(?:pr\s+)?(?:status|สถานะ)\s+(\S+)$/i.exec(text);
    const isPr = !statusM && /^(?:pr\b|ขอซื้อ)/i.test(text);
    if (!linkM && !statusM && !isPr) return false;

    // LINE may redeliver a webhook — the reply log row carries the inbound message id, so a duplicate
    // delivery of the same message is dropped instead of raising a second PR.
    if (msgId) {
      const [dup] = await this.db.select({ id: messageLog.id }).from(messageLog)
        .where(and(eq(messageLog.tenantId, tenantId), eq(messageLog.providerRef, `line:msg:${msgId}`))).limit(1);
      if (dup) return true;
    }

    let reply: string;
    let campaign = 'chat_pr';
    if (linkM) {
      reply = await this.linkStaff(tenantId, lineUserId, linkM[1]!.toUpperCase());
      campaign = 'chat_link';
    } else {
      const staff = await this.staffByLine(tenantId, lineUserId);
      if (!staff) reply = LineWebhookService.NOT_LINKED;
      else if (statusM) { reply = await this.prStatus(statusM[1]!); campaign = 'chat_pr_status'; }
      else reply = await this.chatCreatePr(staff, text);
    }
    await this.replyChat(tenantId, token, ev?.replyToken, lineUserId, msgId, reply, campaign);
    return true;
  }

  // Bind the LINE account to the staff user holding this (unexpired) one-time code. The code was issued to
  // an authenticated pr_raise holder on /requisitions, so possession of it proves the ERP identity; the
  // user must belong to this OA's tenant (HQ users with no tenant may link on any of their shops' OAs).
  private async linkStaff(tenantId: number, lineUserId: string, code: string): Promise<string> {
    const db = this.db;
    const [u] = await db.select().from(users).where(eq(users.lineLinkCode, code)).limit(1);
    const expired = !u?.lineLinkExpiresAt || new Date(u.lineLinkExpiresAt).getTime() < Date.now();
    if (!u || u.isActive === false || expired || (u.tenantId != null && Number(u.tenantId) !== tenantId)) {
      return 'รหัสเชื่อมไม่ถูกต้องหรือหมดอายุ — สร้างรหัสใหม่ได้ที่หน้า "คำขอซื้อ (PR)" ในระบบ ERP';
    }
    try {
      await db.update(users).set({ lineUserId, lineLinkCode: null, lineLinkExpiresAt: null }).where(eq(users.id, u.id));
    } catch (e: any) {
      if (isUniqueViolation(e)) return 'บัญชี LINE นี้ถูกเชื่อมกับผู้ใช้อื่นแล้ว — ยกเลิกการเชื่อมเดิมก่อนจากหน้า "คำขอซื้อ (PR)"';
      throw e;
    }
    await this.audit(tenantId, lineUserId, `[chat:link] ${u.username}`);
    return `เชื่อมบัญชีสำเร็จ ✔ (${u.username})\n${LineWebhookService.CHAT_USAGE}`;
  }

  // Resolve the STAFF user linked to this LINE account (active + same tenant; HQ users pass on any tenant).
  private async staffByLine(tenantId: number, lineUserId: string) {
    const [u] = await this.db.select().from(users).where(eq(users.lineUserId, lineUserId)).limit(1);
    if (!u || u.isActive === false) return null;
    if (u.tenantId != null && Number(u.tenantId) !== tenantId) return null;
    return u;
  }

  // Effective permissions = per-user override (if any) else role default, expanded — same precedence the
  // login flow uses (resolvePermissions), so chat honours exactly what the web session would.
  private async effectivePerms(u: { id: number; role: string }): Promise<string[]> {
    const rows = await this.db.select({ perm: userPermissions.perm }).from(userPermissions).where(eq(userPermissions.userId, Number(u.id)));
    const overrides = rows.map((r: any) => r.perm as Permission);
    return resolvePermissions(u.role as Role, overrides.length ? overrides : null);
  }

  // `pr <item> <qty> [reason][, …]` → ProcurementService.createPr under the linked user's identity. The
  // pr_raise permission is enforced here (the chat has no JWT guard), and the PR routes into the same
  // approval workflow as a web-raised PR — the chat can RAISE, never approve.
  private async chatCreatePr(u: any, text: string): Promise<string> {
    const body = text.replace(/^(?:pr|ขอซื้อ)\s*/i, '').trim();
    if (!body) return LineWebhookService.CHAT_USAGE;
    const items: { item_id: string; request_qty: number; reason?: string }[] = [];
    for (const raw of body.split(/[,;\n]+/)) {
      const line = raw.trim();
      if (!line) continue;
      const m = /^(\S+)\s+(\d+(?:\.\d+)?)(?:\s+(.+))?$/.exec(line);
      if (!m || !(Number(m[2]) > 0)) return `อ่านรายการนี้ไม่ได้: "${line}"\n${LineWebhookService.CHAT_USAGE}`;
      items.push({ item_id: m[1]!, request_qty: Number(m[2]), reason: m[3]?.trim() || undefined });
    }
    if (!items.length) return LineWebhookService.CHAT_USAGE;

    const perms = await this.effectivePerms(u);
    if (!perms.includes('pr_raise')) return 'บัญชีของคุณไม่มีสิทธิ์สร้างคำขอซื้อ (pr_raise)';
    const procurement = this.procurementSvc();
    if (!procurement) return 'ระบบคำขอซื้อยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    try {
      const res = await procurement.createPr({ items }, jwtUser);
      return `สร้างคำขอซื้อแล้ว ✔ เลขที่ ${res.pr_no} (${res.lines} รายการ) — ส่งเข้าขั้นตอนอนุมัติของทีมจัดซื้อแล้ว พิมพ์ "status ${res.pr_no}" เพื่อเช็คสถานะ`;
    } catch (e: any) {
      const msg = e?.response?.messageTh ?? e?.response?.message ?? e?.message ?? 'ไม่ทราบสาเหตุ';
      return `สร้างคำขอซื้อไม่สำเร็จ: ${String(msg).slice(0, 200)}`;
    }
  }

  private async prStatus(prNo: string): Promise<string> {
    const [pr] = await this.db.select().from(purchaseRequests).where(eq(purchaseRequests.prNo, prNo)).limit(1);
    if (!pr) return `ไม่พบคำขอซื้อ ${prNo}`;
    const th: Record<string, string> = { Draft: 'ฉบับร่าง', Pending: 'รออนุมัติ', Approved: 'อนุมัติแล้ว', Rejected: 'ไม่อนุมัติ' };
    return `PR ${prNo}: ${th[String(pr.status)] ?? pr.status}${pr.approvedBy ? ` (โดย ${pr.approvedBy})` : ''}`;
  }

  // Reply over the one-time replyToken (no push quota); without a configured token (dev mock) the network
  // call is skipped. The reply is audit-logged in message_log carrying the INBOUND message id as
  // provider_ref — that row doubles as the webhook-redelivery dedup marker.
  private async replyChat(tenantId: number, token: string | undefined, replyToken: string | undefined, lineUserId: string, msgId: string, text: string, campaign: string) {
    let result: SendResult = { status: 'sent', provider: 'mock' };
    if (token && replyToken) result = await replyLine(token, replyToken, text);
    try {
      await this.db.insert(messageLog).values({
        tenantId, memberId: null, channel: 'line', recipient: lineUserId, body: text, campaign,
        status: result.status, provider: result.provider, providerRef: msgId ? `line:msg:${msgId}` : null,
        error: result.error ?? null, createdBy: 'system:line-chat',
      });
    } catch { /* audit best-effort */ }
  }

  private async audit(tenantId: number, recipient: string, body: string) {
    try {
      await this.db.insert(messageLog).values({ tenantId, memberId: null, channel: 'line', recipient, body, campaign: 'chat_link_audit', status: 'received', provider: 'line', createdBy: 'system:line-chat' });
    } catch { /* audit best-effort */ }
  }

  // ── Link-code lifecycle (authenticated web endpoints) ─────────────────────

  private static readonly CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L ambiguity
  private genCode(): string {
    const bytes = randomBytes(6);
    let out = '';
    for (let i = 0; i < 6; i++) out += LineWebhookService.CODE_ALPHABET[bytes[i]! % LineWebhookService.CODE_ALPHABET.length];
    return out;
  }

  // Issue a fresh one-time link code for the calling staff user (10-minute TTL; re-issuing replaces the
  // previous code). The code is typed into the shop's LINE OA chat as `link <code>`.
  async issueLinkCode(user: JwtUser) {
    const db = this.db;
    const [row] = await db.select({ id: users.id, lineUserId: users.lineUserId }).from(users).where(eq(users.username, user.username)).limit(1);
    if (!row) throw new UnauthorizedException({ code: 'UNKNOWN_USER', message: 'User not found', messageTh: 'ไม่พบผู้ใช้' });
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    for (let i = 0; ; i++) {
      const code = this.genCode();
      try {
        await db.update(users).set({ lineLinkCode: code, lineLinkExpiresAt: expiresAt }).where(eq(users.id, row.id));
        return { code, expires_at: expiresAt.toISOString(), linked: !!row.lineUserId };
      } catch (e: any) {
        if (!isUniqueViolation(e) || i >= 4) throw e; // code collision → regenerate (astronomically rare)
      }
    }
  }

  async linkStatus(user: JwtUser) {
    const [row] = await this.db.select({ lineUserId: users.lineUserId }).from(users).where(eq(users.username, user.username)).limit(1);
    return { linked: !!row?.lineUserId };
  }

  async unlink(user: JwtUser) {
    await this.db.update(users).set({ lineUserId: null, lineLinkCode: null, lineLinkExpiresAt: null }).where(eq(users.username, user.username));
    return { linked: false };
  }
}

@Controller('api/line')
export class LineWebhookController {
  constructor(private readonly svc: LineWebhookService) {}

  @Public()
  @NoTx()
  @Post('webhook/:tenantCode')
  webhook(
    @Param('tenantCode') tenantCode: string,
    @Req() req: FastifyRequest & { rawBody?: Buffer },
    @Headers('x-line-signature') signature: string | undefined,
  ) {
    return this.svc.handle(tenantCode, req.rawBody, signature, (req as any).body);
  }

  // LINE-account linking for the chat-PR flow — mirrors the /requisitions permission set (pr_raise;
  // procurement/planner imply it). Authenticated: the code binds the CALLER's identity, nothing else.
  @Post('link-code') @Permissions('pr_raise', 'procurement', 'planner')
  linkCode(@CurrentUser() u: JwtUser) { return this.svc.issueLinkCode(u); }

  @Get('link') @Permissions('pr_raise', 'procurement', 'planner')
  linkStatus(@CurrentUser() u: JwtUser) { return this.svc.linkStatus(u); }

  @Delete('link') @Permissions('pr_raise', 'procurement', 'planner')
  unlink(@CurrentUser() u: JwtUser) { return this.svc.unlink(u); }
}
