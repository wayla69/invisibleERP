import { Inject, Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { eq, and, desc, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { channelCustomerRefs, channelWebhookEvents, dineInOrders, posMembers } from '../../database/schema';
import { RealtimeScope } from '../restaurant/realtime.scope';
import type { JwtUser } from '../../common/decorators';
import { normalizeAggregatorPayload } from './mappers';
import { mintChannelLinkToken, verifyChannelLinkToken } from './link-token.util';

// A marketplace customer identifier is either the platform's opaque customer/eater id or a phone. Phones
// arrive formatted every possible way (spaces, dashes, +66 vs 0…) — normalize to digits so the same buyer
// always hashes identically; opaque ids just get case/space-folded.
export function normalizeCustomerRef(raw: string): string {
  const s = String(raw).trim();
  const digits = s.replace(/[\s\-().+]/g, '');
  if (/^\d{7,}$/.test(digits)) return digits.replace(/^66/, '0'); // Thai-first: +66x… and 0x… are the same phone
  return s.toLowerCase();
}

// PDPA data-minimization (MKT-13): only this hash is ever persisted — the raw marketplace identifier
// stays in the (already-stored, payload-audit) webhook event and is never copied into the identity map.
export function hashCustomerRef(platform: string, raw: string): string {
  return createHash('sha256').update(`${platform}:${normalizeCustomerRef(raw)}`).digest('hex');
}

// Both ingest shapes carry the customer differently: the aggregator webhook normalizes to extCustomerRef
// (mappers.ts), while the restaurant ingest body uses `customer.{id,external_id,phone}`. One extractor
// serves both so the QR-mint path can re-derive the ref from the stored event payload.
export function extractRawCustomerRef(platform: string, payload: any): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const direct = payload.customer?.id ?? payload.customer?.external_id ?? payload.customer?.customer_id ?? payload.customer?.phone;
  if (direct != null && String(direct).trim()) return String(direct);
  const norm = normalizeAggregatorPayload(platform, payload);
  return norm.extCustomerRef;
}

// G1 (docs/45) — marketplace-to-member identity capture (MKT-13). Owns channel_customer_refs: the hashed
// external-ref → member map that turns anonymous Grab/LINE MAN/foodpanda/Robinhood buyers into linked
// loyalty members. Capture is passive (every ingest upserts hash + counters, no PII); linking is active
// and consent-gated (member QR self-service, or staff link) — the CONTROLLER records the marketing consent
// row in the same request tx, this service never links without a caller-supplied principal.
@Injectable()
export class ChannelCustomerRefsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly scope: RealtimeScope) {}

  // Called from both ingest paths (already RLS-scoped to the tenant). Upserts the ref row and returns the
  // linked member (if any) so the caller can attach dine_in_orders.member_id. Best-effort by contract:
  // callers catch — a ref-capture failure must never block a food order.
  async captureOnIngest(tenantId: number, platform: string, rawRef: string, orderNo: string): Promise<{ refId: number; memberId: number | null }> {
    const db = this.db;
    const refHash = hashCustomerRef(platform, rawRef);
    const now = new Date();
    const [row] = await db.insert(channelCustomerRefs)
      .values({ tenantId, platform, refHash, lastOrderNo: orderNo })
      .onConflictDoUpdate({
        target: [channelCustomerRefs.tenantId, channelCustomerRefs.platform, channelCustomerRefs.refHash],
        set: { orderCount: sql`${channelCustomerRefs.orderCount} + 1`, lastSeenAt: now, lastOrderNo: orderNo, updatedAt: now },
      })
      .returning({ id: channelCustomerRefs.id, memberId: channelCustomerRefs.memberId });
    return { refId: Number(row!.id), memberId: row!.memberId != null ? Number(row!.memberId) : null };
  }

  // Staff (packing station / channels screen): mint the QR deep link for one aggregator order. The ref is
  // re-derived from the stored webhook-event payload so nothing raw needs to persist on the ref row.
  async linkQrForOrder(orderNo: string, user: JwtUser) {
    const db = this.db;
    const [ord] = await db.select().from(dineInOrders).where(eq(dineInOrders.orderNo, orderNo)).limit(1);
    if (!ord) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found', messageTh: 'ไม่พบออเดอร์' });
    if (!ord.extSource) throw new BadRequestException({ code: 'NOT_CHANNEL_ORDER', message: 'Not an aggregator order', messageTh: 'ไม่ใช่ออเดอร์จากแพลตฟอร์ม' });
    const platform = String(ord.extSource);
    const [evt] = await db.select().from(channelWebhookEvents).where(and(eq(channelWebhookEvents.source, platform), eq(channelWebhookEvents.orderNo, orderNo))).orderBy(desc(channelWebhookEvents.id)).limit(1);
    const rawRef = extractRawCustomerRef(platform, evt?.payload);
    if (!rawRef) throw new NotFoundException({ code: 'NO_CUSTOMER_REF', message: 'The platform payload carried no stable customer identifier', messageTh: 'ข้อมูลจากแพลตฟอร์มไม่มีรหัสอ้างอิงลูกค้า' });
    const tenantId = Number(user.tenantId ?? ord.tenantId);
    const refHash = hashCustomerRef(platform, rawRef);
    // ensure the ref row exists even if this order predates ref capture (idempotent, keeps counters honest)
    await db.insert(channelCustomerRefs).values({ tenantId, platform, refHash, lastOrderNo: orderNo }).onConflictDoNothing({ target: [channelCustomerRefs.tenantId, channelCustomerRefs.platform, channelCustomerRefs.refHash] });
    const token = mintChannelLinkToken({ tenantId, platform, refHash });
    const base = (process.env.WEB_BASE_URL ?? '').replace(/\/+$/, '');
    // /m is the member self-service app (its own phone-OTP/LINE auth + httpOnly cookie) — NOT /portal,
    // which is the separate B2B customer-account portal and shares no auth with a loyalty member.
    return { order_no: orderNo, platform, token, url: base ? `${base}/m?clink=${token}` : `/m?clink=${token}` };
  }

  // PUBLIC (rate-limited at the controller): what the QR landing page shows before login — platform +
  // repeat-buyer count + whether it is already linked. No PII, no member identity leaks.
  async resolveToken(token: string) {
    const claim = verifyChannelLinkToken(token);
    if (!claim) throw new NotFoundException({ code: 'BAD_LINK_TOKEN', message: 'Invalid or expired link', messageTh: 'ลิงก์ไม่ถูกต้องหรือหมดอายุ' });
    return this.scope.run(claim.tenantId, async () => {
      const db = this.db;
      const [row] = await db.select().from(channelCustomerRefs).where(and(eq(channelCustomerRefs.platform, claim.platform), eq(channelCustomerRefs.refHash, claim.refHash))).limit(1);
      if (!row) throw new NotFoundException({ code: 'BAD_LINK_TOKEN', message: 'Invalid or expired link', messageTh: 'ลิงก์ไม่ถูกต้องหรือหมดอายุ' });
      return { platform: claim.platform, order_count: Number(row.orderCount), linked: row.memberId != null };
    });
  }

  // Member self-service (MemberGuard upstream): claim the ref for the AUTHENTICATED member. The token names
  // which external ref; the member JWT names who — a stolen QR alone links nothing. One ref = one member
  // (first link wins; re-linking the same member is idempotent). The controller records the consent row in
  // the same request tx (MKT-13: no link without an explicit consent decision).
  async linkMember(u: JwtUser, token: string) {
    const claim = verifyChannelLinkToken(token);
    if (!claim) throw new NotFoundException({ code: 'BAD_LINK_TOKEN', message: 'Invalid or expired link', messageTh: 'ลิงก์ไม่ถูกต้องหรือหมดอายุ' });
    if (!u.memberId) throw new ForbiddenException({ code: 'MEMBER_ONLY', message: 'Member token required', messageTh: 'ต้องเข้าสู่ระบบสมาชิก' });
    if (Number(u.tenantId) !== claim.tenantId) throw new ForbiddenException({ code: 'TENANT_MISMATCH', message: 'This link belongs to another shop', messageTh: 'ลิงก์นี้เป็นของร้านอื่น' });
    return this.applyLink(claim.platform, claim.refHash, u.memberId, 'qr', 'member-self');
  }

  // Staff link (crm_member/loyalty duty; e.g. the customer calls in and identifies their Grab account).
  // Staff attests the customer's consent decision; the controller records it with source='pos'.
  async staffLink(refId: number, memberId: number, user: JwtUser) {
    const db = this.db;
    const [ref] = await db.select().from(channelCustomerRefs).where(eq(channelCustomerRefs.id, refId)).limit(1);
    if (!ref) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Customer ref not found', messageTh: 'ไม่พบรหัสอ้างอิงลูกค้า' });
    const [m] = await db.select({ id: posMembers.id }).from(posMembers).where(eq(posMembers.id, memberId)).limit(1);
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    return this.applyLink(String(ref.platform), String(ref.refHash), memberId, 'staff', user.username ?? 'staff');
  }

  // Shared link write: single-winner on the ref row, then attach the most recent order so attribution is
  // visible immediately (every FUTURE ingest auto-attaches via captureOnIngest).
  private async applyLink(platform: string, refHash: string, memberId: number, source: 'qr' | 'staff', by: string) {
    const db = this.db;
    const [ref] = await db.select().from(channelCustomerRefs).where(and(eq(channelCustomerRefs.platform, platform), eq(channelCustomerRefs.refHash, refHash))).limit(1);
    if (!ref) throw new NotFoundException({ code: 'BAD_LINK_TOKEN', message: 'Invalid or expired link', messageTh: 'ลิงก์ไม่ถูกต้องหรือหมดอายุ' });
    if (ref.memberId != null && Number(ref.memberId) !== memberId) {
      throw new ConflictException({ code: 'REF_ALREADY_LINKED', message: 'This platform account is already linked to another member', messageTh: 'บัญชีแพลตฟอร์มนี้ถูกเชื่อมกับสมาชิกอื่นแล้ว' });
    }
    const now = new Date();
    if (ref.memberId == null) {
      await db.update(channelCustomerRefs).set({ memberId, linkedAt: now, linkSource: source, linkedBy: by, updatedAt: now }).where(and(eq(channelCustomerRefs.id, Number(ref.id)), isNull(channelCustomerRefs.memberId)));
    }
    if (ref.lastOrderNo) {
      await db.update(dineInOrders).set({ memberId }).where(and(eq(dineInOrders.orderNo, ref.lastOrderNo), eq(dineInOrders.extSource, platform), isNull(dineInOrders.memberId)));
    }
    return { linked: true, platform, order_count: Number(ref.orderCount), member_id: memberId, link_source: source };
  }

  // Staff visibility (channels/loyalty back-office): repeat-buyer refs, hashed only, with link state.
  async listRefs(user: JwtUser, opts: { linked?: boolean; limit?: number } = {}) {
    const db = this.db;
    const conds = [eq(channelCustomerRefs.tenantId, Number(user.tenantId))];
    if (opts.linked === true) conds.push(sql`${channelCustomerRefs.memberId} IS NOT NULL`);
    if (opts.linked === false) conds.push(isNull(channelCustomerRefs.memberId));
    const rows = await db.select({
      id: channelCustomerRefs.id, platform: channelCustomerRefs.platform, refHash: channelCustomerRefs.refHash,
      memberId: channelCustomerRefs.memberId, orderCount: channelCustomerRefs.orderCount,
      firstSeenAt: channelCustomerRefs.firstSeenAt, lastSeenAt: channelCustomerRefs.lastSeenAt,
      lastOrderNo: channelCustomerRefs.lastOrderNo, linkSource: channelCustomerRefs.linkSource,
      memberCode: posMembers.memberCode, memberName: posMembers.name,
    }).from(channelCustomerRefs)
      .leftJoin(posMembers, eq(posMembers.id, channelCustomerRefs.memberId))
      .where(and(...conds))
      .orderBy(desc(channelCustomerRefs.lastSeenAt))
      .limit(Math.min(opts.limit ?? 100, 500));
    return {
      refs: rows.map((r) => ({
        id: r.id, platform: r.platform, ref_hash: `${String(r.refHash).slice(0, 12)}…`,
        member_id: r.memberId, member_code: r.memberCode, member_name: r.memberName,
        order_count: Number(r.orderCount), first_seen_at: r.firstSeenAt, last_seen_at: r.lastSeenAt,
        last_order_no: r.lastOrderNo, link_source: r.linkSource, linked: r.memberId != null,
      })),
      count: rows.length,
    };
  }
}
