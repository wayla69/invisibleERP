import { Controller, Post, Get, Delete, Param, Req, Headers, Inject, Injectable, Logger, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { createHmac, randomInt } from 'node:crypto';
import { eq, and, or, desc, ilike, isNotNull } from 'drizzle-orm';
import { resolvePermissions, type Role, type Permission } from '@ierp/shared';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenants, posMembers, messageLog, users, userPermissions, purchaseRequests, items, invBalances, lineChatStates } from '../../database/schema';
import { reportSubscriptions } from '../../database/schema/bi';
import { safeEqualStr } from '../../common/crypto';
import { isUniqueViolation } from '../../common/db-error';
import { Public, NoTx, Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { TenantMessagingService } from './tenant-messaging.service';
import { replyLine, replyLineFlex, fetchLineContent, type SendResult } from './gateways';
import { ProcurementService } from '../procurement/procurement.service';
import { ClaimsService } from '../claims/claims.service';
import { AttachmentsService } from '../procurement/attachments.service';
import { PettyCashService } from '../petty-cash/petty-cash.service';
import { EssService } from '../ess/ess.service';
import { PmrService } from '../pmr/pmr.service';
import { NlAnalyticsService } from '../nl-analytics/nl-analytics.service';
import { llmClient } from '../../common/llm-client';
import { modelFor, aiDpaBlocked } from '../../common/ai-models';
import { DIGEST_KPIS, DEFAULT_DIGEST_KPIS, allowedDigestKpis } from '../bi/digest-kpis';
import { z } from 'zod';

// LP-2 (docs/31) — a copilot DRAFT: which text-command handler to replay on confirm + its args.
// pr: args = [full `pr …` command text] · expense/advance: [fund, amount, reason] · leave: [from, days, reason]
type CopilotDraft = { kind: 'pr' | 'expense' | 'advance' | 'leave'; args: string[]; summary: string };

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

  private static readonly CHAT_USAGE =
    'รูปแบบคำสั่ง:\n• pr <รหัสสินค้า> <จำนวน> [เหตุผล — ไม่ใส่ก็ได้] — สร้างคำขอซื้อ (หลายรายการคั่นด้วย , หรือขึ้นบรรทัดใหม่)\n• status <เลขที่ PR> — เช็คสถานะ · my prs — คำขอล่าสุดของฉัน · cancel <เลขที่ PR> — ถอนคำขอ\n• find <คำค้น> — ค้นหารหัสสินค้า · stock <รหัสสินค้า> — ดูยอดคงเหลือ · low — สินค้าใกล้หมด · reorder — เปิด PR เติมของทั้งหมด\n• attach <เลขที่ PO> — แนบรูปใบแจ้งหนี้/ใบเสร็จ · receive <เลขที่ PO> [<รหัสสินค้า> <จำนวน>] — รับครบ/รับบางส่วน · claim <PO/GR> <จำนวน> [เหตุผล] — แจ้งของขาด/เสีย\n• expense/advance <กองทุน> <จำนวนเงิน> [เหตุผล] — เบิกเงินสดย่อย\n• leave <จากวันที่ YYYY-MM-DD> <จำนวนวัน> [เหตุผล] — ส่งใบลา · subscribe digest [kpi,…] — รับสรุปประจำวัน (digest kpis = ดู KPI ที่เลือกได้) · subscribe lowstock — แจ้งเตือนของใกล้หมดทุกเช้า\n• ask <คำถาม> — ถามยอดขาย (เช่น ask ยอดขายตามสาขา) · บอท <ข้อความ> — ให้ AI ร่างคำขอซื้อ (ยืนยันก่อนสร้างเสมอ) · spend [YYYY-MM] — สรุปยอดซื้อ\n• approve/reject <เลขที่ PR> — อนุมัติ/ปฏิเสธ (เฉพาะทีมจัดซื้อ)\nเช่น  pr A4-PAPER 10  (สั่งเฉย ๆ ไม่ต้องมีเหตุผล) · หลายรายการ  pr A4-PAPER 10, TONER-85A 2';

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
    if (!isLink && !isStatus && !isApprove && !isReject && !isMyPrs && !isFind && !isCancel && !isStock && !isAttach && !isReceive && !isClaim && !isLow && !isReorder && !isSpend && !isExpense && !isAdvance && !isLeave && !isSubscribe && !isUnsubscribe && !isSubLow && !isUnsubLow && !isDigestKpis && !isAsk && !isCopilot && !isHelp && !isPr) return false;

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
      const res = await this.linkStaff(tenantId, lineUserId, arg1.toUpperCase());
      reply = res.text; replyFlex = res.flex;
      campaign = 'chat_link';
    } else if (isHelp) {
      reply = LineWebhookService.CHAT_USAGE; // altText / non-flex fallback
      replyFlex = LineWebhookService.helpCard('เมนูคำสั่ง', 'พิมพ์คำสั่งด้านล่างได้เลย');
      campaign = 'chat_help';
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
      else if (isReceive) { reply = await this.chatReceive(staff, arg1, parts.slice(2)); campaign = 'chat_receive'; }
      else if (isClaim) { reply = await this.chatClaim(staff, arg1, parts[2]!, parts.slice(3).join(' ')); campaign = 'chat_claim'; }
      else if (isLow) { reply = await this.chatLowStock(staff); campaign = 'chat_lowstock'; }
      else if (isReorder) { reply = await this.chatReorder(staff); campaign = 'chat_reorder'; }
      else if (isSpend) { reply = await this.chatSpend(staff, arg1); campaign = 'chat_spend'; }
      else if (isExpense || isAdvance) { reply = await this.chatPettyCash(staff, isAdvance ? 'advance' : 'expense', arg1, parts[2]!, parts.slice(3).join(' ')); campaign = 'chat_pettycash'; }
      else if (isLeave) { reply = await this.chatLeave(staff, arg1, parts[2]!, parts.slice(3).join(' ')); campaign = 'chat_leave'; }
      else if (isSubscribe || isUnsubscribe) { reply = await this.chatDigest(tenantId, staff, isSubscribe, isSubscribe ? parts.slice(2).join(',') : ''); campaign = 'chat_digest'; }
      else if (isSubLow || isUnsubLow) { reply = await this.chatLowStockAlert(tenantId, staff, isSubLow); campaign = 'chat_lowstock_alert'; }
      else if (isDigestKpis) { reply = await this.chatDigestKpis(staff); campaign = 'chat_digest'; }
      else if (isAsk) { reply = await this.chatAsk(staff, parts.slice(1).join(' ')); campaign = 'chat_ask'; }
      else if (isCopilot) {
        const out = await this.chatCopilot(tenantId, lineUserId, staff, text.replace(/^(?:bot\s+|บอท\s*)/i, ''));
        await this.replyChat(tenantId, token, ev?.replyToken, lineUserId, msgId, out.text, 'chat_ai', out.flex);
        return true;
      }
      else reply = await this.chatCreatePr(staff, text);
    }
    await this.replyChat(tenantId, token, ev?.replyToken, lineUserId, msgId, reply, campaign, replyFlex);
    return true;
  }

  // approve/reject <PR no> — the chat approval channel (0228). The permission mirrors the web endpoint
  // (`procurement`), and the decision routes through ProcurementService.approvePr → the workflow engine,
  // so maker-checker/SoD and multi-level chains bind exactly as on the web.
  private async chatDecision(u: any, docNo: string, approve: boolean): Promise<string> {
    const doc = docNo.toUpperCase();
    // M2 (docs/32) — an over-budget Project Material Requisition (PMR-...) approval routes to PmrService, which
    // enforces the same maker-checker (approver ≠ requester) and, on approval, auto-drafts the project PO.
    if (doc.startsWith('PMR-')) return this.chatDecidePmr(u, doc, approve);
    const prNo = doc;
    if (!prNo.startsWith('PR-')) return 'อนุมัติผ่านแชทได้เฉพาะคำขอซื้อ (PR-) หรือใบขอเบิกวัสดุ (PMR-)';
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

  // M2 (docs/32) — approve/reject an over-budget PMR from chat. Requires procurement/exec; PmrService enforces
  // maker-checker (approver ≠ requester) and, on approval, auto-drafts the project-tagged PO.
  private async chatDecidePmr(u: any, pmrNo: string, approve: boolean): Promise<string> {
    const perms = await this.effectivePerms(u);
    if (!perms.some((p) => ['procurement', 'exec'].includes(p))) return 'บัญชีของคุณไม่มีสิทธิ์อนุมัติใบขอเบิกวัสดุ (procurement/exec)';
    const pmr = this.pmrSvc();
    if (!pmr) return 'ระบบใบขอเบิกวัสดุยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    try {
      const res = approve ? await pmr.approve(pmrNo, jwtUser) : await pmr.reject(pmrNo, 'ปฏิเสธผ่านแชท', jwtUser);
      if (approve) return `${pmrNo}: อนุมัติแล้ว ✅ — ร่างใบสั่งซื้อ ${res.linked_doc_no ?? '-'} ให้ฝ่ายจัดซื้อ`;
      return `${pmrNo}: ปฏิเสธแล้ว ❌`;
    } catch (e: any) {
      if (e?.response?.code === 'SOD_SELF_APPROVAL') return `${pmrNo}: อนุมัติไม่ได้ — ผู้ขอเบิกอนุมัติเองไม่ได้ (SOD)`;
      const msg = e?.response?.messageTh ?? e?.response?.message ?? e?.message ?? 'ไม่ทราบสาเหตุ';
      return `${pmrNo}: ดำเนินการไม่สำเร็จ — ${String(msg).slice(0, 200)}`;
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
      const p = (state?.payload ?? {}) as { action?: string; docNo?: string; nonce?: string; prText?: string; kind?: string; args?: string[] };
      if (!state || new Date(state.expiresAt).getTime() < Date.now() || p.docNo !== String(data.d).toUpperCase() || p.nonce !== data.n) {
        text = 'คำขอยืนยันหมดอายุหรือไม่ถูกต้อง — กดปุ่มอนุมัติ/ปฏิเสธใหม่อีกครั้ง';
      } else {
        // consume the state BEFORE acting so a redelivered confirm can never act twice
        await this.db.delete(lineChatStates).where(and(eq(lineChatStates.tenantId, tenantId), eq(lineChatStates.lineUserId, lineUserId)));
        // LC-5/LP-2: a confirmed AI draft replays the ordinary command path (same perms + SoD checks)
        const a = p.args ?? [];
        if (p.action === 'copilot-pr' && p.prText) text = await this.chatCreatePr(staff, p.prText); // pre-LP-2 payload shape
        else if (p.action === 'copilot-cmd' && p.kind === 'pr' && a[0]) text = await this.chatCreatePr(staff, a[0]);
        else if (p.action === 'copilot-cmd' && (p.kind === 'expense' || p.kind === 'advance') && a.length >= 2) text = await this.chatPettyCash(staff, p.kind, a[0]!, a[1]!, a[2] ?? '');
        else if (p.action === 'copilot-cmd' && p.kind === 'leave' && a.length >= 2) text = await this.chatLeave(staff, a[0]!, a[1]!, a[2] ?? '');
        else text = await this.chatDecision(staff, p.docNo!, p.action === 'approve');
      }
    } else if (data.a === 'reorder') {
      // D1: the morning low-stock alert's [🛒 สั่งเติมทั้งหมด] button → raise the top-up PR in one tap
      // (same createPr path + pr_raise check as the typed `reorder`; event-id dedupe blocks double-act).
      text = await this.chatReorder(staff);
    } else {
      return false;
    }
    await this.replyChat(tenantId, token, ev?.replyToken, lineUserId, '', text, 'chat_postback', flex, evtId ? `line:evt:${evtId}` : null);
    return true;
  }

  // receive <PO no> [<item> <qty>] — warehouse receives goods on an approved PO from chat. Perm wh_receive
  // (or warehouse/procurement), re-resolved per command; the service enforces the EXP-03 approval gate,
  // posts stock + lot movements and auto-closes the PO — the chat only triggers the ordinary GR path.
  // With a trailing item + qty (D4) it receives a PARTIAL quantity of that one line; otherwise all of it.
  private async chatReceive(u: any, docNo: string, rest: string[] = []): Promise<string> {
    const poNo = docNo.toUpperCase();
    if (!poNo.startsWith('PO-')) return 'รับของผ่านแชทได้เฉพาะใบสั่งซื้อ (เลขที่ขึ้นต้น PO-)';
    const perms = await this.effectivePerms(u);
    if (!perms.includes('wh_receive') && !perms.includes('warehouse') && !perms.includes('procurement')) {
      return 'บัญชีของคุณไม่มีสิทธิ์รับของ (ต้องมี wh_receive / warehouse / procurement)';
    }
    const procurement = this.procurementSvc();
    if (!procurement) return 'ระบบจัดซื้อยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    // D4 — partial: `receive <PO> <item id…> <qty>` (qty is the LAST token; the item id is everything before it).
    const qtyMaybe = rest.length >= 2 ? Number(rest[rest.length - 1]) : NaN;
    const itemId = rest.slice(0, -1).join(' ').trim();
    try {
      if (Number.isFinite(qtyMaybe) && qtyMaybe > 0 && itemId) {
        const res = await procurement.receiveItem(poNo, itemId.toUpperCase(), qtyMaybe, jwtUser);
        const th = res.po_status === 'Closed' ? 'รับครบแล้ว ✅ (ปิด PO)' : 'รับบางส่วนแล้ว';
        return `${poNo}: ${th}\nรับ ${itemId.toUpperCase()} × ${qtyMaybe} · ใบรับของ ${res.gr_no}`;
      }
      const res = await procurement.receiveAllRemaining(poNo, jwtUser);
      const th = res.po_status === 'Closed' ? 'รับครบแล้ว ✅ (ปิด PO)' : 'รับบางส่วนแล้ว';
      return `${poNo}: ${th}\nใบรับของ ${res.gr_no} · ${res.lines} รายการ`;
    } catch (e: any) {
      const msg = e?.response?.messageTh ?? e?.response?.message ?? e?.message ?? 'ไม่ทราบสาเหตุ';
      return `${poNo}: รับของไม่ได้ — ${String(msg).slice(0, 200)}`;
    }
  }

  // claim <PO/GR no> <qty> [เหตุผล] — open a goods-receipt claim (short/damaged delivery) from chat. Perm
  // procurement/wh_receive. Opens a GRC- via ClaimsService; procurement finishes the detail on /claims.
  private async chatClaim(u: any, docNo: string, qtyStr: string, reason: string): Promise<string> {
    const doc = docNo.toUpperCase();
    if (!doc.startsWith('PO-') && !doc.startsWith('GR-')) return 'เปิดเคลมได้เฉพาะใบสั่งซื้อ/ใบรับของ (เลขที่ขึ้นต้น PO- หรือ GR-)';
    const qty = Number(qtyStr);
    if (!Number.isFinite(qty) || qty <= 0) return 'ระบุจำนวนที่เคลม เช่น claim GR-20260101-001 2 ของแตก';
    const perms = await this.effectivePerms(u);
    if (!perms.includes('procurement') && !perms.includes('wh_receive') && !perms.includes('warehouse')) {
      return 'บัญชีของคุณไม่มีสิทธิ์เปิดเคลม (ต้องมี procurement / wh_receive)';
    }
    const claims = this.claimsSvc();
    if (!claims) return 'ระบบเคลมยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    try {
      const dto = doc.startsWith('GR-') ? { gr_no: doc, claim_qty: qty, reason: reason || 'แจ้งของขาด/เสียผ่านแชท' } : { po_no: doc, claim_qty: qty, reason: reason || 'แจ้งของขาด/เสียผ่านแชท' };
      const res = await claims.createGrClaim(dto, jwtUser);
      return `เปิดเคลมแล้ว ✅ ${res.claim_no} (${doc} × ${qty})\nทีมจัดซื้อจะติดตามกับผู้ขายที่หน้าเคลม (/claims)`;
    } catch (e: any) {
      const msg = e?.response?.messageTh ?? e?.response?.message ?? e?.message ?? 'ไม่ทราบสาเหตุ';
      return `เปิดเคลมไม่ได้ — ${String(msg).slice(0, 200)}`;
    }
  }

  // low — read-only list of items at/below their reorder point (on-hand vs items.min_stock), tenant-scoped.
  // A hint points at `reorder` to raise the top-up PR in one tap. Any pr_raise-capable linked user may look.
  private async chatLowStock(u: any): Promise<string> {
    const procurement = this.procurementSvc();
    if (!procurement) return 'ระบบจัดซื้อยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const perms = await this.effectivePerms(u);
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    const { items: low, count } = await procurement.lowStock(jwtUser, { limit: 10 });
    if (!count) return 'สินค้าใกล้หมด: ไม่มี ✅ (ทุกอย่างสูงกว่าจุดสั่งซื้อ)';
    const lines = low.map((x: any) => `• ${x.item_id} — เหลือ ${x.on_hand}${x.uom ? ` ${x.uom}` : ''} (จุดสั่งซื้อ ${x.min_stock}) → แนะนำ ${x.suggested_qty}`);
    const more = count > low.length ? `\n…และอีก ${count - low.length} รายการ` : '';
    return `สินค้าใกล้หมด ${count} รายการ:\n${lines.join('\n')}${more}\nพิมพ์ reorder เพื่อเปิด PR เติมทั้งหมดในครั้งเดียว`;
  }

  // reorder — one-tap: raise a SINGLE PR covering every low-stock item at its suggested top-up qty.
  // Runs the ordinary createPr path (needs pr_raise), so numbering/status-log/workflow are unchanged.
  private async chatReorder(u: any): Promise<string> {
    const procurement = this.procurementSvc();
    if (!procurement) return 'ระบบจัดซื้อยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const perms = await this.effectivePerms(u);
    if (!perms.includes('pr_raise') && !perms.includes('procurement') && !perms.includes('planner')) {
      return 'บัญชีของคุณไม่มีสิทธิ์เปิดคำขอซื้อ (ต้องมี pr_raise)';
    }
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    try {
      const res = await procurement.reorderPr(jwtUser);
      const head = res.items.slice(0, 8).map((x: any) => `• ${x.item_id} × ${x.qty}`).join('\n');
      const more = res.items.length > 8 ? `\n…และอีก ${res.items.length - 8} รายการ` : '';
      return `เปิดคำขอซื้อเติมสต็อกแล้ว ✅ ${res.pr_no} (${res.lines} รายการ)\n${head}${more}\nสถานะ: ${res.status === 'Pending' ? 'รออนุมัติ' : res.status}`;
    } catch (e: any) {
      const msg = e?.response?.messageTh ?? e?.response?.message ?? e?.message ?? 'ไม่ทราบสาเหตุ';
      return `เปิด PR เติมสต็อกไม่ได้ — ${String(msg).slice(0, 200)}`;
    }
  }

  // D3 — `spend [YYYY-MM]` (`ยอดซื้อ`/`สรุปซื้อ`): purchase spend for a business month — total, top vendors,
  // most-bought items. Read-only; gated on a buyer/analytics permission (procurement/planner/exec/dashboard).
  private async chatSpend(u: any, arg: string): Promise<string> {
    const procurement = this.procurementSvc();
    if (!procurement) return 'ระบบจัดซื้อยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const perms = await this.effectivePerms(u);
    if (!['procurement', 'planner', 'exec', 'dashboard'].some((p) => perms.includes(p))) {
      return 'บัญชีของคุณไม่มีสิทธิ์ดูยอดซื้อ (ต้องมี procurement / exec / dashboard)';
    }
    const period = /^\d{4}-\d{2}$/.test(arg) ? arg : undefined;
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    try {
      const s = await procurement.purchaseSpend(jwtUser, { period });
      const money = (v: number) => v.toLocaleString('th-TH', { maximumFractionDigits: 2 });
      if (!s.po_count) return `💰 ยอดซื้อเดือน ${s.period}: ยังไม่มีใบสั่งซื้อ`;
      const vendors = s.by_vendor.slice(0, 5).map((v: any) => `• ${v.vendor} — ฿${money(v.total)} (${v.po_count} ใบ)`).join('\n');
      const items = s.top_items.slice(0, 5).map((i: any) => `• ${i.item_id} — ${money(i.qty)} หน่วย (฿${money(i.value)})`).join('\n');
      return `💰 ยอดซื้อเดือน ${s.period}: ฿${money(s.total)} · ${s.po_count} ใบสั่งซื้อ\nผู้ขายสูงสุด:\n${vendors}\nสินค้าซื้อมากสุด:\n${items}`;
    } catch (e: any) {
      return `ดูยอดซื้อไม่ได้ — ${String(e?.response?.messageTh ?? e?.message ?? 'ไม่ทราบสาเหตุ').slice(0, 200)}`;
    }
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

  // ── LC-2 (docs/30) — petty-cash self-service: `expense <fund> <amount> [purpose]` / `advance …` ──
  // RAISE-only, exactly like the web maker: creates a PEX- request (PendingApproval, NO GL) through the
  // same PettyCashService path; approval stays on /petty-cash (chat money-DECISIONS deferred per plan).
  // Permission mirrors the web endpoint (`creditors`/`exec`); the service's own guards (fund existence,
  // FUND_CLOSED, INSUFFICIENT_FLOAT) apply unchanged, and its LC-2 hooks notify the approvers.
  private async chatPettyCash(u: any, kind: 'expense' | 'advance', fundCode: string, amountStr: string, purpose: string): Promise<string> {
    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) return `จำนวนเงินไม่ถูกต้อง — รูปแบบ: ${kind} <รหัสกองทุน> <จำนวนเงิน> [เหตุผล]`;
    const perms = await this.effectivePerms(u);
    if (!perms.includes('creditors') && !perms.includes('exec')) return 'บัญชีของคุณไม่มีสิทธิ์เบิกเงินสดย่อย (ต้องมี creditors หรือ exec)';
    const pettyCash = this.pettyCashSvc();
    if (!pettyCash) return 'ระบบเงินสดย่อยยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    try {
      const res = await pettyCash.createRequest({ fund_code: fundCode.toUpperCase(), kind, amount, purpose: purpose || undefined }, jwtUser);
      return `สร้างคำขอ${kind === 'advance' ? 'เงินยืม' : 'เบิกค่าใช้จ่าย'}แล้ว ✔ เลขที่ ${res.req_no} (${res.amount} บาท, รออนุมัติ) — จะแจ้งเตือนเมื่อมีการอนุมัติ`;
    } catch (e: any) {
      const msg = e?.response?.messageTh ?? e?.response?.message ?? e?.message ?? 'ไม่ทราบสาเหตุ';
      return `สร้างคำขอไม่สำเร็จ: ${String(msg).slice(0, 200)}`;
    }
  }

  // ── LC-3 (docs/30) — `leave <from YYYY-MM-DD> <days> [เหตุผล]` → ESS self-service leave request ──
  // Same path as the web (/ess): requires the `ess` permission and a linked employee record
  // (ESS_NO_EMPLOYEE binds unchanged); to_date is derived from <from>+<days>. The ESS hook notifies the
  // leave approvers; approval stays on /hcm.
  private async chatLeave(u: any, fromDate: string, daysStr: string, reason: string): Promise<string> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) return 'รูปแบบวันที่ไม่ถูกต้อง — leave <จากวันที่ YYYY-MM-DD> <จำนวนวัน> [เหตุผล]';
    const days = Number(daysStr);
    if (!Number.isFinite(days) || days <= 0 || days > 60) return 'จำนวนวันลาไม่ถูกต้อง (1–60) — leave <จากวันที่> <จำนวนวัน> [เหตุผล]';
    const perms = await this.effectivePerms(u);
    if (!perms.includes('ess')) return 'บัญชีของคุณไม่มีสิทธิ์ลางานผ่านระบบ (ess)';
    const ess = this.essSvc();
    if (!ess) return 'ระบบลางานยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const to = new Date(`${fromDate}T00:00:00Z`);
    to.setUTCDate(to.getUTCDate() + Math.ceil(days) - 1);
    const toDate = to.toISOString().slice(0, 10);
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    try {
      const res = await ess.requestLeave({ from_date: fromDate, to_date: toDate, days, reason: reason || undefined }, jwtUser);
      return `ส่งใบลาแล้ว ✔ #${res.id} — ${days} วัน (${fromDate} → ${toDate}) สถานะรออนุมัติ — จะแจ้งเตือนเมื่ออนุมัติ`;
    } catch (e: any) {
      const msg = e?.response?.messageTh ?? e?.response?.message ?? e?.message ?? 'ไม่ทราบสาเหตุ';
      return `ส่งใบลาไม่สำเร็จ: ${String(msg).slice(0, 200)}`;
    }
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

  // ── LC-3 governance: admin link registry (ITGC-AC — offboarding evidence) ─────────────────────────
  async listLinks() {
    const rows = await this.db.select({ username: users.username, role: users.role, tenantId: users.tenantId, lineUserId: users.lineUserId, isActive: users.isActive })
      .from(users).where(isNotNull(users.lineUserId)).orderBy(users.username);
    return {
      links: rows.map((r: any) => ({
        username: r.username, role: r.role, tenant_id: r.tenantId != null ? Number(r.tenantId) : null,
        line_user_id_masked: `${String(r.lineUserId).slice(0, 5)}…`, active: r.isActive !== false,
      })),
      count: rows.length,
    };
  }

  // Force-unlink for offboarding: clears the binding + any pending chat state, audit-logged. The chat
  // channel dies immediately even if the account was left active by mistake.
  async adminUnlink(username: string, actor: JwtUser) {
    const [u] = await this.db.select({ id: users.id, lineUserId: users.lineUserId, tenantId: users.tenantId }).from(users).where(eq(users.username, username)).limit(1);
    if (!u?.lineUserId) throw new NotFoundException({ code: 'NOT_LINKED', message: 'User has no linked LINE account', messageTh: 'ผู้ใช้นี้ไม่ได้เชื่อม LINE' });
    await this.db.update(users).set({ lineUserId: null, lineLinkCode: null, lineLinkExpiresAt: null }).where(eq(users.id, u.id));
    await this.db.delete(lineChatStates).where(eq(lineChatStates.lineUserId, String(u.lineUserId)));
    await this.audit(u.tenantId != null ? Number(u.tenantId) : actor.tenantId ?? null, String(u.lineUserId), `[chat:admin-unlink] ${username} by ${actor.username}`);
    return { username, unlinked: true };
  }

  // ── LC-4 (docs/30) — `subscribe digest` / `unsubscribe digest`: opt in/out of the LINE morning
  // digest. Self-service, but permission-at-subscribe applies (the digest carries approval/PR/alert
  // counts → requires dashboard/fin_report/exec). The opt-in rides the tenant's single
  // `line_daily_digest` report subscription as a {line_user} recipient — the BI scheduler delivers it
  // daily; force-unlink (LC-3) silences it automatically because delivery resolves the link registry.
  private async chatDigest(tenantId: number, u: any, on: boolean, kpiList = ''): Promise<string> {
    const perms = await this.effectivePerms(u);
    if (on && !perms.includes('dashboard') && !perms.includes('fin_report') && !perms.includes('exec')) {
      return 'บัญชีของคุณไม่มีสิทธิ์รับสรุปประจำวัน (ต้องมี dashboard / fin_report / exec)';
    }
    // LP-3: optional per-subscriber KPI selection — `subscribe digest sales_yesterday,cash_position`.
    // Keys are validated against the catalog AND the caller's current permissions (delivery re-filters
    // at send time anyway, but refusing an un-seeable key here beats a silently thinner digest later).
    let kpis: string[] | null = null;
    if (on && kpiList.trim()) {
      const wanted = kpiList.split(/[,\s]+/).map((k) => k.trim().toLowerCase()).filter(Boolean);
      const mine = allowedDigestKpis(perms);
      const bad = wanted.filter((k) => !DIGEST_KPIS[k]);
      if (bad.length) return `ไม่รู้จัก KPI: ${bad.join(', ')} — พิมพ์ "digest kpis" เพื่อดูรายการที่เลือกได้`;
      const denied = wanted.filter((k) => !mine.includes(k));
      if (denied.length) return `บัญชีของคุณไม่มีสิทธิ์เห็น: ${denied.join(', ')} — พิมพ์ "digest kpis" เพื่อดูรายการของคุณ`;
      kpis = wanted;
    }
    const [sub] = await this.db.select().from(reportSubscriptions)
      .where(and(eq(reportSubscriptions.tenantId, tenantId), eq(reportSubscriptions.reportType, 'line_daily_digest'))).limit(1);
    const recipients: Array<{ line_user?: string; email?: string; kpis?: string[] }> = Array.isArray(sub?.recipients) ? [...(sub!.recipients as Array<{ line_user?: string; email?: string; kpis?: string[] }>)] : [];
    const idx = recipients.findIndex((r: any) => r?.line_user === u.username);
    if (on) {
      const entry: { line_user: string; kpis?: string[] } = { line_user: u.username, ...(kpis ? { kpis } : {}) };
      if (idx >= 0) recipients[idx] = entry; else recipients.push(entry);
      if (sub) await this.db.update(reportSubscriptions).set({ recipients, isActive: true }).where(eq(reportSubscriptions.id, sub.id));
      else await this.db.insert(reportSubscriptions).values({ tenantId, name: 'LINE Daily Digest', reportType: 'line_daily_digest', filters: {}, frequency: 'daily', recipients, isActive: true, nextRunAt: new Date(), createdBy: 'system:line-chat' });
      const picked = kpis ? ` (${kpis.map((k) => DIGEST_KPIS[k]!.th).join(' · ')})` : '';
      return `รับสรุปประจำวันทาง LINE แล้ว ✔${picked} (ส่งทุกเช้าตามรอบรายงาน) — พิมพ์ "unsubscribe digest" เพื่อยกเลิก`;
    }
    if (!sub || idx < 0) return 'คุณยังไม่ได้รับสรุปประจำวันอยู่แล้ว';
    await this.db.update(reportSubscriptions).set({ recipients: recipients.filter((r: any) => r?.line_user !== u.username) }).where(eq(reportSubscriptions.id, sub.id));
    return 'ยกเลิกการรับสรุปประจำวันแล้ว ✔';
  }

  // D1 — subscribe/unsubscribe the morning low-stock reorder alert (report type `low_stock_reorder_alert`).
  // Gated on pr_raise, since the whole point is to reorder; the scheduler delivers it (with a one-tap
  // [สั่งเติมทั้งหมด] button) once per day and only when something is actually low. Force-unlink silences it.
  private async chatLowStockAlert(tenantId: number, u: any, on: boolean): Promise<string> {
    const perms = await this.effectivePerms(u);
    if (on && !perms.includes('pr_raise') && !perms.includes('procurement') && !perms.includes('planner')) {
      return 'บัญชีของคุณไม่มีสิทธิ์รับแจ้งเตือนสินค้าใกล้หมด (ต้องมี pr_raise)';
    }
    const [sub] = await this.db.select().from(reportSubscriptions)
      .where(and(eq(reportSubscriptions.tenantId, tenantId), eq(reportSubscriptions.reportType, 'low_stock_reorder_alert'))).limit(1);
    const recipients: Array<{ line_user?: string; email?: string }> = Array.isArray(sub?.recipients) ? [...(sub!.recipients as Array<{ line_user?: string; email?: string }>)] : [];
    const idx = recipients.findIndex((r: any) => r?.line_user === u.username);
    if (on) {
      if (idx < 0) recipients.push({ line_user: u.username });
      if (sub) await this.db.update(reportSubscriptions).set({ recipients, isActive: true }).where(eq(reportSubscriptions.id, sub.id));
      else await this.db.insert(reportSubscriptions).values({ tenantId, name: 'LINE Low-stock Reorder Alert', reportType: 'low_stock_reorder_alert', filters: {}, frequency: 'daily', recipients, isActive: true, nextRunAt: new Date(), createdBy: 'system:line-chat' });
      return 'รับแจ้งเตือนสินค้าใกล้หมดทาง LINE แล้ว ✔ (ส่งทุกเช้าเมื่อมีของถึงจุดสั่งซื้อ พร้อมปุ่มสั่งเติม) — พิมพ์ "unsubscribe lowstock" เพื่อยกเลิก';
    }
    if (!sub || idx < 0) return 'คุณยังไม่ได้รับแจ้งเตือนสินค้าใกล้หมดอยู่แล้ว';
    await this.db.update(reportSubscriptions).set({ recipients: recipients.filter((r: any) => r?.line_user !== u.username) }).where(eq(reportSubscriptions.id, sub.id));
    return 'ยกเลิกการรับแจ้งเตือนสินค้าใกล้หมดแล้ว ✔';
  }

  // LP-3 — `digest kpis`: list the catalog keys THIS user's permissions may see (permission-aware menu).
  // Gated like `subscribe digest` — the baseline trio is permissionless, so the menu (not the KPI list)
  // carries the subscriber gate.
  private async chatDigestKpis(u: any): Promise<string> {
    const perms = await this.effectivePerms(u);
    if (!perms.includes('dashboard') && !perms.includes('fin_report') && !perms.includes('exec')) {
      return 'บัญชีของคุณไม่มีสิทธิ์รับสรุปประจำวัน (ต้องมี dashboard / fin_report / exec)';
    }
    const mine = allowedDigestKpis(perms);
    const dflt = new Set(DEFAULT_DIGEST_KPIS);
    return 'KPI ที่เลือกได้สำหรับสรุปประจำวันของคุณ:\n'
      + mine.map((k) => `• ${k} — ${DIGEST_KPIS[k]!.th}${dflt.has(k) ? ' (ค่าเริ่มต้น)' : ''}`).join('\n')
      + '\nเลือกโดยพิมพ์: subscribe digest <kpi,kpi,…>';
  }

  // ── LC-5 (docs/30) — read-only NL analytics: `ask <คำถาม>` via the governed nl-analytics engine ──
  // Same permission gate as POST /api/nl/ask (exec/dashboard/masterdata) — chat is no data bypass. The
  // query engine is whitelist-only + RLS-scoped; NL never produces raw SQL.
  private async chatAsk(u: any, question: string): Promise<string> {
    const perms = await this.effectivePerms(u);
    if (!perms.includes('exec') && !perms.includes('dashboard') && !perms.includes('masterdata')) {
      return 'บัญชีของคุณไม่มีสิทธิ์ถามข้อมูลวิเคราะห์ (ต้องมี dashboard / exec / masterdata)';
    }
    const nl = this.nlSvc();
    if (!nl) return 'ระบบวิเคราะห์ยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    try {
      const res: any = await nl.ask(question, jwtUser);
      const rows: any[] = res?.result?.rows ?? [];
      if (!rows.length) return `ไม่มีข้อมูลสำหรับ "${question}" (มิติ: ${res?.resolved?.dimension ?? '-'})`;
      const top = rows.slice(0, 5).map((r: any) => `• ${r.dim}: ${Number(r.sales_total).toLocaleString('th-TH')} บาท (${r.orders} บิล)`).join('\n');
      return `ยอดขายตาม ${res.resolved?.dimension ?? '-'}:\n${top}\nดูเต็มที่หน้า /query`;
    } catch (e: any) {
      const msg = e?.response?.messageTh ?? e?.message ?? 'ไม่ทราบสาเหตุ';
      return `ถามไม่สำเร็จ: ${String(msg).slice(0, 200)}`;
    }
  }

  // ── LC-5 (docs/30) + LP-2 (docs/31) — confirm-first Thai copilot: wake word `bot`/`บอท` + free text ──
  // The model (or the deterministic key-less rules — same pattern as doc-ai/nl-analytics, so CI is
  // deterministic) only DRAFTS a structured command. Nothing executes without the LC-1 [ยืนยัน] postback,
  // and the confirmed draft replays the ordinary command path (same permission + SoD checks). Read-only
  // intents (stock) answer immediately. Draft/exec replies are campaign-tagged chat_ai/chat_ai_confirm —
  // the AI-origin audit marker. LP-2 widens drafts beyond PR to expense/advance (EXP-07/08 raise path)
  // and leave (ESS path) — every kind replays the SAME text-command handler; the copilot adds zero
  // execution code, and the LLM output is schema-validated (anything malformed → honest refusal).
  private static readonly DRAFT_LABEL: Record<CopilotDraft['kind'], { btn: string; title: string }> = {
    pr: { btn: 'ยืนยันสร้าง PR', title: 'ร่างคำขอซื้อ' },
    expense: { btn: 'ยืนยันเบิกเงิน', title: 'ร่างคำขอเบิกเงินสดย่อย' },
    advance: { btn: 'ยืนยันยืมเงิน', title: 'ร่างคำขอยืมเงินสดย่อย' },
    leave: { btn: 'ยืนยันส่งใบลา', title: 'ร่างใบลา' },
  };

  private async chatCopilot(tenantId: number, lineUserId: string, u: any, text: string): Promise<{ text: string; flex?: any }> {
    const t = text.trim();
    if (!t) return { text: LineWebhookService.CHAT_USAGE };
    // read-only stock intent answers immediately (no confirm needed)
    const stockM = /(?:สต็อก|คงเหลือ|เหลือเท่าไหร่|เหลือกี่)\s*(?:ของ\s*)?([A-Za-z0-9-]+)/.exec(t);
    if (stockM) return { text: await this.chatStock(u, stockM[1]!) };
    const draft = this.copilotRules(t) ?? (await this.copilotLlm(tenantId, t));
    if (!draft) return { text: `ยังไม่เข้าใจคำขอ — ลองพิมพ์คำสั่งโดยตรง:\n${LineWebhookService.CHAT_USAGE}` };
    const L = LineWebhookService.DRAFT_LABEL[draft.kind];
    const nonce = this.genCode();
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

  // Deterministic key-less draft rules (CI-stable; the LLM path refines when configured). Linear,
  // anchored regexes over chat text capped at 2000 chars — no backtracking-prone nesting.
  private copilotRules(t: string): CopilotDraft | null {
    const pr = /(?:ขอซื้อ|อยากได้|สั่งซื้อ|ซื้อ)\s+([A-Za-z0-9-]+)\s+(?:จำนวน\s*)?(\d+(?:\.\d+)?)\s*(?:ชิ้น|อัน|กล่อง|รีม|แพ็ค)?\s*(.*)$/.exec(t);
    if (pr && Number(pr[2]) > 0) return this.mkPrDraft(pr[1]!, pr[2]!, pr[3] ?? '');
    // expense/advance — "เบิก <กองทุน> <จำนวน> [เหตุผล]" or "เบิก <จำนวน> [บาท] จาก <กองทุน> [เหตุผล]"
    const expA = /^(?:ขอเบิก|เบิกเงิน|เบิก)\s+([A-Za-z][A-Za-z0-9-]*)\s+(\d+(?:\.\d+)?)\s*(?:บาท)?\s*(.*)$/.exec(t);
    if (expA) return this.mkMoneyDraft('expense', expA[1]!, expA[2]!, expA[3] ?? '');
    const expB = /^(?:ขอเบิก|เบิกเงิน|เบิก)\s+(\d+(?:\.\d+)?)\s*(?:บาท)?\s*จาก\s*([A-Za-z0-9-]+)\s*(.*)$/.exec(t);
    if (expB) return this.mkMoneyDraft('expense', expB[2]!, expB[1]!, expB[3] ?? '');
    const advA = /^(?:ขอยืมเงิน|ยืมเงิน|ขอยืม)\s+([A-Za-z][A-Za-z0-9-]*)\s+(\d+(?:\.\d+)?)\s*(?:บาท)?\s*(.*)$/.exec(t);
    if (advA) return this.mkMoneyDraft('advance', advA[1]!, advA[2]!, advA[3] ?? '');
    const advB = /^(?:ขอยืมเงิน|ยืมเงิน|ขอยืม)\s+(\d+(?:\.\d+)?)\s*(?:บาท)?\s*จาก\s*([A-Za-z0-9-]+)\s*(.*)$/.exec(t);
    if (advB) return this.mkMoneyDraft('advance', advB[2]!, advB[1]!, advB[3] ?? '');
    // leave — "ลา <YYYY-MM-DD> <วัน>" or "ลา <n> วัน ตั้งแต่ <YYYY-MM-DD>"
    const lvA = /^(?:ขอ)?ลา(?:งาน|ป่วย|กิจ|พักร้อน)?\s+(?:วันที่\s*)?(\d{4}-\d{2}-\d{2})\s+(\d+)\s*(?:วัน)?\s*(.*)$/.exec(t);
    if (lvA) return this.mkLeaveDraft(lvA[1]!, lvA[2]!, lvA[3] ?? '');
    const lvB = /^(?:ขอ)?ลา(?:งาน|ป่วย|กิจ|พักร้อน)?\s+(\d+)\s*วัน\s*(?:ตั้งแต่|จาก|เริ่ม)?\s*(?:วันที่\s*)?(\d{4}-\d{2}-\d{2})\s*(.*)$/.exec(t);
    if (lvB) return this.mkLeaveDraft(lvB[2]!, lvB[1]!, lvB[3] ?? '');
    return null;
  }

  private mkPrDraft(itemId: string, qty: string, reason: string): CopilotDraft | null {
    if (!(Number(qty) > 0)) return null;
    const r = reason.trim();
    return { kind: 'pr', args: [`pr ${itemId.toUpperCase()} ${qty}${r ? ` ${r}` : ''}`], summary: `${itemId.toUpperCase()} × ${qty}${r ? ` (${r})` : ''}` };
  }
  private mkMoneyDraft(kind: 'expense' | 'advance', fund: string, amount: string, reason: string): CopilotDraft | null {
    if (!(Number(amount) > 0)) return null;
    const r = reason.trim();
    return { kind, args: [fund.toUpperCase(), amount, r], summary: `${fund.toUpperCase()} จำนวน ${amount} บาท${r ? ` (${r})` : ''}` };
  }
  private mkLeaveDraft(fromDate: string, days: string, reason: string): CopilotDraft | null {
    const d = Number(days);
    if (!(d > 0 && d <= 60)) return null;
    const r = reason.trim();
    return { kind: 'leave', args: [fromDate, days, r], summary: `ตั้งแต่ ${fromDate} จำนวน ${days} วัน${r ? ` (${r})` : ''}` };
  }

  // LP-2 — LLM refinement behind the same seam as doc-ai/nl-analytics: DPA-gated, chat-scoped model
  // (`chat_copilot`), STRICT schema validation (a malformed/unknown answer drafts nothing), and a
  // per-tenant daily call cap so a chatty OA can't burn the token budget.
  private static readonly LLM_DRAFT_SCHEMA = z.discriminatedUnion('intent', [
    z.object({ intent: z.literal('pr'), item_id: z.string().min(1).max(40), qty: z.number().positive(), reason: z.string().max(200).optional() }),
    z.object({ intent: z.literal('expense'), fund: z.string().min(1).max(40), amount: z.number().positive(), reason: z.string().max(200).optional() }),
    z.object({ intent: z.literal('advance'), fund: z.string().min(1).max(40), amount: z.number().positive(), reason: z.string().max(200).optional() }),
    z.object({ intent: z.literal('leave'), from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), days: z.number().int().positive().max(60), reason: z.string().max(200).optional() }),
    z.object({ intent: z.literal('unknown') }),
  ]);

  private readonly llmDaily = new Map<number, { day: string; n: number }>();
  private llmCapped(tenantId: number): boolean {
    const cap = Number(process.env.LINE_COPILOT_DAILY_CAP ?? 200);
    if (!(cap > 0)) return false;
    const day = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10); // Bangkok business day
    const e = this.llmDaily.get(tenantId);
    if (!e || e.day !== day) { this.llmDaily.set(tenantId, { day, n: 1 }); return false; }
    e.n++;
    if (e.n === cap + 1) void this.audit(tenantId, 'system', `[chat:ai-cap] copilot LLM daily cap ${cap} reached`);
    return e.n > cap;
  }

  private async copilotLlm(tenantId: number, t: string): Promise<CopilotDraft | null> {
    if (aiDpaBlocked() || !process.env.ANTHROPIC_API_KEY) return null;
    if (this.llmCapped(tenantId)) return null;
    try {
      const res: any = await llmClient(process.env.ANTHROPIC_API_KEY).create({
        model: modelFor('chat_copilot'), max_tokens: 300,
        system: 'You draft ERP commands from Thai/English staff chat. Return ONLY one JSON object: '
          + '{"intent":"pr","item_id":string,"qty":number,"reason":string} | '
          + '{"intent":"expense","fund":string,"amount":number,"reason":string} | '
          + '{"intent":"advance","fund":string,"amount":number,"reason":string} | '
          + '{"intent":"leave","from_date":"YYYY-MM-DD","days":number,"reason":string} | '
          + '{"intent":"unknown"}. Draft only — never invent item/fund codes or dates that are not in the message; when unsure return unknown.',
        messages: [{ role: 'user', content: t }],
      });
      const rawText = (res.content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      const parsed = LineWebhookService.LLM_DRAFT_SCHEMA.safeParse(JSON.parse(rawText));
      if (!parsed.success || parsed.data.intent === 'unknown') return null;
      const d = parsed.data;
      if (d.intent === 'pr') return this.mkPrDraft(d.item_id, String(d.qty), d.reason ?? '');
      if (d.intent === 'expense' || d.intent === 'advance') return this.mkMoneyDraft(d.intent, d.fund, String(d.amount), d.reason ?? '');
      return this.mkLeaveDraft(d.from_date, String(d.days), d.reason ?? '');
    } catch { return null; } // malformed JSON / provider error → honest refusal upstream
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
  private async linkStaff(tenantId: number, lineUserId: string, code: string): Promise<{ text: string; flex?: any }> {
    const db = this.db;
    const [u] = await db.select().from(users).where(eq(users.lineLinkCode, code)).limit(1);
    const expired = !u?.lineLinkExpiresAt || new Date(u.lineLinkExpiresAt).getTime() < Date.now();
    if (!u || u.isActive === false || expired || (u.tenantId != null && Number(u.tenantId) !== tenantId)) {
      return { text: 'รหัสเชื่อมไม่ถูกต้องหรือหมดอายุ — สร้างรหัสใหม่ได้ที่หน้า "คำขอซื้อ (PR)" ในระบบ ERP' };
    }
    try {
      await db.update(users).set({ lineUserId, lineLinkCode: null, lineLinkExpiresAt: null }).where(eq(users.id, u.id));
    } catch (e: any) {
      if (isUniqueViolation(e)) return { text: 'บัญชี LINE นี้ถูกเชื่อมกับผู้ใช้อื่นแล้ว — ยกเลิกการเชื่อมเดิมก่อนจากหน้า "คำขอซื้อ (PR)"' };
      throw e;
    }
    await this.audit(tenantId, lineUserId, `[chat:link] ${u.username}`);
    // altText MUST keep the phrase "เชื่อมบัญชีสำเร็จ" — notification previews + the line-crm assertion read it.
    return {
      text: `เชื่อมบัญชีสำเร็จ ✔ (${u.username}) — พิมพ์ "help" เพื่อดูคำสั่งทั้งหมด`,
      flex: LineWebhookService.helpCard(`🎉 เชื่อมบัญชีสำเร็จ`, `ยินดีต้อนรับคุณ ${u.username}`),
    };
  }

  // ── The command menu as a flex bubble (used by the link-welcome + the `help`/`เมนู` command). One data
  // list drives both the flex card and CHAT_USAGE stays the plain-text altText/fallback. Grouped by cycle
  // with an accent-coloured header per group + separators — readable on a phone instead of a text wall.
  private static readonly CMD_GROUPS: Array<{ icon: string; title: string; color: string; items: Array<[string, string]> }> = [
    { icon: '🛒', title: 'คำขอซื้อ (PR)', color: '#2563eb', items: [
      ['pr <รหัสสินค้า> <จำนวน>', 'สร้างคำขอซื้อ — เหตุผลใส่หรือไม่ก็ได้ (หลายรายการคั่นด้วย ,)'],
      ['status <เลขที่ PR>', 'เช็คสถานะ'],
      ['my prs', 'คำขอล่าสุดของฉัน'],
      ['cancel <เลขที่ PR>', 'ถอนคำขอ'],
    ] },
    { icon: '🔎', title: 'ค้นหา & สต็อก', color: '#0891b2', items: [
      ['find <คำค้น>', 'ค้นหารหัสสินค้า'],
      ['stock <รหัสสินค้า>', 'ดูยอดคงเหลือ'],
      ['low', 'ดูสินค้าใกล้หมด (ต่ำกว่าจุดสั่งซื้อ)'],
      ['reorder', 'เปิด PR เติมของใกล้หมดทั้งหมดในครั้งเดียว'],
    ] },
    { icon: '💸', title: 'การเงิน & เอกสาร', color: '#059669', items: [
      ['expense/advance <กองทุน> <จำนวนเงิน> [เหตุผล]', 'เบิกเงินสดย่อย'],
      ['attach <เลขที่ PO>', 'แนบรูปใบแจ้งหนี้/ใบเสร็จ'],
      ['receive <เลขที่ PO>', 'รับของครบตาม PO'],
      ['receive <PO> <รหัสสินค้า> <จำนวน>', 'รับบางส่วน (เฉพาะรายการ/จำนวนที่ระบุ)'],
      ['claim <PO/GR> <จำนวน> [เหตุผล]', 'แจ้งของขาด/เสีย (เปิดเคลมกับผู้ขาย)'],
    ] },
    { icon: '📅', title: 'ลางาน', color: '#7c3aed', items: [
      ['leave <YYYY-MM-DD> <จำนวนวัน> [เหตุผล]', 'ส่งใบลา'],
    ] },
    { icon: '📊', title: 'รายงาน & AI', color: '#d97706', items: [
      ['subscribe digest [kpi,…]', 'รับสรุปประจำวัน (digest kpis = ดู KPI ที่เลือกได้)'],
      ['subscribe lowstock', 'รับแจ้งเตือนสินค้าใกล้หมดทุกเช้า + ปุ่มสั่งเติม'],
      ['ask <คำถาม>', 'ถามยอดขาย เช่น ask ยอดขายตามสาขา'],
      ['spend [YYYY-MM]', 'สรุปยอดซื้อเดือนนี้ — ผู้ขาย/สินค้าสูงสุด'],
      ['บอท <ข้อความ>', 'ให้ AI ช่วยร่าง (ยืนยันก่อนสร้างเสมอ)'],
    ] },
    { icon: '✅', title: 'อนุมัติ (เฉพาะทีมจัดซื้อ)', color: '#b45309', items: [
      ['approve/reject <เลขที่ PR>', 'อนุมัติ/ปฏิเสธ'],
    ] },
  ];

  private static helpCard(headerTitle: string, subtitle: string): any {
    const groups = LineWebhookService.CMD_GROUPS.flatMap((g, gi) => [
      ...(gi > 0 ? [{ type: 'separator', margin: 'md' }] : []),
      { type: 'text', text: `${g.icon}  ${g.title}`, weight: 'bold', size: 'sm', color: g.color, margin: gi > 0 ? 'md' : 'none' },
      ...g.items.map(([cmd, desc]) => ({
        type: 'box', layout: 'vertical', spacing: 'none', margin: 'sm', contents: [
          { type: 'text', text: cmd, size: 'sm', weight: 'bold', color: '#1f2937', wrap: true },
          { type: 'text', text: desc, size: 'xs', color: '#9ca3af', wrap: true },
        ],
      })),
    ]);
    return {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', paddingAll: 'lg', backgroundColor: '#f0f7ff', contents: [
          { type: 'text', text: headerTitle, weight: 'bold', size: 'lg', color: '#1e3a8a', wrap: true },
          { type: 'text', text: subtitle, size: 'xs', color: '#6b7280', margin: 'xs', wrap: true },
        ],
      },
      body: { type: 'box', layout: 'vertical', spacing: 'none', paddingAll: 'lg', contents: groups },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: 'md', contents: [
          { type: 'text', text: 'ตัวอย่าง:  pr A4-PAPER 10  (ไม่ต้องใส่เหตุผล) · หลายรายการ  pr A4-PAPER 10, TONER-85A 2', size: 'xs', color: '#9ca3af', wrap: true },
          { type: 'text', text: 'พิมพ์ "help" เพื่อเปิดเมนูนี้อีกครั้ง', size: 'xs', color: '#c0c4cc', margin: 'sm' },
        ],
      },
    };
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
      // Quantity = the LAST pure-number token; everything before it is the item name (so multi-word,
      // un-coded names work — "Iberico ham 2"), everything after is an optional reason. Storefronts
      // order by product name, not a single-token code, so we don't assume the id is one word.
      let qi = -1;
      for (let i = parts.length - 1; i >= 1; i--) { if (/^\d+(?:\.\d+)?$/.test(parts[i]!)) { qi = i; break; } }
      const qty = qi >= 0 ? Number(parts[qi]!) : NaN;
      const name = qi >= 1 ? parts.slice(0, qi).join(' ').trim() : '';
      if (qi < 1 || !name || !Number.isFinite(qty) || qty <= 0) {
        return `อ่านรายการนี้ไม่ได้: "${line}" — พิมพ์ <ชื่อสินค้า> <จำนวน> เช่น  pr Iberico ham 2\n${LineWebhookService.CHAT_USAGE}`;
      }
      items.push({ item_id: name, request_qty: qty, reason: parts.slice(qi + 1).join(' ') || undefined });
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

  private async audit(tenantId: number | null, recipient: string, body: string) {
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

  // LC-3 governance — admin link registry + force-unlink (offboarding). Perm `users` (AccessAdmin).
  @Get('links') @Permissions('users')
  listLinks() { return this.svc.listLinks(); }

  @Delete('links/:username') @Permissions('users')
  adminUnlink(@Param('username') username: string, @CurrentUser() u: JwtUser) { return this.svc.adminUnlink(username, u); }
}
