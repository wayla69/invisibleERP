import { Controller, Post, Get, Delete, Param, Req, Headers, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { createHmac } from 'node:crypto';
import { eq, and, or } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenants, posMembers, messageLog, users, lineChatStates } from '../../database/schema';
import { safeEqualStr } from '../../common/crypto';
import { isUniqueViolation } from '../../common/db-error';
import { Public, NoTx, Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { TenantMessagingService } from './tenant-messaging.service';
import { replyLine, replyLineFlex, fetchLineContent, type SendResult } from './gateways';
import { ProcurementService } from '../procurement/procurement.service';
import { ClaimsService } from '../claims/claims.service';
import { AttachmentsService } from '../procurement/attachments.service';
import { ApIntakeService } from '../ap-intake/ap-intake.service';
import { PettyCashService } from '../petty-cash/petty-cash.service';
import { EssService } from '../ess/ess.service';
import { PmrService } from '../pmr/pmr.service';
import { NlAnalyticsService } from '../nl-analytics/nl-analytics.service';
import { CHAT_USAGE, confirmCard, helpCard } from './line-cards';
import { LineCopilotService, DRAFT_LABEL, type CopilotDraft } from './line-copilot.service';
import { LineLinkService } from './line-link.service';
import { LineChatActionsService, NOT_LINKED } from './line-chat-actions.service';

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
    private readonly copilot: LineCopilotService, // draft parsing (rules + capped LLM) — line-copilot.service.ts
    private readonly link: LineLinkService, // staff linking + chat identity + audit — line-link.service.ts
  ) {
    // docs/46 Phase 4d — the stateless command actions live in LineChatActionsService; the ModuleRef
    // getters below stay here (circular module graph) and are handed down as explicit ports.
    this.actions = new LineChatActionsService(db, link, {
      procurement: () => this.procurementSvc(),
      pmr: () => this.pmrSvc(),
      claims: () => this.claimsSvc(),
      pettyCash: () => this.pettyCashSvc(),
      ess: () => this.essSvc(),
      nl: () => this.nlSvc(),
    });
  }
  private readonly actions: LineChatActionsService;

  // ProcurementService is resolved lazily from the root container instead of importing ProcurementModule:
  // Messaging → Procurement → Platform → Automation → Messaging would be a circular module graph. The
  // root singleton carries the approval-workflow wiring, so chat PRs route through the same engine.
  private procurementSvc(): ProcurementService | null {
    try { return this.moduleRef.get(ProcurementService, { strict: false }); } catch { return null; }
  }
  private attachmentsSvc(): AttachmentsService | null {
    try { return this.moduleRef.get(AttachmentsService, { strict: false }); } catch { return null; }
  }
  // Quick Capture over LINE (docs/34) — ApIntakeService resolved lazily (same reason as the others: avoid a
  // circular module graph). A bill photo → a NeedsReview draft via the same EXP-10 engine as the web lane.
  private apIntakeSvc(): ApIntakeService | null {
    try { return this.moduleRef.get(ApIntakeService, { strict: false }); } catch { return null; }
  }
  // D4 — ClaimsService resolved lazily (same reason as ProcurementService: avoid a circular module graph).
  private claimsSvc(): ClaimsService | null {
    try { return this.moduleRef.get(ClaimsService, { strict: false }); } catch { return null; }
  }
  private pettyCashSvc(): PettyCashService | null {
    try { return this.moduleRef.get(PettyCashService, { strict: false }); } catch { return null; }
  }
  // M2 (docs/32) — PmrService resolved lazily (same reason: avoid a circular module graph) so the over-budget
  // PMR approval card's [อนุมัติ]/[ปฏิเสธ] buttons route through the same replay-safe confirm flow as PRs.
  private pmrSvc(): PmrService | null {
    try { return this.moduleRef.get(PmrService, { strict: false }); } catch { return null; }
  }
  private essSvc(): EssService | null {
    try { return this.moduleRef.get(EssService, { strict: false }); } catch { return null; }
  }
  private nlSvc(): NlAnalyticsService | null {
    try { return this.moduleRef.get(NlAnalyticsService, { strict: false }); } catch { return null; }
  }

  async handle(tenantCode: string, rawBody: Buffer | undefined, signature: string | undefined, parsed: any) {
    const db = this.db;
    const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, tenantCode)).limit(1);
    if (!t) throw new UnauthorizedException({ code: 'UNKNOWN_TENANT', message: 'Unknown shop code', messageTh: 'ไม่พบรหัสร้าน' });
    const tenantId = Number(t.id);

    const creds = await this.tenantMsg.resolveCreds(tenantId, 'line');
    const secret = creds?.secret as string | undefined;
    // LP-1 (docs/31): record receipt health (verified / bad_signature / unverified_dev) so the settings
    // readiness view can answer "has LINE ever actually reached this webhook?". Best-effort, never blocks.
    let body: any;
    try {
      body = this.verify(secret, rawBody, signature, parsed);
    } catch (e) {
      if (secret) await this.tenantMsg.recordWebhookReceipt(tenantId, 'bad_signature');
      throw e;
    }
    await this.tenantMsg.recordWebhookReceipt(tenantId, secret ? 'verified' : 'unverified_dev');
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
    const isCapture = cmd === 'capture' || cmd === 'บิล' || cmd === 'เก็บบิล' || cmd === 'บันทึกบิล';
    const isReceive = (cmd === 'receive' || cmd === 'รับของ' || cmd === 'รับ') && !!arg1;
    const isClaim = (cmd === 'claim' || cmd === 'เคลม' || cmd === 'แจ้งของเสีย') && parts.length >= 3;
    const isLow = cmd === 'low' || cmd === 'ใกล้หมด' || cmd === 'สต็อกต่ำ';
    const isReorder = cmd === 'reorder' || cmd === 'เติมของ' || cmd === 'เติมสต็อก' || cmd === 'สั่งเติม';
    const isSpend = cmd === 'spend' || cmd === 'ยอดซื้อ' || cmd === 'สรุปซื้อ' || cmd === 'ค่าใช้จ่าย';
    const isExpense = (cmd === 'expense' || cmd === 'เบิก') && parts.length >= 3;
    const isAdvance = (cmd === 'advance' || cmd === 'ยืมเงิน') && parts.length >= 3;
    const isLeave = (cmd === 'leave' || cmd === 'ลา') && parts.length >= 3;
    const isAsk = (cmd === 'ask' || cmd === 'ถาม') && parts.length >= 2;
    const isCopilot = cmd === 'bot' || text.startsWith('บอท');
    const isSubLow = (cmd === 'subscribe' && arg1.toLowerCase() === 'lowstock') || cmd === 'รับแจ้งของใกล้หมด';
    const isUnsubLow = (cmd === 'unsubscribe' && arg1.toLowerCase() === 'lowstock') || cmd === 'เลิกแจ้งของใกล้หมด';
    const isSubscribe = !isSubLow && (cmd === 'subscribe' || cmd === 'รับสรุป') && (arg1.toLowerCase() === 'digest' || cmd === 'รับสรุป');
    const isUnsubscribe = !isUnsubLow && (cmd === 'unsubscribe' || cmd === 'เลิกรับสรุป') && (arg1.toLowerCase() === 'digest' || cmd === 'เลิกรับสรุป');
    const isDigestKpis = cmd === 'digest' && arg1.toLowerCase() === 'kpis';
    const isPr = cmd === 'pr' && !isStatus || text.startsWith('ขอซื้อ');
    const isHelp = cmd === 'help' || cmd === 'เมนู' || cmd === 'ช่วยเหลือ' || cmd === 'คำสั่ง';
    if (!isLink && !isStatus && !isApprove && !isReject && !isMyPrs && !isFind && !isCancel && !isStock && !isAttach && !isCapture && !isReceive && !isClaim && !isLow && !isReorder && !isSpend && !isExpense && !isAdvance && !isLeave && !isSubscribe && !isUnsubscribe && !isSubLow && !isUnsubLow && !isDigestKpis && !isAsk && !isCopilot && !isHelp && !isPr) return false;

    // LC-3 governance: per-LINE-user command budget — a scripted/compromised account cannot hammer the
    // channel. First excess gets one throttle reply; further excess is dropped silently (audit-logged).
    const th = this.throttle(tenantId, lineUserId);
    if (th === 'reply') { await this.replyChat(tenantId, token, ev?.replyToken, lineUserId, msgId, 'คำสั่งถี่เกินไป — กรุณารอสักครู่แล้วลองใหม่', 'chat_throttled'); return true; }
    if (th === 'drop') return true;

    // LINE may redeliver a webhook — the reply log row carries the inbound message id, so a duplicate
    // delivery of the same message is dropped instead of acting twice (e.g. raising a duplicate PR).
    if (msgId) {
      const [dup] = await this.db.select({ id: messageLog.id }).from(messageLog)
        .where(and(eq(messageLog.tenantId, tenantId), eq(messageLog.providerRef, `line:msg:${msgId}`))).limit(1);
      if (dup) return true;
    }

    let reply: string;
    let replyFlex: any;
    let campaign = 'chat_pr';
    if (isLink) {
      const res = await this.link.linkStaff(tenantId, lineUserId, arg1.toUpperCase());
      reply = res.text; replyFlex = res.flex;
      campaign = 'chat_link';
    } else if (isHelp) {
      reply = CHAT_USAGE; // altText / non-flex fallback
      replyFlex = helpCard('เมนูคำสั่ง', 'พิมพ์คำสั่งด้านล่างได้เลย');
      campaign = 'chat_help';
    } else {
      const staff = await this.link.staffByLine(tenantId, lineUserId);
      if (!staff) reply = NOT_LINKED;
      else if (isStatus) { reply = await this.actions.prStatus(cmd === 'pr' ? parts[2]! : arg1); campaign = 'chat_pr_status'; }
      else if (isApprove || isReject) { reply = await this.actions.chatDecision(staff, arg1, isApprove); campaign = 'chat_approve'; }
      else if (isMyPrs) {
        const mine = await this.actions.chatMyPrs(staff);
        await this.replyChat(tenantId, token, ev?.replyToken, lineUserId, msgId, mine.text, 'chat_myprs', mine.flex);
        return true;
      }
      else if (isFind) { reply = await this.actions.chatFind(parts.slice(1).join(' ')); campaign = 'chat_find'; }
      else if (isCancel) { reply = await this.actions.chatCancel(staff, arg1); campaign = 'chat_cancel'; }
      else if (isStock) { reply = await this.actions.chatStock(staff, arg1); campaign = 'chat_stock'; }
      else if (isAttach) { reply = await this.chatAttachStart(tenantId, lineUserId, staff, arg1, (parts[2] ?? '').toLowerCase()); campaign = 'chat_attach'; }
      else if (isCapture) { reply = await this.chatCaptureStart(tenantId, lineUserId, staff); campaign = 'chat_capture'; }
      else if (isReceive) { reply = await this.actions.chatReceive(staff, arg1, parts.slice(2)); campaign = 'chat_receive'; }
      else if (isClaim) { reply = await this.actions.chatClaim(staff, arg1, parts[2]!, parts.slice(3).join(' ')); campaign = 'chat_claim'; }
      else if (isLow) { reply = await this.actions.chatLowStock(staff); campaign = 'chat_lowstock'; }
      else if (isReorder) { reply = await this.actions.chatReorder(staff); campaign = 'chat_reorder'; }
      else if (isSpend) { reply = await this.actions.chatSpend(staff, arg1); campaign = 'chat_spend'; }
      else if (isExpense || isAdvance) { reply = await this.actions.chatPettyCash(staff, isAdvance ? 'advance' : 'expense', arg1, parts[2]!, parts.slice(3).join(' ')); campaign = 'chat_pettycash'; }
      else if (isLeave) { reply = await this.actions.chatLeave(staff, arg1, parts[2]!, parts.slice(3).join(' ')); campaign = 'chat_leave'; }
      else if (isSubscribe || isUnsubscribe) { reply = await this.actions.chatDigest(tenantId, staff, isSubscribe, isSubscribe ? parts.slice(2).join(',') : ''); campaign = 'chat_digest'; }
      else if (isSubLow || isUnsubLow) { reply = await this.actions.chatLowStockAlert(tenantId, staff, isSubLow); campaign = 'chat_lowstock_alert'; }
      else if (isDigestKpis) { reply = await this.actions.chatDigestKpis(staff); campaign = 'chat_digest'; }
      else if (isAsk) { reply = await this.actions.chatAsk(staff, parts.slice(1).join(' ')); campaign = 'chat_ask'; }
      else if (isCopilot) {
        const out = await this.chatCopilot(tenantId, lineUserId, staff, text.replace(/^(?:bot\s+|บอท\s*)/i, ''));
        await this.replyChat(tenantId, token, ev?.replyToken, lineUserId, msgId, out.text, 'chat_ai', out.flex);
        return true;
      }
      else reply = await this.actions.chatCreatePr(staff, text);
    }
    await this.replyChat(tenantId, token, ev?.replyToken, lineUserId, msgId, reply, campaign, replyFlex);
    return true;
  }




  // ── LC-1 (docs/30) — one-tap postback approve/reject with a confirm step ─────────────────────────
  // The queue-entry card's [อนุมัติ]/[ปฏิเสธ] buttons post {a:'decide', x, d}. The first tap parks a
  // short-lived confirm state (nonce) and replies a confirm card; tapping [ยืนยัน] posts {a:'confirm',
  // d, n} which consumes the state BEFORE acting (replay-safe) and runs the SAME chatDecision path as the
  // typed command — permission + engine maker-checker/SoD bind identically. No confirm = no action.
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

    const staff = await this.link.staffByLine(tenantId, lineUserId);
    let text: string;
    let flex: any;
    if (!staff) {
      text = NOT_LINKED;
    } else if (data.a === 'decide' && (data.x === 'approve' || data.x === 'reject') && typeof data.d === 'string') {
      const docNo = String(data.d).toUpperCase();
      const nonce = this.link.genCode();
      const expiresAt = new Date(Date.now() + 5 * 60_000);
      await this.db.insert(lineChatStates)
        .values({ tenantId, lineUserId, kind: 'confirm', payload: { action: data.x, docNo, nonce }, expiresAt })
        .onConflictDoUpdate({ target: [lineChatStates.tenantId, lineChatStates.lineUserId], set: { kind: 'confirm', payload: { action: data.x, docNo, nonce }, expiresAt, createdAt: new Date() } });
      text = `ยืนยันการ${data.x === 'approve' ? 'อนุมัติ' : 'ปฏิเสธ'} ${docNo} — กดปุ่มยืนยันภายใน 5 นาที`;
      flex = confirmCard(data.x, docNo, nonce);
    } else if (data.a === 'confirm' && typeof data.d === 'string' && typeof data.n === 'string') {
      const [state] = await this.db.select().from(lineChatStates)
        .where(and(eq(lineChatStates.tenantId, tenantId), eq(lineChatStates.lineUserId, lineUserId), eq(lineChatStates.kind, 'confirm'))).limit(1);
      const p = (state?.payload ?? {}) as { action?: string; docNo?: string; nonce?: string; prText?: string; kind?: string; args?: string[] };
      if (!state || new Date(state.expiresAt).getTime() < Date.now() || p.docNo !== String(data.d).toUpperCase() || p.nonce !== data.n) {
        text = 'คำขอยืนยันหมดอายุหรือไม่ถูกต้อง — กดปุ่มอนุมัติ/ปฏิเสธใหม่อีกครั้ง';
      } else {
        // consume the state BEFORE acting so a redelivered confirm can never act twice
        await this.db.delete(lineChatStates).where(and(eq(lineChatStates.tenantId, tenantId), eq(lineChatStates.lineUserId, lineUserId)));
        // LC-5/LP-2: a confirmed AI draft replays the ordinary command path (same perms + SoD checks)
        const a = p.args ?? [];
        if (p.action === 'copilot-pr' && p.prText) text = await this.actions.chatCreatePr(staff, p.prText); // pre-LP-2 payload shape
        else if (p.action === 'copilot-cmd' && p.kind === 'pr' && a[0]) text = await this.actions.chatCreatePr(staff, a[0]);
        else if (p.action === 'copilot-cmd' && (p.kind === 'expense' || p.kind === 'advance') && a.length >= 2) text = await this.actions.chatPettyCash(staff, p.kind, a[0]!, a[1]!, a[2] ?? '');
        else if (p.action === 'copilot-cmd' && p.kind === 'leave' && a.length >= 2) text = await this.actions.chatLeave(staff, a[0]!, a[1]!, a[2] ?? '');
        else text = await this.actions.chatDecision(staff, p.docNo!, p.action === 'approve');
      }
    } else if (data.a === 'reorder') {
      // D1: the morning low-stock alert's [🛒 สั่งเติมทั้งหมด] button → raise the top-up PR in one tap
      // (same createPr path + pr_raise check as the typed `reorder`; event-id dedupe blocks double-act).
      text = await this.actions.chatReorder(staff);
    } else {
      return false;
    }
    await this.replyChat(tenantId, token, ev?.replyToken, lineUserId, '', text, 'chat_postback', flex, evtId ? `line:evt:${evtId}` : null);
    return true;
  }








  // ── attach <doc no> [invoice|receipt|other] → next photo binds to the document (0228) ─────────────
  // The command validates authority + the target doc NOW and parks a short-lived pending state; the photo
  // that follows (onChatImage) is fetched from the LINE content API and stored as a doc attachment —
  // evidence for the 3-way match (EXP-01 documentation; permission mirrors the web upload endpoint).

  private static readonly ATTACH_PERMS = ['procurement', 'creditors', 'wh_receive'];
  private static readonly ATTACH_TTL_MS = 10 * 60_000;
  // Quick Capture is the low-risk, company-wide maker duty (mirrors the /capture web gate) — draft only.
  private static readonly CAPTURE_PERMS = ['pr_raise', 'procurement', 'creditors'];

  private async chatAttachStart(tenantId: number, lineUserId: string, u: any, docNo: string, kindArg: string): Promise<string> {
    const no = docNo.toUpperCase();
    const docType = no.startsWith('PO-') ? 'PO' : no.startsWith('PR-') ? 'PR' : null;
    if (!docType) return 'แนบได้กับใบสั่งซื้อ/คำขอซื้อ (เลขที่ขึ้นต้น PO- หรือ PR-)';
    const kind = ['invoice', 'receipt', 'other'].includes(kindArg) ? kindArg : kindArg === 'ใบเสร็จ' ? 'receipt' : 'invoice';
    const perms = await this.link.effectivePerms(u);
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

  // ── capture (บิล) → next photo is filed as an AP-intake draft for Accounting (docs/34) ────────────
  // The command validates the low-risk pr_raise duty NOW and parks a pending state; the photo that follows
  // (onChatImage) is fetched from the LINE content API and captured as a NeedsReview draft — never books a
  // bill or touches the GL (booking stays creditors, SoD/EXP-06).
  private async chatCaptureStart(tenantId: number, lineUserId: string, u: any): Promise<string> {
    const perms = await this.link.effectivePerms(u);
    if (!LineWebhookService.CAPTURE_PERMS.some((p) => perms.includes(p))) return 'บัญชีของคุณไม่มีสิทธิ์เก็บบิล (ต้องมี pr_raise)';
    if (!this.apIntakeSvc()) return 'ระบบเก็บบิลยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const expiresAt = new Date(Date.now() + LineWebhookService.ATTACH_TTL_MS);
    await this.db.insert(lineChatStates)
      .values({ tenantId, lineUserId, kind: 'capture', payload: {}, expiresAt })
      .onConflictDoUpdate({ target: [lineChatStates.tenantId, lineChatStates.lineUserId], set: { kind: 'capture', payload: {}, expiresAt, createdAt: new Date() } });
    return 'ส่งรูปบิล/ใบเสร็จมาในแชทนี้ได้เลย (ภายใน 10 นาที) — ระบบจะอ่านข้อมูลและส่งให้ฝ่ายบัญชีตรวจสอบ';
  }

  // A photo from a linked staff member with a live pending state → fetch the bytes from the LINE content
  // API and route by the pending kind: `attach` pins it to a PO/PR document; `capture` files it as an AP
  // intake draft. Any other image (customers, no/other pending state) is ignored.
  private async onChatImage(tenantId: number, token: string | undefined, ev: any): Promise<boolean> {
    const lineUserId = String(ev?.source?.userId ?? '');
    const msgId = String(ev?.message?.id ?? '');
    if (!lineUserId || !msgId) return false;
    const [state] = await this.db.select().from(lineChatStates)
      .where(and(eq(lineChatStates.tenantId, tenantId), eq(lineChatStates.lineUserId, lineUserId), or(eq(lineChatStates.kind, 'attach'), eq(lineChatStates.kind, 'capture')))).limit(1);
    if (!state || new Date(state.expiresAt).getTime() < Date.now()) return false; // no live attach/capture flow → not ours
    const staff = await this.link.staffByLine(tenantId, lineUserId);
    if (!staff) return false;

    // webhook-redelivery dedupe (same mechanism as text commands)
    const [dup] = await this.db.select({ id: messageLog.id }).from(messageLog)
      .where(and(eq(messageLog.tenantId, tenantId), eq(messageLog.providerRef, `line:msg:${msgId}`))).limit(1);
    if (dup) return true;

    if (state.kind === 'capture') return this.onCaptureImage(tenantId, token, ev, staff, lineUserId, msgId);

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
        const perms = await this.link.effectivePerms(staff);
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

  // The `capture` pending flow: fetch the photo and file it as an AP-intake draft via the same EXP-10
  // engine the /capture web lane uses (draft only — never books or posts to the GL).
  private async onCaptureImage(tenantId: number, token: string | undefined, ev: any, staff: any, lineUserId: string, msgId: string): Promise<boolean> {
    let reply: string;
    const apIntake = this.apIntakeSvc();
    if (!apIntake) {
      reply = 'ระบบเก็บบิลยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    } else if (!token) {
      reply = 'ดึงรูปจาก LINE ไม่ได้ (ยังไม่ได้ตั้งค่า channel token ของร้าน)';
    } else {
      const content = await fetchLineContent(token, msgId);
      if ('error' in content) {
        reply = content.error === 'too-large' ? 'รูปใหญ่เกินไป (สูงสุด ~2MB) — ลองถ่ายใหม่หรือลดขนาด' : 'ดึงรูปจาก LINE ไม่สำเร็จ กรุณาส่งใหม่อีกครั้ง';
      } else {
        const perms = await this.link.effectivePerms(staff);
        const jwtUser: JwtUser = { username: staff.username, role: staff.role, customerName: null, tenantId: staff.tenantId != null ? Number(staff.tenantId) : null, permissions: perms };
        try {
          const r: any = await apIntake.capture({ file_name: `line-${msgId}.jpg`, data_url: content.dataUrl }, jwtUser);
          await this.db.delete(lineChatStates).where(and(eq(lineChatStates.tenantId, tenantId), eq(lineChatStates.lineUserId, lineUserId)));
          const detail = r.extract_source === 'none'
            ? 'ยังอ่านอัตโนมัติไม่ได้ — แนบรูปให้ฝ่ายบัญชีตรวจสอบแล้ว'
            : `${r.vendor_name ?? 'ไม่ทราบผู้ขาย'}${r.amount != null ? ` · ${Number(r.amount).toLocaleString('th-TH')} ${r.currency ?? 'THB'}` : ''}`;
          reply = `เก็บบิลแล้ว ✔ ${r.intake_no}\n${detail}\nฝ่ายบัญชีจะตรวจสอบและบันทึกบิลต่อ`;
        } catch (e: any) {
          const msg = e?.response?.messageTh ?? e?.response?.message ?? e?.message ?? 'ไม่ทราบสาเหตุ';
          reply = `เก็บบิลไม่สำเร็จ: ${String(msg).slice(0, 200)}`;
        }
      }
    }
    await this.replyChat(tenantId, token, ev?.replyToken, lineUserId, msgId, reply, 'chat_capture');
    return true;
  }



  // ── LC-3 governance: per-LINE-user rate limit (env-tunable; in-memory per instance) ──────────────
  private readonly rate = new Map<string, { n: number; start: number }>();
  private throttle(tenantId: number, lineUserId: string): 'ok' | 'reply' | 'drop' {
    const limit = Number(process.env.LINE_CHAT_RATE_LIMIT ?? 30);
    const windowMs = Number(process.env.LINE_CHAT_RATE_WINDOW_MS ?? 5 * 60_000);
    const now = Date.now();
    if (this.rate.size > 2000) for (const [k, v] of this.rate) { if (now - v.start > windowMs) this.rate.delete(k); }
    const key = `${tenantId}:${lineUserId}`;
    const e = this.rate.get(key);
    if (!e || now - e.start > windowMs) { this.rate.set(key, { n: 1, start: now }); return 'ok'; }
    e.n++;
    if (e.n <= limit) return 'ok';
    if (e.n === limit + 1) { void this.audit(tenantId, lineUserId, `[chat:throttled] > ${limit}/${Math.round(windowMs / 1000)}s`); return 'reply'; }
    return 'drop';
  }





  private async chatCopilot(tenantId: number, lineUserId: string, u: any, text: string): Promise<{ text: string; flex?: any }> {
    const t = text.trim();
    if (!t) return { text: CHAT_USAGE };
    // read-only stock intent answers immediately (no confirm needed)
    const stockM = /(?:สต็อก|คงเหลือ|เหลือเท่าไหร่|เหลือกี่)\s*(?:ของ\s*)?([A-Za-z0-9-]+)/.exec(t);
    if (stockM) return { text: await this.actions.chatStock(u, stockM[1]!) };
    const draft = this.copilot.rules(t) ?? (await this.copilot.llm(tenantId, t, (cap) => void this.audit(tenantId, 'system', `[chat:ai-cap] copilot LLM daily cap ${cap} reached`)));
    if (!draft) return { text: `ยังไม่เข้าใจคำขอ — ลองพิมพ์คำสั่งโดยตรง:\n${CHAT_USAGE}` };
    const L = DRAFT_LABEL[draft.kind];
    const nonce = this.link.genCode();
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const payload = { action: 'copilot-cmd', docNo: 'AI-DRAFT', kind: draft.kind, args: draft.args, nonce };
    await this.db.insert(lineChatStates)
      .values({ tenantId, lineUserId, kind: 'confirm', payload, expiresAt })
      .onConflictDoUpdate({ target: [lineChatStates.tenantId, lineChatStates.lineUserId], set: { kind: 'confirm', payload, expiresAt, createdAt: new Date() } });
    return {
      text: `${L.title}: ${draft.summary}\nกด "${L.btn}" ภายใน 5 นาที (ไม่ยืนยัน = ไม่ดำเนินการ)`,
      flex: {
        type: 'bubble',
        body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          { type: 'text', text: '🤖 ร่างจากข้อความของคุณ', size: 'sm', color: '#8a6d1d' },
          { type: 'text', text: L.title, size: 'xs', color: '#888888' },
          { type: 'text', text: draft.summary, weight: 'bold', size: 'md', wrap: true },
        ] },
        footer: { type: 'box', layout: 'horizontal', contents: [
          { type: 'button', style: 'primary', height: 'sm', action: { type: 'postback', label: L.btn, data: JSON.stringify({ a: 'confirm', d: 'AI-DRAFT', n: nonce }), displayText: L.btn } },
        ] },
      },
    };
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

  // Chat audit rows live in LineLinkService (shared with link/unlink); thin delegate keeps call sites.
  private audit(tenantId: number | null, recipient: string, body: string) {
    return this.link.audit(tenantId, recipient, body);
  }

}

@Controller('api/line')
export class LineWebhookController {
  constructor(private readonly svc: LineWebhookService, private readonly link: LineLinkService) {}

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
  linkCode(@CurrentUser() u: JwtUser) { return this.link.issueLinkCode(u); }

  @Get('link') @Permissions('pr_raise', 'procurement', 'planner')
  linkStatus(@CurrentUser() u: JwtUser) { return this.link.linkStatus(u); }

  @Delete('link') @Permissions('pr_raise', 'procurement', 'planner')
  unlink(@CurrentUser() u: JwtUser) { return this.link.unlink(u); }

  // LC-3 governance — admin link registry + force-unlink (offboarding). Perm `users` (AccessAdmin).
  @Get('links') @Permissions('users')
  listLinks() { return this.link.listLinks(); }

  @Delete('links/:username') @Permissions('users')
  adminUnlink(@Param('username') username: string, @CurrentUser() u: JwtUser) { return this.link.adminUnlink(username, u); }
}
