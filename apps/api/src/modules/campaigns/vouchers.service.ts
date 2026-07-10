import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException, ForbiddenException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { eq, and, desc, isNull, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { voucherCampaigns, voucherCodes, memberCoupons } from '../../database/schema';
import { n, ymd } from '../../database/queries';
import { DocNumberService } from '../../common/doc-number.service';
import { isUniqueViolation } from '../../common/db-error';
import type { JwtUser } from '../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
// unambiguous code alphabet (no 0/O/1/I) — codes are read out / typed at the till
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = (len = 8) => Array.from(randomBytes(len)).map((b) => ALPHABET[b % ALPHABET.length]).join('');

// What the checkout redemption path needs to apply + atomically consume one code. `source` distinguishes
// a campaign voucher code from a loyalty member-coupon (both redeem through the SAME surface — POS-3).
export interface VoucherCheckoutPreview {
  source: 'voucher' | 'coupon';
  code: string;
  kind: string;               // percent | amount
  value: number;
  discount: number;           // order-level discount computed on the net subtotal
  codeId: number;
  campaignId?: number;
  campaignCode?: string;
  perCodeMaxUses?: number;
}

// POS-3 (docs/41) — standalone voucher campaigns + code redemption at checkout. NOT a second pricing
// engine: a voucher resolves to an ORDER-LEVEL discount that buildSale folds through the existing
// discount path (same slot as a promo code). Campaign activation is maker-checker (REV-20 — mirrors the
// pricing-rule G6 gate: staged 'PendingApproval', a DIFFERENT user activates, self-approval → 403
// SOD_VIOLATION); redemption is atomic (guarded UPDATE ... WHERE state='issued' — no double redemption
// under concurrency) and the loyalty member-coupon wallet redeems through the same validate/redeem surface.
@Injectable()
export class VouchersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

  private tid(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบบริบทร้านค้า' });
    return user.tenantId;
  }

  // Tenant scope for checkout lookups: a sale in tenant T sees only T's codes (legacy null-tenant = global).
  private scope(col: typeof voucherCodes.tenantId | typeof voucherCampaigns.tenantId | typeof memberCoupons.tenantId, tenantId: number | null): SQL {
    return tenantId != null ? eq(col, tenantId) : isNull(col);
  }

  // ── Campaign lifecycle (maker-checker, REV-20) ───────────────────────────────
  async listCampaigns(user: JwtUser, q: { status?: string } = {}) {
    const db = this.db; const tenantId = this.tid(user);
    const conds: SQL[] = [eq(voucherCampaigns.tenantId, tenantId)];
    if (q.status) conds.push(eq(voucherCampaigns.status, q.status));
    const rows = await db.select().from(voucherCampaigns).where(and(...conds)).orderBy(desc(voucherCampaigns.id));
    return { campaigns: rows.map(shapeCampaign), count: rows.length };
  }

  async createCampaign(user: JwtUser, dto: { name: string; kind?: string; value: number; min_spend?: number; channel?: string; valid_from?: string; valid_to?: string; per_code_max_uses?: number; max_redemptions?: number }) {
    const db = this.db; const tenantId = this.tid(user);
    if ((dto.kind ?? 'percent') === 'percent' && (dto.value <= 0 || dto.value > 100)) throw new BadRequestException({ code: 'BAD_VALUE', message: 'Percent voucher value must be 1–100', messageTh: 'ส่วนลดร้อยละต้องอยู่ระหว่าง 1–100' });
    if (dto.value <= 0) throw new BadRequestException({ code: 'BAD_VALUE', message: 'Voucher value must be positive', messageTh: 'มูลค่าส่วนลดต้องมากกว่าศูนย์' });
    const campaignCode = await this.docNo.nextDaily('VCH');
    const [r] = await db.insert(voucherCampaigns).values({
      tenantId, campaignCode, name: dto.name, kind: dto.kind ?? 'percent', value: String(dto.value),
      minSpend: dto.min_spend != null ? String(dto.min_spend) : null, channel: dto.channel ?? 'any',
      validFrom: dto.valid_from ?? null, validTo: dto.valid_to ?? null,
      perCodeMaxUses: Math.max(1, dto.per_code_max_uses ?? 1), maxRedemptions: dto.max_redemptions ?? null,
      status: 'PendingApproval', createdBy: user.username,
    }).returning();
    return { ...shapeCampaign(r), pending: true };
  }

  // A DIFFERENT user than the creator activates the campaign (self-approval → 403 SOD_VIOLATION) — only
  // then do its codes redeem at checkout (the redemption path reads status='Active' only). Like the
  // pricing-rule approve (G6), the lookup is by id with RLS scoping the caller — the checker is commonly
  // an HQ/Admin user outside the shop's own tenant.
  async approveCampaign(user: JwtUser, id: number) {
    const db = this.db;
    const [c] = await db.select().from(voucherCampaigns).where(eq(voucherCampaigns.id, id)).limit(1);
    if (!c) throw new NotFoundException({ code: 'CAMPAIGN_NOT_FOUND', message: 'Voucher campaign not found', messageTh: 'ไม่พบแคมเปญคูปอง' });
    if (c.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Campaign is ${c.status}, not pending approval`, messageTh: 'แคมเปญนี้ไม่ได้รออนุมัติ' });
    if (c.createdBy && c.createdBy === user.username) throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot activate a voucher campaign you created', messageTh: 'ผู้สร้างแคมเปญอนุมัติเองไม่ได้ (แบ่งแยกหน้าที่)' });
    const [r] = await db.update(voucherCampaigns).set({ status: 'Active', approvedBy: user.username, approvedAt: new Date(), updatedAt: new Date() }).where(eq(voucherCampaigns.id, id)).returning();
    return shapeCampaign(r);
  }

  async rejectCampaign(user: JwtUser, id: number, reason?: string) {
    const db = this.db;
    const [r] = await db.update(voucherCampaigns).set({ status: 'Rejected', approvedBy: user.username, approvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(voucherCampaigns.id, id), eq(voucherCampaigns.status, 'PendingApproval'))).returning();
    if (!r) throw new BadRequestException({ code: 'NOT_PENDING', message: 'Only a pending campaign can be rejected', messageTh: 'ปฏิเสธได้เฉพาะแคมเปญที่รออนุมัติ' });
    return { ...shapeCampaign(r), reason: reason ?? null };
  }

  // End an Active campaign — its codes stop redeeming immediately (state on the codes is untouched).
  async endCampaign(user: JwtUser, id: number) {
    const db = this.db; const tenantId = this.tid(user);
    const [r] = await db.update(voucherCampaigns).set({ status: 'Ended', updatedAt: new Date() })
      .where(and(eq(voucherCampaigns.id, id), eq(voucherCampaigns.tenantId, tenantId), eq(voucherCampaigns.status, 'Active'))).returning();
    if (!r) throw new BadRequestException({ code: 'NOT_ACTIVE', message: 'Only an Active campaign can be ended', messageTh: 'ปิดได้เฉพาะแคมเปญที่ใช้งานอยู่' });
    return shapeCampaign(r);
  }

  // ── Codes: bulk generate / list / export / void ─────────────────────────────
  // Crypto-random codes, unique per tenant (retry on the rare collision via the db-error helpers).
  // Generation is allowed while PendingApproval too — codes are inert until the campaign is Active.
  async generateCodes(user: JwtUser, id: number, dto: { count: number; prefix?: string }) {
    const db = this.db; const tenantId = this.tid(user);
    const count = Math.floor(dto.count);
    if (!(count >= 1 && count <= 2000)) throw new BadRequestException({ code: 'BAD_COUNT', message: 'count must be 1–2000', messageTh: 'จำนวนโค้ดต้องอยู่ระหว่าง 1–2000' });
    const [c] = await db.select().from(voucherCampaigns).where(and(eq(voucherCampaigns.id, id), eq(voucherCampaigns.tenantId, tenantId))).limit(1);
    if (!c) throw new NotFoundException({ code: 'CAMPAIGN_NOT_FOUND', message: 'Voucher campaign not found', messageTh: 'ไม่พบแคมเปญคูปอง' });
    if (c.status === 'Rejected' || c.status === 'Ended') throw new BadRequestException({ code: 'CAMPAIGN_CLOSED', message: `Cannot generate codes on a ${c.status} campaign`, messageTh: 'แคมเปญถูกปิด/ปฏิเสธแล้ว' });
    const prefix = (dto.prefix ?? 'VC').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'VC';
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      // retry a unique-violation collision (crypto-random 8 chars over a 32-alphabet ⇒ vanishingly rare)
      for (let attempt = 0; ; attempt++) {
        const code = `${prefix}-${randomCode(8)}`;
        try {
          // codes carry the CAMPAIGN's tenant (not the caller's — an HQ user may administer a shop campaign)
          await db.insert(voucherCodes).values({ tenantId: c.tenantId, campaignId: id, code, createdBy: user.username });
          codes.push(code); break;
        } catch (e) {
          if (!isUniqueViolation(e) || attempt >= 4) throw e;
        }
      }
    }
    await db.update(voucherCampaigns).set({ codesIssued: sql`${voucherCampaigns.codesIssued} + ${codes.length}`, updatedAt: new Date() }).where(eq(voucherCampaigns.id, id));
    return { campaign_id: id, generated: codes.length, codes };
  }

  async listCodes(user: JwtUser, id: number, q: { state?: string; limit?: number } = {}) {
    const db = this.db; const tenantId = this.tid(user);
    const conds: SQL[] = [eq(voucherCodes.tenantId, tenantId), eq(voucherCodes.campaignId, id)];
    if (q.state) conds.push(eq(voucherCodes.state, q.state));
    const rows = await db.select().from(voucherCodes).where(and(...conds)).orderBy(desc(voucherCodes.id)).limit(Math.min(q.limit ?? 500, 5000));
    return { campaign_id: id, codes: rows.map(shapeCode), count: rows.length };
  }

  async exportCodesCsv(user: JwtUser, id: number): Promise<string> {
    const db = this.db; const tenantId = this.tid(user);
    const rows = await db.select().from(voucherCodes).where(and(eq(voucherCodes.tenantId, tenantId), eq(voucherCodes.campaignId, id))).orderBy(voucherCodes.id);
    const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const header = 'code,state,use_count,redeemed_at,redeemed_by,sale_ref,voided_at,void_reason';
    return [header, ...rows.map((r: any) => [r.code, r.state, r.useCount, r.redeemedAt?.toISOString?.() ?? r.redeemedAt ?? '', r.redeemedBy, r.saleRef, r.voidedAt?.toISOString?.() ?? r.voidedAt ?? '', r.voidReason].map(esc).join(','))].join('\n') + '\n';
  }

  // Void an issued code (audited: voided_by/at/reason on the row). A redeemed code cannot be voided.
  async voidCode(user: JwtUser, code: string, reason?: string) {
    const db = this.db; const tenantId = this.tid(user);
    const [r] = await db.update(voucherCodes).set({ state: 'void', voidedAt: new Date(), voidedBy: user.username, voidReason: reason ?? null })
      .where(and(eq(voucherCodes.code, code), eq(voucherCodes.tenantId, tenantId), eq(voucherCodes.state, 'issued'))).returning();
    if (!r) {
      const [exists] = await db.select({ state: voucherCodes.state }).from(voucherCodes).where(and(eq(voucherCodes.code, code), eq(voucherCodes.tenantId, tenantId))).limit(1);
      if (!exists) throw new NotFoundException({ code: 'VOUCHER_NOT_FOUND', message: 'Voucher code not found', messageTh: 'ไม่พบโค้ดคูปอง' });
      throw new ConflictException({ code: 'CANNOT_VOID', message: `Cannot void a ${exists.state} code`, messageTh: 'โค้ดนี้ถูกใช้/ยกเลิกไปแล้ว' });
    }
    return { code, state: 'void', voided_by: user.username, reason: reason ?? null };
  }

  // Redemption report for a campaign.
  async redemptions(user: JwtUser, id: number) {
    const db = this.db; const tenantId = this.tid(user);
    const [c] = await db.select().from(voucherCampaigns).where(and(eq(voucherCampaigns.id, id), eq(voucherCampaigns.tenantId, tenantId))).limit(1);
    if (!c) throw new NotFoundException({ code: 'CAMPAIGN_NOT_FOUND', message: 'Voucher campaign not found', messageTh: 'ไม่พบแคมเปญคูปอง' });
    const rows = await db.select().from(voucherCodes).where(and(eq(voucherCodes.tenantId, tenantId), eq(voucherCodes.campaignId, id), eq(voucherCodes.state, 'redeemed'))).orderBy(desc(voucherCodes.redeemedAt)).limit(1000);
    return {
      campaign: shapeCampaign(c),
      redemptions: rows.map((r: any) => ({ code: r.code, use_count: r.useCount, redeemed_at: r.redeemedAt, redeemed_by: r.redeemedBy, sale_ref: r.saleRef })),
      count: rows.length,
    };
  }

  // ── Checkout surface (validate + atomic redeem) ─────────────────────────────
  // Non-throwing validate for the till: code → { valid, discount preview, reason if not }.
  async validate(user: JwtUser, dto: { code: string; subtotal?: number; channel?: string; member_id?: number }) {
    try {
      const p = await this.previewForCheckout(this.db, user.tenantId ?? null, dto.code, dto.subtotal ?? 0, { channel: dto.channel, memberId: dto.member_id });
      return { valid: true, source: p.source, code: p.code, kind: p.kind, value: p.value, discount: p.discount, campaign_code: p.campaignCode ?? null };
    } catch (e: any) {
      const body = typeof e?.getResponse === 'function' ? e.getResponse() : {};
      return { valid: false, reason: body?.code ?? 'INVALID', message: body?.message ?? 'Invalid voucher', message_th: body?.messageTh ?? 'คูปองใช้ไม่ได้' };
    }
  }

  // Resolve a code (voucher_codes first, then the loyalty member-coupon wallet) and compute the order-level
  // discount on the NET subtotal. Throws coded errors on every hard failure. Does NOT consume anything.
  async previewForCheckout(dbc: DrizzleDb, tenantId: number | null, code: string, subtotalNet: number, ctx: { channel?: string; memberId?: number } = {}): Promise<VoucherCheckoutPreview> {
    const bad = (c: string, message: string, messageTh: string): never => { throw new BadRequestException({ code: c, message, messageTh }); };
    const conflict = (c: string, message: string, messageTh: string): never => { throw new ConflictException({ code: c, message, messageTh }); };
    const [vc] = await dbc.select().from(voucherCodes).where(and(eq(voucherCodes.code, code), this.scope(voucherCodes.tenantId, tenantId))).limit(1);
    if (vc) {
      const [camp] = await dbc.select().from(voucherCampaigns).where(eq(voucherCampaigns.id, Number(vc.campaignId))).limit(1);
      if (!camp) bad('VOUCHER_NOT_ACTIVE', 'Voucher campaign missing', 'ไม่พบแคมเปญของคูปองนี้');
      if (vc.state === 'void') conflict('VOUCHER_VOID', 'Voucher code voided', 'โค้ดถูกยกเลิกแล้ว');
      if (vc.state === 'redeemed' || Number(vc.useCount) >= Number(camp!.perCodeMaxUses)) conflict('VOUCHER_ALREADY_REDEEMED', 'Voucher code already redeemed', 'โค้ดถูกใช้ไปแล้ว');
      if (camp!.status !== 'Active') bad('VOUCHER_NOT_ACTIVE', `Voucher campaign is ${camp!.status}`, 'แคมเปญคูปองยังไม่เปิดใช้งาน');
      const today = ymd();
      if (camp!.validFrom && String(camp!.validFrom).slice(0, 10) > today) bad('VOUCHER_NOT_STARTED', 'Voucher not started', 'คูปองยังไม่เริ่มใช้');
      if (camp!.validTo && String(camp!.validTo).slice(0, 10) < today) bad('VOUCHER_EXPIRED', 'Voucher expired', 'คูปองหมดอายุ');
      if (camp!.channel && camp!.channel !== 'any' && ctx.channel && camp!.channel !== ctx.channel) bad('VOUCHER_CHANNEL_MISMATCH', `Voucher is for ${camp!.channel} only`, 'คูปองใช้ได้เฉพาะช่องทางที่กำหนด');
      if (camp!.maxRedemptions != null && Number(camp!.redeemedCount) >= Number(camp!.maxRedemptions)) conflict('VOUCHER_EXHAUSTED', 'Voucher campaign redemption cap reached', 'คูปองแคมเปญนี้ถูกใช้ครบจำนวนแล้ว');
      if (camp!.minSpend != null && subtotalNet < n(camp!.minSpend)) bad('VOUCHER_MIN_SPEND', `Min spend ${n(camp!.minSpend)} not met`, `ยอดซื้อขั้นต่ำ ${n(camp!.minSpend)} บาท`);
      const discount = camp!.kind === 'percent' ? round2(subtotalNet * n(camp!.value) / 100) : round2(Math.min(n(camp!.value), subtotalNet));
      return { source: 'voucher', code: vc.code, kind: String(camp!.kind), value: n(camp!.value), discount, codeId: Number(vc.id), campaignId: Number(camp!.id), campaignCode: camp!.campaignCode, perCodeMaxUses: Number(camp!.perCodeMaxUses) };
    }
    // POS-3(4): the loyalty member-coupon wallet redeems through this SAME surface.
    const [cp] = await dbc.select().from(memberCoupons).where(and(eq(memberCoupons.code, code), this.scope(memberCoupons.tenantId, tenantId))).limit(1);
    if (!cp) throw new NotFoundException({ code: 'VOUCHER_NOT_FOUND', message: `Voucher/coupon ${code} not found`, messageTh: 'ไม่พบคูปอง' });
    if (cp.status === 'used') conflict('ALREADY_USED', 'Coupon already used', 'คูปองถูกใช้แล้ว');
    if (cp.status === 'expired' || (cp.expiresAt && new Date(cp.expiresAt) < new Date())) conflict('COUPON_EXPIRED', 'Coupon expired', 'คูปองหมดอายุ');
    if (cp.kind !== 'percent' && cp.kind !== 'amount') bad('COUPON_KIND_UNSUPPORTED', `Coupon kind ${cp.kind} is not a checkout discount (redeem via the rewards counter)`, 'คูปองประเภทนี้ใช้เป็นส่วนลดบิลไม่ได้');
    if (ctx.memberId != null && cp.memberId != null && Number(cp.memberId) !== Number(ctx.memberId)) throw new ForbiddenException({ code: 'COUPON_NOT_OWNER', message: 'Coupon belongs to a different member', messageTh: 'คูปองนี้เป็นของสมาชิกท่านอื่น' });
    const discount = cp.kind === 'percent' ? round2(subtotalNet * n(cp.value) / 100) : round2(Math.min(n(cp.value), subtotalNet));
    return { source: 'coupon', code: cp.code, kind: String(cp.kind), value: n(cp.value), discount, codeId: Number(cp.id) };
  }

  // Atomically consume the code inside the caller's sale transaction. Guarded UPDATEs (WHERE state='issued'
  // / status='active') make double redemption impossible under concurrency — the loser gets 0 rows and a
  // 409. The campaign counter increments under its own cap guard (mirrors the promo max_uses pattern).
  async redeemAtCheckout(tx: DrizzleDb, p: VoucherCheckoutPreview, saleNo: string, username: string) {
    if (p.source === 'voucher') {
      const max = Math.max(1, p.perCodeMaxUses ?? 1);
      const upd = await tx.update(voucherCodes).set({
        useCount: sql`${voucherCodes.useCount} + 1`,
        state: sql`CASE WHEN ${voucherCodes.useCount} + 1 >= ${max} THEN 'redeemed' ELSE 'issued' END`,
        redeemedAt: new Date(), redeemedBy: username, saleRef: saleNo,
      }).where(and(eq(voucherCodes.id, p.codeId), eq(voucherCodes.state, 'issued'), sql`${voucherCodes.useCount} < ${max}`)).returning({ id: voucherCodes.id });
      if (!upd.length) throw new ConflictException({ code: 'VOUCHER_ALREADY_REDEEMED', message: 'Voucher code already redeemed', messageTh: 'โค้ดถูกใช้ไปแล้ว' });
      const cap = await tx.update(voucherCampaigns).set({ redeemedCount: sql`${voucherCampaigns.redeemedCount} + 1`, updatedAt: new Date() })
        .where(and(eq(voucherCampaigns.id, p.campaignId!), sql`(${voucherCampaigns.maxRedemptions} IS NULL OR ${voucherCampaigns.redeemedCount} < ${voucherCampaigns.maxRedemptions})`)).returning({ id: voucherCampaigns.id });
      if (!cap.length) throw new ConflictException({ code: 'VOUCHER_EXHAUSTED', message: 'Voucher campaign redemption cap reached', messageTh: 'คูปองแคมเปญนี้ถูกใช้ครบจำนวนแล้ว' });
      return;
    }
    const upd = await tx.update(memberCoupons).set({ status: 'used', usedAt: new Date(), usedRef: saleNo })
      .where(and(eq(memberCoupons.id, p.codeId), eq(memberCoupons.status, 'active'))).returning({ id: memberCoupons.id });
    if (!upd.length) throw new ConflictException({ code: 'ALREADY_USED', message: 'Coupon already used', messageTh: 'คูปองถูกใช้แล้ว' });
  }
}

function shapeCampaign(c: any) {
  return {
    id: Number(c.id), campaign_code: c.campaignCode, name: c.name, kind: c.kind, value: n(c.value),
    min_spend: c.minSpend != null ? n(c.minSpend) : null, channel: c.channel, valid_from: c.validFrom, valid_to: c.validTo,
    per_code_max_uses: Number(c.perCodeMaxUses ?? 1), max_redemptions: c.maxRedemptions != null ? Number(c.maxRedemptions) : null,
    status: c.status, codes_issued: Number(c.codesIssued ?? 0), redeemed_count: Number(c.redeemedCount ?? 0),
    created_by: c.createdBy ?? null, approved_by: c.approvedBy ?? null, approved_at: c.approvedAt ?? null, created_at: c.createdAt,
  };
}

function shapeCode(r: any) {
  return { code: r.code, state: r.state, use_count: Number(r.useCount ?? 0), redeemed_at: r.redeemedAt, redeemed_by: r.redeemedBy, sale_ref: r.saleRef, voided_at: r.voidedAt, void_reason: r.voidReason, created_at: r.createdAt };
}
