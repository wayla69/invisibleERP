import { Controller, Post, Get, Delete, Param, Req, Headers, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { createHmac, randomInt } from 'node:crypto';
import { eq, and, or, desc, ilike } from 'drizzle-orm';
import { resolvePermissions, type Role, type Permission } from '@ierp/shared';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenants, posMembers, messageLog, users, userPermissions, purchaseRequests, items, invBalances, lineChatStates } from '../../database/schema';
import { safeEqualStr } from '../../common/crypto';
import { isUniqueViolation } from '../../common/db-error';
import { Public, NoTx, Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { TenantMessagingService } from './tenant-messaging.service';
import { replyLine, replyLineFlex, fetchLineContent, type SendResult } from './gateways';
import { ProcurementService } from '../procurement/procurement.service';
import { AttachmentsService } from '../procurement/attachments.service';

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
  private attachmentsSvc(): AttachmentsService | null {
    try { return this.moduleRef.get(AttachmentsService, { strict: false }); } catch { return null; }
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
      else if (ev.type === 'message' && ev.message?.type === 'image') { if (await this.onChatImage(tenantId, token, ev)) chat++; }
      else if (ev.type === 'postback') { if (await this.onPostback(tenantId, token, ev)) chat++; }
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
    'รูปแบบคำสั่ง:\n• pr <รหัสสินค้า> <จำนวน> [เหตุผล] — สร้างคำขอซื้อ (หลายรายการคั่นด้วย , หรือขึ้นบรรทัดใหม่)\n• status <เลขที่ PR> — เช็คสถานะ · my prs — คำขอล่าสุดของฉัน · cancel <เลขที่ PR> — ถอนคำขอ\n• find <คำค้น> — ค้นหารหัสสินค้า · stock <รหัสสินค้า> — ดูยอดคงเหลือ\n• approve/reject <เลขที่ PR> — อนุมัติ/ปฏิเสธ (เฉพาะทีมจัดซื้อ)\nเช่น  pr A4-PAPER 10 กระดาษหมด, TONER-85A 2';

  private static readonly STATUS_TH: Record<string, string> = { Draft: 'ฉบับร่าง', Pending: 'รออนุมัติ', Approved: 'อนุมัติแล้ว', Rejected: 'ไม่อนุมัติ', Cancelled: 'ยกเลิกแล้ว' };

  private static readonly NOT_LINKED =
    'ยังไม่ได้เชื่อมบัญชีพนักงาน — เปิดหน้า "คำขอซื้อ (PR)" ในระบบ ERP กด "เชื่อมต่อ LINE" เพื่อรับรหัส แล้วพิมพ์ link <รหัส> ที่นี่';

  // Handle one inbound text message. Returns true when the text was a recognised command; any other text
  // is a customer conversation → not our business, no reply, no log. Routing is token-based (linear —
  // chat text is uncontrolled input, so no backtracking regexes here).
  private async onChatMessage(tenantId: number, token: string | undefined, ev: any): Promise<boolean> {
    const lineUserId = String(ev?.source?.userId ?? '');
    const text = String(ev?.message?.text ?? '').slice(0, 2000).trim(); // LINE caps at 5000; bound our parse work
    const msgId = String(ev?.message?.id ?? '');
    if (!lineUserId || !text) return false;

    const parts = text.split(/\s+/);
    const cmd = (parts[0] ?? '').toLowerCase();
    const arg1 = parts[1] ?? '';
    const isLink = cmd === 'link' && /^[A-Za-z0-9]{4,24}$/.test(arg1);
    const isStatus = ((cmd === 'status' || cmd === 'สถานะ') && !!arg1) || (cmd === 'pr' && arg1.toLowerCase() === 'status' && !!parts[2]);
    const isApprove = (cmd === 'approve' || cmd === 'อนุมัติ') && !!arg1;
    const isReject = (cmd === 'reject' || cmd === 'ปฏิเสธ') && !!arg1;
    const isMyPrs = (cmd === 'my' && arg1.toLowerCase() === 'prs') || cmd === 'รายการของฉัน';
    const isFind = (cmd === 'find' || cmd === 'ค้นหา') && !!arg1;
    const isCancel = (cmd === 'cancel' || cmd === 'ยกเลิก') && !!arg1;
    const isStock = (cmd === 'stock' || cmd === 'สต็อก') && !!arg1;
    const isAttach = (cmd === 'attach' || cmd === 'แนบ') && !!arg1;
    const isPr = cmd === 'pr' && !isStatus || text.startsWith('ขอซื้อ');
    if (!isLink && !isStatus && !isApprove && !isReject && !isMyPrs && !isFind && !isCancel && !isStock && !isAttach && !isPr) return false;

    // LINE may redeliver a webhook — the reply log row carries the inbound message id, so a duplicate
    // delivery of the same message is dropped instead of acting twice (e.g. raising a duplicate PR).
    if (msgId) {
      const [dup] = await this.db.select({ id: messageLog.id }).from(messageLog)
        .where(and(eq(messageLog.tenantId, tenantId), eq(messageLog.providerRef, `line:msg:${msgId}`))).limit(1);
      if (dup) return true;
    }

    let reply: string;
    let campaign = 'chat_pr';
    if (isLink) {
      reply = await this.linkStaff(tenantId, lineUserId, arg1.toUpperCase());
      campaign = 'chat_link';
    } else {
      const staff = await this.staffByLine(tenantId, lineUserId);
      if (!staff) reply = LineWebhookService.NOT_LINKED;
      else if (isStatus) { reply = await this.prStatus(cmd === 'pr' ? parts[2]! : arg1); campaign = 'chat_pr_status'; }
      else if (isApprove || isReject) { reply = await this.chatDecision(staff, arg1, isApprove); campaign = 'chat_approve'; }
      else if (isMyPrs) {
        const mine = await this.chatMyPrs(staff);
        await this.replyChat(tenantId, token, ev?.replyToken, lineUserId, msgId, mine.text, 'chat_myprs', mine.flex);
        return true;
      }
      else if (isFind) { reply = await this.chatFind(parts.slice(1).join(' ')); campaign = 'chat_find'; }
      else if (isCancel) { reply = await this.chatCancel(staff, arg1); campaign = 'chat_cancel'; }
      else if (isStock) { reply = await this.chatStock(staff, arg1); campaign = 'chat_stock'; }
      else if (isAttach) { reply = await this.chatAttachStart(tenantId, lineUserId, staff, arg1, (parts[2] ?? '').toLowerCase()); campaign = 'chat_attach'; }
      else reply = await this.chatCreatePr(staff, text);
    }
    await this.replyChat(tenantId, token, ev?.replyToken, lineUserId, msgId, reply, campaign);
    return true;
  }

  // approve/reject <PR no> — the chat approval channel (0228). The permission mirrors the web endpoint
  // (`procurement`), and the decision routes through ProcurementService.approvePr → the workflow engine,
  // so maker-checker/SoD and multi-level chains bind exactly as on the web.
  private async chatDecision(u: any, docNo: string, approve: boolean): Promise<string> {
    const prNo = docNo.toUpperCase();
    if (!prNo.startsWith('PR-')) return 'อนุมัติผ่านแชทได้เฉพาะคำขอซื้อ (เลขที่ขึ้นต้น PR-)';
    const perms = await this.effectivePerms(u);
    if (!perms.includes('procurement')) return 'บัญชีของคุณไม่มีสิทธิ์อนุมัติคำขอซื้อ (procurement)';
    const procurement = this.procurementSvc();
    if (!procurement) return 'ระบบคำขอซื้อยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    try {
      const res = await procurement.approvePr(prNo, approve, jwtUser);
      const th = res.status === 'Approved' ? 'อนุมัติแล้ว ✅' : res.status === 'Rejected' ? 'ปฏิเสธแล้ว ❌' : `${LineWebhookService.STATUS_TH[String(res.status)] ?? res.status} (รอขั้นถัดไป)`;
      return `${prNo}: ${th}`;
    } catch (e: any) {
      if (e?.response?.code === 'SOD_VIOLATION') return `${prNo}: อนุมัติไม่ได้ — ผู้สร้างเอกสารอนุมัติเองไม่ได้ (SOD_VIOLATION)`;
      const msg = e?.response?.messageTh ?? e?.response?.message ?? e?.message ?? 'ไม่ทราบสาเหตุ';
      return `${prNo}: ดำเนินการไม่สำเร็จ — ${String(msg).slice(0, 200)}`;
    }
  }

  // my prs — the caller's 5 most recent requisitions. Replies a flex CAROUSEL (one card per PR, status
  // colour-coded); the text doubles as the altText so clients without flex rendering lose nothing.
  private async chatMyPrs(u: any): Promise<{ text: string; flex?: any }> {
    const rows = await this.db.select().from(purchaseRequests).where(eq(purchaseRequests.requestedBy, u.username)).orderBy(desc(purchaseRequests.id)).limit(5);
    if (!rows.length) return { text: 'คุณยังไม่มีคำขอซื้อ — พิมพ์ "pr <รหัสสินค้า> <จำนวน>" เพื่อสร้าง' };
    const text = 'คำขอซื้อล่าสุดของคุณ:\n' + rows.map((r: any) => `• ${r.prNo} — ${LineWebhookService.STATUS_TH[String(r.status)] ?? r.status}${r.prDate ? ` (${r.prDate})` : ''}`).join('\n');
    const colour: Record<string, string> = { Approved: '#1b7f3b', Rejected: '#b3261e', Cancelled: '#777777', Pending: '#8a6d1d' };
    const flex = {
      type: 'carousel',
      contents: rows.map((r: any) => ({
        type: 'bubble', size: 'micro',
        body: {
          type: 'box', layout: 'vertical', spacing: 'sm', contents: [
            { type: 'text', text: String(r.prNo), weight: 'bold', size: 'sm', wrap: true },
            { type: 'text', text: LineWebhookService.STATUS_TH[String(r.status)] ?? String(r.status), size: 'sm', color: colour[String(r.status)] ?? '#333333' },
            ...(r.prDate ? [{ type: 'text', text: String(r.prDate), size: 'xs', color: '#888888' }] : []),
          ],
        },
      })),
    };
    return { text, flex };
  }

  // ── LC-1 (docs/30) — one-tap postback approve/reject with a confirm step ─────────────────────────
  // The queue-entry card's [อนุมัติ]/[ปฏิเสธ] buttons post {a:'decide', x, d}. The first tap parks a
  // short-lived confirm state (nonce) and replies a confirm card; tapping [ยืนยัน] posts {a:'confirm',
  // d, n} which consumes the state BEFORE acting (replay-safe) and runs the SAME chatDecision path as the
  // typed command — permission + engine maker-checker/SoD bind identically. No confirm = no action.
  private confirmCard(action: 'approve' | 'reject', docNo: string, nonce: string): any {
    return {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          { type: 'text', text: action === 'approve' ? 'ยืนยันการอนุมัติ?' : 'ยืนยันการปฏิเสธ?', weight: 'bold', size: 'md' },
          { type: 'text', text: docNo, weight: 'bold', size: 'lg' },
          { type: 'text', text: 'กดยืนยันภายใน 5 นาที', size: 'xs', color: '#888888' },
        ],
      },
      footer: {
        type: 'box', layout: 'horizontal', contents: [
          { type: 'button', style: action === 'approve' ? 'primary' : 'secondary', height: 'sm', action: { type: 'postback', label: 'ยืนยัน', data: JSON.stringify({ a: 'confirm', d: docNo, n: nonce }), displayText: `ยืนยัน ${docNo}` } },
        ],
      },
    };
  }

  private async onPostback(tenantId: number, token: string | undefined, ev: any): Promise<boolean> {
    const lineUserId = String(ev?.source?.userId ?? '');
    let data: any = null;
    try { data = JSON.parse(String(ev?.postback?.data ?? '')); } catch { return false; }
    if (!lineUserId || !data || typeof data.a !== 'string') return false;

    // webhook-redelivery dedupe on the event id (postbacks have no message id)
    const evtId = String(ev?.webhookEventId ?? '');
    if (evtId) {
      const [dup] = await this.db.select({ id: messageLog.id }).from(messageLog)
        .where(and(eq(messageLog.tenantId, tenantId), eq(messageLog.providerRef, `line:evt:${evtId}`))).limit(1);
      if (dup) return true;
    }

    const staff = await this.staffByLine(tenantId, lineUserId);
    let text: string;
    let flex: any;
    if (!staff) {
      text = LineWebhookService.NOT_LINKED;
    } else if (data.a === 'decide' && (data.x === 'approve' || data.x === 'reject') && typeof data.d === 'string') {
      const docNo = String(data.d).toUpperCase();
      const nonce = this.genCode();
      const expiresAt = new Date(Date.now() + 5 * 60_000);
      await this.db.insert(lineChatStates)
        .values({ tenantId, lineUserId, kind: 'confirm', payload: { action: data.x, docNo, nonce }, expiresAt })
        .onConflictDoUpdate({ target: [lineChatStates.tenantId, lineChatStates.lineUserId], set: { kind: 'confirm', payload: { action: data.x, docNo, nonce }, expiresAt, createdAt: new Date() } });
      text = `ยืนยันการ${data.x === 'approve' ? 'อนุมัติ' : 'ปฏิเสธ'} ${docNo} — กดปุ่มยืนยันภายใน 5 นาที`;
      flex = this.confirmCard(data.x, docNo, nonce);
    } else if (data.a === 'confirm' && typeof data.d === 'string' && typeof data.n === 'string') {
      const [state] = await this.db.select().from(lineChatStates)
        .where(and(eq(lineChatStates.tenantId, tenantId), eq(lineChatStates.lineUserId, lineUserId), eq(lineChatStates.kind, 'confirm'))).limit(1);
      const p = (state?.payload ?? {}) as { action?: string; docNo?: string; nonce?: string };
      if (!state || new Date(state.expiresAt).getTime() < Date.now() || p.docNo !== String(data.d).toUpperCase() || p.nonce !== data.n) {
        text = 'คำขอยืนยันหมดอายุหรือไม่ถูกต้อง — กดปุ่มอนุมัติ/ปฏิเสธใหม่อีกครั้ง';
      } else {
        // consume the state BEFORE acting so a redelivered confirm can never act twice
        await this.db.delete(lineChatStates).where(and(eq(lineChatStates.tenantId, tenantId), eq(lineChatStates.lineUserId, lineUserId)));
        text = await this.chatDecision(staff, p.docNo!, p.action === 'approve');
      }
    } else {
      return false;
    }
    await this.replyChat(tenantId, token, ev?.replyToken, lineUserId, '', text, 'chat_postback', flex, evtId ? `line:evt:${evtId}` : null);
    return true;
  }

  // find <keyword> — item-master search so people can discover real item ids before raising a PR.
  private async chatFind(keyword: string): Promise<string> {
    const kw = keyword.trim().slice(0, 100);
    if (!kw) return 'ระบุคำค้น เช่น find กระดาษ';
    const rows = await this.db.select({ itemId: items.itemId, itemDescription: items.itemDescription, uom: items.uom })
      .from(items).where(or(ilike(items.itemId, `%${kw}%`), ilike(items.itemDescription, `%${kw}%`))).limit(5);
    if (!rows.length) return `ไม่พบสินค้าที่ตรงกับ "${kw}"`;
    return `ผลค้นหา "${kw}":\n` + rows.map((r: any) => `• ${r.itemId} — ${r.itemDescription ?? '-'}${r.uom ? ` (${r.uom})` : ''}`).join('\n') + '\nสร้างคำขอซื้อ: pr <รหัสสินค้า> <จำนวน>';
  }

  // cancel <PR no> — the requester withdraws their own still-Pending PR (service enforces own-doc + status).
  private async chatCancel(u: any, docNo: string): Promise<string> {
    const prNo = docNo.toUpperCase();
    const procurement = this.procurementSvc();
    if (!procurement) return 'ระบบคำขอซื้อยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const perms = await this.effectivePerms(u);
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    try {
      await procurement.cancelPr(prNo, jwtUser);
      return `${prNo}: ยกเลิกแล้ว ✅`;
    } catch (e: any) {
      const msg = e?.response?.messageTh ?? e?.response?.message ?? e?.message ?? 'ไม่ทราบสาเหตุ';
      return `${prNo}: ยกเลิกไม่ได้ — ${String(msg).slice(0, 200)}`;
    }
  }

  // ── attach <doc no> [invoice|receipt|other] → next photo binds to the document (0228) ─────────────
  // The command validates authority + the target doc NOW and parks a short-lived pending state; the photo
  // that follows (onChatImage) is fetched from the LINE content API and stored as a doc attachment —
  // evidence for the 3-way match (EXP-01 documentation; permission mirrors the web upload endpoint).

  private static readonly ATTACH_PERMS = ['procurement', 'creditors', 'wh_receive'];
  private static readonly ATTACH_TTL_MS = 10 * 60_000;

  private async chatAttachStart(tenantId: number, lineUserId: string, u: any, docNo: string, kindArg: string): Promise<string> {
    const no = docNo.toUpperCase();
    const docType = no.startsWith('PO-') ? 'PO' : no.startsWith('PR-') ? 'PR' : null;
    if (!docType) return 'แนบได้กับใบสั่งซื้อ/คำขอซื้อ (เลขที่ขึ้นต้น PO- หรือ PR-)';
    const kind = ['invoice', 'receipt', 'other'].includes(kindArg) ? kindArg : kindArg === 'ใบเสร็จ' ? 'receipt' : 'invoice';
    const perms = await this.effectivePerms(u);
    if (!LineWebhookService.ATTACH_PERMS.some((p) => perms.includes(p))) return 'บัญชีของคุณไม่มีสิทธิ์แนบเอกสาร (ต้องมี procurement / creditors / wh_receive)';
    const attachments = this.attachmentsSvc();
    if (!attachments) return 'ระบบแนบเอกสารยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    // validate the target NOW so the user isn't told to send a photo at a doc that doesn't exist
    try { await attachments.assertDocExists(docType, no); } catch { return `ไม่พบเอกสาร ${no}`; }
    const expiresAt = new Date(Date.now() + LineWebhookService.ATTACH_TTL_MS);
    await this.db.insert(lineChatStates)
      .values({ tenantId, lineUserId, kind: 'attach', payload: { docType, docNo: no, kind }, expiresAt })
      .onConflictDoUpdate({ target: [lineChatStates.tenantId, lineChatStates.lineUserId], set: { kind: 'attach', payload: { docType, docNo: no, kind }, expiresAt, createdAt: new Date() } });
    return `พร้อมรับรูปสำหรับ ${no} (${kind === 'receipt' ? 'ใบเสร็จ' : kind === 'other' ? 'อื่น ๆ' : 'ใบแจ้งหนี้/ใบกำกับ'}) — ส่งรูปมาในแชทนี้ภายใน 10 นาที`;
  }

  // A photo from a linked staff member with a live pending-attach state → fetch the bytes from the LINE
  // content API and pin them to the document. Any other image (customers, no pending state) is ignored.
  private async onChatImage(tenantId: number, token: string | undefined, ev: any): Promise<boolean> {
    const lineUserId = String(ev?.source?.userId ?? '');
    const msgId = String(ev?.message?.id ?? '');
    if (!lineUserId || !msgId) return false;
    const [state] = await this.db.select().from(lineChatStates)
      .where(and(eq(lineChatStates.tenantId, tenantId), eq(lineChatStates.lineUserId, lineUserId), eq(lineChatStates.kind, 'attach'))).limit(1);
    if (!state || new Date(state.expiresAt).getTime() < Date.now()) return false; // no live flow → not ours
    const staff = await this.staffByLine(tenantId, lineUserId);
    if (!staff) return false;

    // webhook-redelivery dedupe (same mechanism as text commands)
    const [dup] = await this.db.select({ id: messageLog.id }).from(messageLog)
      .where(and(eq(messageLog.tenantId, tenantId), eq(messageLog.providerRef, `line:msg:${msgId}`))).limit(1);
    if (dup) return true;

    const p = (state.payload ?? {}) as { docType?: string; docNo?: string; kind?: string };
    let reply: string;
    const attachments = this.attachmentsSvc();
    if (!attachments || !p.docType || !p.docNo) {
      reply = 'ระบบแนบเอกสารยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    } else if (!token) {
      reply = 'ดึงรูปจาก LINE ไม่ได้ (ยังไม่ได้ตั้งค่า channel token ของร้าน)';
    } else {
      const content = await fetchLineContent(token, msgId);
      if ('error' in content) {
        reply = content.error === 'too-large' ? 'รูปใหญ่เกินไป (สูงสุด ~2MB) — ลองถ่ายใหม่หรือลดขนาด' : 'ดึงรูปจาก LINE ไม่สำเร็จ กรุณาส่งใหม่อีกครั้ง';
      } else {
        const perms = await this.effectivePerms(staff);
        const jwtUser: JwtUser = { username: staff.username, role: staff.role, customerName: null, tenantId: staff.tenantId != null ? Number(staff.tenantId) : null, permissions: perms };
        try {
          const res = await attachments.add({ doc_type: p.docType, doc_no: p.docNo, data_url: content.dataUrl, kind: p.kind, filename: `line-${msgId}.jpg`, source: 'line' }, jwtUser);
          await this.db.delete(lineChatStates).where(and(eq(lineChatStates.tenantId, tenantId), eq(lineChatStates.lineUserId, lineUserId)));
          reply = `แนบรูปกับ ${res.doc_no} แล้ว ✔ (ไฟล์แนบทั้งหมด ${res.count} รายการ) — ดูได้ที่หน้าใบสั่งซื้อในระบบ ERP`;
        } catch (e: any) {
          const msg = e?.response?.messageTh ?? e?.response?.message ?? e?.message ?? 'ไม่ทราบสาเหตุ';
          reply = `แนบรูปไม่สำเร็จ: ${String(msg).slice(0, 200)}`;
        }
      }
    }
    await this.replyChat(tenantId, token, ev?.replyToken, lineUserId, msgId, reply, 'chat_attach');
    return true;
  }

  // stock <item id> — read-only on-hand lookup from inv_balances (tenant-scoped to the linked user's shop).
  private async chatStock(u: any, itemId: string): Promise<string> {
    const conds: any[] = [ilike(invBalances.itemId, itemId)]; // ilike w/o wildcards = case-insensitive equality
    if (u.tenantId != null) conds.push(eq(invBalances.tenantId, Number(u.tenantId)));
    const rows = await this.db.select().from(invBalances).where(and(...conds)).limit(5);
    if (!rows.length) return `ไม่พบยอดคงเหลือของ ${itemId}`;
    const total = rows.reduce((a: number, r: any) => a + Number(r.onHandQty ?? 0), 0);
    const name = rows[0]?.itemDescription ? ` (${rows[0].itemDescription})` : '';
    return `สต็อก ${rows[0]!.itemId}${name}: รวม ${total}\n` + rows.map((r: any) => `• ${r.locationId}: ${Number(r.onHandQty ?? 0)}`).join('\n');
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
      // token split (linear) instead of a backtracking regex — the text is uncontrolled chat input
      const parts = line.split(/\s+/);
      const qty = Number(parts[1]);
      if (parts.length < 2 || !Number.isFinite(qty) || qty <= 0) return `อ่านรายการนี้ไม่ได้: "${line}"\n${LineWebhookService.CHAT_USAGE}`;
      items.push({ item_id: parts[0]!, request_qty: qty, reason: parts.slice(2).join(' ') || undefined });
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
    return `PR ${prNo}: ${LineWebhookService.STATUS_TH[String(pr.status)] ?? pr.status}${pr.approvedBy ? ` (โดย ${pr.approvedBy})` : ''}`;
  }

  // Reply over the one-time replyToken (no push quota); without a configured token (dev mock) the network
  // call is skipped. With `flex`, replies a rich card (text = altText). The reply is audit-logged in
  // message_log carrying the INBOUND message/event id as provider_ref — that row doubles as the
  // webhook-redelivery dedup marker (refOverride lets postbacks use their event id instead).
  private async replyChat(tenantId: number, token: string | undefined, replyToken: string | undefined, lineUserId: string, msgId: string, text: string, campaign: string, flex?: any, refOverride?: string | null) {
    let result: SendResult = { status: 'sent', provider: 'mock' };
    if (token && replyToken) result = flex ? await replyLineFlex(token, replyToken, text, flex) : await replyLine(token, replyToken, text);
    try {
      await this.db.insert(messageLog).values({
        tenantId, memberId: null, channel: 'line', recipient: lineUserId, body: text, campaign,
        status: result.status, provider: result.provider,
        providerRef: refOverride !== undefined ? refOverride : (msgId ? `line:msg:${msgId}` : null),
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
    let out = '';
    // randomInt is CSPRNG-backed and rejection-sampled — no modulo bias over the 31-char alphabet
    for (let i = 0; i < 6; i++) out += LineWebhookService.CODE_ALPHABET[randomInt(LineWebhookService.CODE_ALPHABET.length)];
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
