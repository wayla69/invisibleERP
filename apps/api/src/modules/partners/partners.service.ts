import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { eq, and, desc, count, gt, ne, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { loyaltyPartners, loyaltyPrivileges, loyaltyPrivilegeClaims, posMembers } from '../../database/schema';
import { n } from '../../database/queries';
import { DocNumberService } from '../../common/doc-number.service';
import type { JwtUser } from '../../common/decorators';

// CRM Phase 4 — partner privileges. Member perks at partner merchants (tier-gated discounts/freebies/access).
// A member CLAIMS a privilege → gets a single-use PRV code → the partner marks it USED. Mirrors the rewards
// single-use model (FOR UPDATE, atomic stock guard, per-member limit) but does NOT touch points. Every query
// is explicitly tenant-scoped (RLS is bypassed for Admin).
@Injectable()
export class PartnersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

  private tid(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบบริบทร้านค้า' });
    return user.tenantId;
  }
  private today(): string {
    const bkk = new Date(Date.now() + 7 * 3600_000);
    return `${bkk.getUTCFullYear()}-${String(bkk.getUTCMonth() + 1).padStart(2, '0')}-${String(bkk.getUTCDate()).padStart(2, '0')}`;
  }

  // ── Partners ──
  async listPartners(user: JwtUser, q: { active?: boolean } = {}) {
    const db = this.db as any; const tenantId = this.tid(user);
    const conds: any[] = [eq(loyaltyPartners.tenantId, tenantId)];
    if (q.active !== undefined) conds.push(eq(loyaltyPartners.active, q.active));
    const partners = await db.select().from(loyaltyPartners).where(and(...conds)).orderBy(loyaltyPartners.id);
    const privs = await db.select().from(loyaltyPrivileges).where(eq(loyaltyPrivileges.tenantId, tenantId)).orderBy(loyaltyPrivileges.id);
    return { partners: partners.map((p: any) => ({ ...shapePartner(p), privileges: privs.filter((v: any) => Number(v.partnerId) === Number(p.id)).map(shapePriv) })), count: partners.length };
  }
  async upsertPartner(user: JwtUser, dto: any) {
    const db = this.db as any; const tenantId = this.tid(user);
    const vals = { name: dto.name, category: dto.category ?? null, contact: dto.contact ?? null, active: dto.active ?? true };
    if (dto.id) {
      const [p] = await db.update(loyaltyPartners).set(vals).where(and(eq(loyaltyPartners.id, dto.id), eq(loyaltyPartners.tenantId, tenantId))).returning();
      if (!p) throw new NotFoundException({ code: 'PARTNER_NOT_FOUND', message: 'Partner not found', messageTh: 'ไม่พบพันธมิตร' });
      return shapePartner(p);
    }
    const partnerCode = await this.docNo.nextDaily('PTR');
    const [p] = await db.insert(loyaltyPartners).values({ ...vals, tenantId, partnerCode, createdBy: user.username }).returning();
    return shapePartner(p);
  }

  // ── Privileges ──
  async upsertPrivilege(user: JwtUser, dto: any) {
    const db = this.db as any; const tenantId = this.tid(user);
    const [partner] = await db.select({ id: loyaltyPartners.id }).from(loyaltyPartners).where(and(eq(loyaltyPartners.id, dto.partner_id), eq(loyaltyPartners.tenantId, tenantId))).limit(1);
    if (!partner) throw new NotFoundException({ code: 'PARTNER_NOT_FOUND', message: 'Partner not found', messageTh: 'ไม่พบพันธมิตร' });
    const vals: any = {
      partnerId: dto.partner_id, name: dto.name, description: dto.description ?? null, kind: dto.kind ?? 'discount_percent',
      value: String(dto.value ?? 0), tierMin: dto.tier_min == null ? null : Math.max(0, Math.floor(dto.tier_min)),
      stock: dto.stock == null ? null : Math.max(0, Math.floor(dto.stock)), perMemberLimit: dto.per_member_limit == null ? null : Math.max(1, Math.floor(dto.per_member_limit)),
      validFrom: dto.valid_from ?? null, validTo: dto.valid_to ?? null, active: dto.active ?? true,
    };
    if (dto.id) {
      const [v] = await db.update(loyaltyPrivileges).set(vals).where(and(eq(loyaltyPrivileges.id, dto.id), eq(loyaltyPrivileges.tenantId, tenantId))).returning();
      if (!v) throw new NotFoundException({ code: 'PRIVILEGE_NOT_FOUND', message: 'Privilege not found', messageTh: 'ไม่พบสิทธิพิเศษ' });
      return shapePriv(v);
    }
    const [v] = await db.insert(loyaltyPrivileges).values({ ...vals, tenantId, createdBy: user.username }).returning();
    return shapePriv(v);
  }
  async setPrivilegeActive(user: JwtUser, id: number, active: boolean) {
    const db = this.db as any; const tenantId = this.tid(user);
    const [v] = await db.update(loyaltyPrivileges).set({ active }).where(and(eq(loyaltyPrivileges.id, id), eq(loyaltyPrivileges.tenantId, tenantId))).returning();
    if (!v) throw new NotFoundException({ code: 'PRIVILEGE_NOT_FOUND', message: 'Privilege not found', messageTh: 'ไม่พบสิทธิพิเศษ' });
    return shapePriv(v);
  }

  // Privileges a member currently QUALIFIES for (active, in window, tier_min ≤ lifetime, stock left).
  async available(user: JwtUser, memberId: number) {
    const db = this.db as any; const tenantId = this.tid(user);
    const [m] = await db.select().from(posMembers).where(and(eq(posMembers.id, memberId), eq(posMembers.tenantId, tenantId))).limit(1);
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    const today = this.today(); const life = n(m.lifetime);
    const rows = await db.select().from(loyaltyPrivileges).where(and(eq(loyaltyPrivileges.tenantId, tenantId), eq(loyaltyPrivileges.active, true))).orderBy(loyaltyPrivileges.id);
    const partners = await db.select().from(loyaltyPartners).where(eq(loyaltyPartners.tenantId, tenantId));
    const pmap: Record<number, any> = {}; for (const p of partners) pmap[Number(p.id)] = p;
    const eligible = rows.filter((v: any) =>
      (v.tierMin == null || life >= Number(v.tierMin)) && (v.stock == null || Number(v.stock) > 0)
      && (!v.validFrom || today >= v.validFrom) && (!v.validTo || today <= v.validTo)
      && pmap[Number(v.partnerId)]?.active !== false);
    return { member_id: memberId, privileges: eligible.map((v: any) => ({ ...shapePriv(v), partner: pmap[Number(v.partnerId)]?.name ?? null })) };
  }

  // Claim a privilege → single-use PRV code (tier/stock/per-member-limit guarded under FOR UPDATE).
  async claim(user: JwtUser, privilegeId: number, dto: { member_id: number }) {
    const db = this.db as any; const tenantId = this.tid(user); const today = this.today();
    return await db.transaction(async (tx: any) => {
      const [priv] = await tx.select().from(loyaltyPrivileges).where(and(eq(loyaltyPrivileges.id, privilegeId), eq(loyaltyPrivileges.tenantId, tenantId), eq(loyaltyPrivileges.active, true))).for('update').limit(1);
      if (!priv) throw new NotFoundException({ code: 'PRIVILEGE_NOT_FOUND', message: 'Privilege not found/inactive', messageTh: 'ไม่พบสิทธิพิเศษ' });
      if ((priv.validFrom && today < priv.validFrom) || (priv.validTo && today > priv.validTo)) throw new ConflictException({ code: 'PRIVILEGE_EXPIRED', message: 'Privilege not in its validity window', messageTh: 'สิทธิพิเศษไม่อยู่ในช่วงเวลาที่ใช้ได้' });
      const [m] = await tx.select().from(posMembers).where(and(eq(posMembers.id, dto.member_id), eq(posMembers.tenantId, tenantId), eq(posMembers.active, true))).limit(1);
      if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
      if (priv.tierMin != null && n(m.lifetime) < Number(priv.tierMin)) throw new ConflictException({ code: 'TIER_TOO_LOW', message: 'Member tier too low for this privilege', messageTh: 'ระดับสมาชิกไม่ถึงเกณฑ์' });
      if (priv.perMemberLimit != null) {
        const [{ c }] = await tx.select({ c: count() }).from(loyaltyPrivilegeClaims).where(and(eq(loyaltyPrivilegeClaims.tenantId, tenantId), eq(loyaltyPrivilegeClaims.privilegeId, privilegeId), eq(loyaltyPrivilegeClaims.memberId, dto.member_id), ne(loyaltyPrivilegeClaims.status, 'void')));
        if (Number(c) >= Number(priv.perMemberLimit)) throw new ConflictException({ code: 'LIMIT_REACHED', message: 'Per-member claim limit reached', messageTh: 'ใช้สิทธิ์ครบตามจำนวนแล้ว' });
      }
      if (priv.stock != null) {
        const dec = await tx.update(loyaltyPrivileges).set({ stock: sql`${loyaltyPrivileges.stock} - 1` }).where(and(eq(loyaltyPrivileges.id, privilegeId), eq(loyaltyPrivileges.tenantId, tenantId), gt(loyaltyPrivileges.stock, 0))).returning({ id: loyaltyPrivileges.id });
        if (!dec.length) throw new ConflictException({ code: 'OUT_OF_STOCK', message: 'Privilege out of stock', messageTh: 'สิทธิพิเศษหมดแล้ว' });
      }
      const claimCode = await this.docNo.nextDaily('PRV');
      await tx.insert(loyaltyPrivilegeClaims).values({ tenantId, privilegeId, memberId: dto.member_id, claimCode, status: 'claimed' });
      return { claim_code: claimCode, privilege: priv.name, kind: priv.kind, value: n(priv.value), status: 'claimed' };
    });
  }

  // Partner redeems a claim code — single-use (claimed → used) under FOR UPDATE.
  async use(user: JwtUser, code: string, dto: { partner?: string } = {}) {
    const db = this.db as any; const tenantId = this.tid(user);
    return await db.transaction(async (tx: any) => {
      const [claim] = await tx.select().from(loyaltyPrivilegeClaims).where(and(eq(loyaltyPrivilegeClaims.claimCode, code), eq(loyaltyPrivilegeClaims.tenantId, tenantId))).for('update').limit(1);
      if (!claim) throw new NotFoundException({ code: 'CLAIM_NOT_FOUND', message: 'Privilege claim not found', messageTh: 'ไม่พบรหัสสิทธิพิเศษ' });
      if (claim.status === 'used') throw new ConflictException({ code: 'ALREADY_USED', message: 'Privilege already used', messageTh: 'ใช้สิทธิ์นี้ไปแล้ว' });
      if (claim.status === 'void') throw new ConflictException({ code: 'CLAIM_VOID', message: 'Privilege claim voided', messageTh: 'สิทธิ์ถูกยกเลิก' });
      await tx.update(loyaltyPrivilegeClaims).set({ status: 'used', usedAt: new Date(), usedAtPartner: dto.partner ?? null }).where(eq(loyaltyPrivilegeClaims.id, claim.id));
      return { claim_code: code, status: 'used' };
    });
  }

  async memberClaims(user: JwtUser, memberId: number) {
    const db = this.db as any; const tenantId = this.tid(user);
    const rows = await db.select().from(loyaltyPrivilegeClaims).where(and(eq(loyaltyPrivilegeClaims.memberId, memberId), eq(loyaltyPrivilegeClaims.tenantId, tenantId))).orderBy(desc(loyaltyPrivilegeClaims.id)).limit(50);
    return { member_id: memberId, claims: rows.map((c: any) => ({ id: Number(c.id), claim_code: c.claimCode, privilege_id: Number(c.privilegeId), status: c.status, claimed_at: c.claimedAt, used_at: c.usedAt })) };
  }
}

function shapePartner(p: any) { return { id: Number(p.id), partner_code: p.partnerCode, name: p.name, category: p.category, contact: p.contact, active: p.active }; }
function shapePriv(v: any) {
  return { id: Number(v.id), partner_id: Number(v.partnerId), name: v.name, description: v.description, kind: v.kind, value: n(v.value), tier_min: v.tierMin == null ? null : Number(v.tierMin), stock: v.stock == null ? null : Number(v.stock), per_member_limit: v.perMemberLimit == null ? null : Number(v.perMemberLimit), valid_from: v.validFrom, valid_to: v.validTo, active: v.active };
}
