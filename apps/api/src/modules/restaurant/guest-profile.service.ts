import { Inject, Injectable, Optional, NotFoundException, ForbiddenException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { memberDiningProfiles, memberCompanions, memberConsents, posMembers, dineInOrders, dineInOrderItems, tableReservations } from '../../database/schema';
import { stripTrailingSlashes } from '@ierp/shared';
import type { JwtUser } from '../../common/decorators';
import { MessagingService } from '../messaging/messaging.service';

// JSON-merge-patch style: an OMITTED field keeps its stored value; an explicit null clears it.
export interface UpsertDiningProfileDto {
  consent?: boolean;              // explicit PDPA consent capture on (first) save — staff confirms with the guest
  favorite_menus?: string[] | null;
  favorite_ingredients?: string[] | null;
  allergies?: string[] | null;
  dietary?: string | null;
  seating_preference?: string | null;
  typical_party_size?: number | null;
  service_notes?: string | null;
  extra?: Record<string, string> | null; // extensible key→value details (favourite wine, occasions, …)
}
export interface AddCompanionDto {
  name: string;
  relationship?: string;
  allergies?: string[];
  preferences?: string;
  notes?: string;
}

// The PDPA per-purpose consent that gates the whole guest-profile surface (member_consents ledger).
export const DINING_PROFILE_PURPOSE = 'dining_profile';

// Michelin-style guest dining profile for the reservation desk (fine-casual / fine-dining service).
// PDPA-FIRST by construction:
//   • CONSENT — every read and write is gated on a GRANTED member_consents row (purpose 'dining_profile').
//     No consent ⇒ GET returns consent_granted:false with NO profile data, and PUT/POST are rejected
//     (403 CONSENT_REQUIRED) unless the save itself captures consent (dto.consent=true, audited source 'pos').
//   • DATA MINIMIZATION — the computed "eats often" list (profiling over the guest's own order history) is
//     behind the same consent; withdrawal (loyalty consents endpoint / member self-service) hides everything.
//   • ERASURE — DSAR erasure and the PDPA-04 retention sweep HARD-DELETE these rows (PdpaService.redactMember);
//     DSAR access/portability exports them (collectMember).
@Injectable()
export class GuestProfileService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly messaging?: MessagingService, // consent-request notice (best-effort)
  ) {}

  async get(memberId: number, user: JwtUser) {
    const db = this.db;
    const m = await this.loadMember(memberId, user);
    const consented = await this.hasConsent(memberId);
    if (!consented) {
      // data minimization: without a granted consent nothing preference-related leaves the store
      return { member_id: memberId, member_code: m.memberCode, name: m.name, consent_granted: false, profile: null, companions: [], top_menus: [], visit_stats: null };
    }
    const [p] = await db.select().from(memberDiningProfiles).where(eq(memberDiningProfiles.memberId, memberId)).limit(1);
    const companions = await db.select().from(memberCompanions).where(and(eq(memberCompanions.memberId, memberId), eq(memberCompanions.active, true))).orderBy(memberCompanions.id);
    // "eats often" — top dishes by count over the guest's own order history (profiling; consent-gated above)
    const top = await db.select({ name: dineInOrderItems.name, times: sql<number>`count(*)::int`, qty: sql<string>`sum(${dineInOrderItems.qty})` })
      .from(dineInOrderItems)
      .innerJoin(dineInOrders, eq(dineInOrderItems.orderId, dineInOrders.id))
      .where(and(eq(dineInOrders.memberId, memberId), isNull(dineInOrderItems.voidedAt), eq(dineInOrderItems.isBuffet, false)))
      .groupBy(dineInOrderItems.name).orderBy(desc(sql`count(*)`)).limit(5);
    const [visits] = await db.select({ visits: sql<number>`count(*)::int`, avgParty: sql<string>`avg(${dineInOrders.guestCount})`, lastVisit: sql<string>`max(${dineInOrders.openedAt})` })
      .from(dineInOrders).where(eq(dineInOrders.memberId, memberId));
    return {
      member_id: memberId, member_code: m.memberCode, name: m.name, consent_granted: true,
      profile: p ? this.shapeProfile(p) : null,
      companions: companions.map((c: any) => this.shapeCompanion(c)),
      top_menus: top.map((t2: any) => ({ name: t2.name, times: Number(t2.times), qty: Number(t2.qty ?? 0) })),
      visit_stats: visits && Number(visits.visits) > 0
        ? { visits: Number(visits.visits), avg_party_size: visits.avgParty != null ? Math.round(Number(visits.avgParty) * 10) / 10 : null, last_visit: visits.lastVisit ?? null }
        : { visits: 0, avg_party_size: null, last_visit: null },
    };
  }

  async upsert(memberId: number, dto: UpsertDiningProfileDto, user: JwtUser) {
    const db = this.db;
    await this.loadMember(memberId, user);
    await this.requireOrCaptureConsent(memberId, dto.consent === true, user);
    // JSON-merge-patch semantics: an OMITTED field keeps its stored value — a client that edits one field
    // can never silently wipe the rest (e.g. `extra` set via the API survives a web save that doesn't carry
    // it). An explicit null clears the field.
    const patch: Partial<typeof memberDiningProfiles.$inferInsert> = { updatedAt: new Date() };
    if (dto.favorite_menus !== undefined) patch.favoriteMenus = cleanList(dto.favorite_menus);
    if (dto.favorite_ingredients !== undefined) patch.favoriteIngredients = cleanList(dto.favorite_ingredients);
    if (dto.allergies !== undefined) patch.allergies = cleanList(dto.allergies);
    if (dto.dietary !== undefined) patch.dietary = dto.dietary?.trim() || null;
    if (dto.seating_preference !== undefined) patch.seatingPreference = dto.seating_preference?.trim() || null;
    if (dto.typical_party_size !== undefined) patch.typicalPartySize = dto.typical_party_size;
    if (dto.service_notes !== undefined) patch.serviceNotes = dto.service_notes?.trim() || null;
    if (dto.extra !== undefined) patch.extra = dto.extra && Object.keys(dto.extra).length ? dto.extra : null;
    const [existing] = await db.select({ id: memberDiningProfiles.id }).from(memberDiningProfiles).where(eq(memberDiningProfiles.memberId, memberId)).limit(1);
    if (existing) {
      await db.update(memberDiningProfiles).set(patch).where(eq(memberDiningProfiles.id, existing.id));
    } else {
      await db.insert(memberDiningProfiles).values({ tenantId: user.tenantId!, memberId, ...patch, createdBy: user.username });
    }
    return this.get(memberId, user);
  }

  async addCompanion(memberId: number, dto: AddCompanionDto, user: JwtUser) {
    const db = this.db;
    await this.loadMember(memberId, user);
    await this.requireOrCaptureConsent(memberId, false, user);
    const [row] = await db.insert(memberCompanions).values({
      tenantId: user.tenantId!, memberId, name: dto.name.trim(),
      relationship: dto.relationship?.trim() || null, allergies: cleanList(dto.allergies),
      preferences: dto.preferences?.trim() || null, notes: dto.notes?.trim() || null, createdBy: user.username,
    }).returning();
    return this.shapeCompanion(row);
  }

  // Ask the GUEST THEMSELVES for the 'dining_profile' consent — a stronger PDPA posture than the
  // staff-attested checkbox: the message (LINE when linked, else SMS) deep-links to the member portal /m
  // where the member self-manages consents (LYL-10c, source='self'). Transactional campaign
  // 'consent_request' (a service notice, not marketing); delivery is audited in message_log.
  async requestConsent(memberId: number, user: JwtUser) {
    const m = await this.loadMember(memberId, user);
    if (await this.hasConsent(memberId)) return { member_id: memberId, already_granted: true, requested: false };
    if (!this.messaging) return { member_id: memberId, already_granted: false, requested: false, status: 'unavailable' };
    const base = stripTrailingSlashes(process.env.WEB_BASE_URL);
    const link = base ? ` จัดการได้ที่ ${base}/m (เมนู "ความยินยอม PDPA")` : ' จัดการได้ในแอปสมาชิกของร้าน (เมนู "ความยินยอม PDPA")';
    const body = `🍽️ ${m.name ? 'คุณ' + m.name + ' ' : ''}ทางร้านขอความยินยอมบันทึกข้อมูลความชอบในการรับประทาน (เมนูโปรด/วัตถุดิบ/แพ้อาหาร) เพื่อการบริการที่ดียิ่งขึ้น ท่านให้หรือถอนความยินยอมได้ทุกเมื่อ${link}`;
    const channel: 'line' | 'sms' = m.lineUserId ? 'line' : 'sms';
    let delivered: any = null;
    try { delivered = await this.messaging.send({ member_id: memberId, channel, body, campaign: 'consent_request' }, user); } catch { /* notice is best-effort */ }
    return { member_id: memberId, already_granted: false, requested: true, status: delivered?.status ?? 'failed', channel: delivered?.channel ?? channel };
  }

  // Service-time flags for the floor + kitchen: for each table, the CONSENTED dining cautions of the guest
  // currently seated there (latest 'seated' reservation with a linked member within the last 12h). Computed
  // at read time — nothing is copied into orders/tickets, so consent withdrawal or erasure takes effect
  // immediately and the PDPA erasure surface stays the two guest-CRM tables.
  async serviceFlagsByTable(tableIds: number[], tenantId: number) {
    const flags = new Map<number, { member_id: number; name: string | null; allergies: string[]; dietary: string | null; seating_preference: string | null; service_notes: string | null }>();
    if (!tableIds.length) return flags;
    const db = this.db;
    const since = new Date(Date.now() - 12 * 3600_000);
    const seated = await db.select({ tableId: tableReservations.tableId, memberId: tableReservations.memberId, seatedAt: tableReservations.seatedAt })
      .from(tableReservations)
      .where(and(eq(tableReservations.tenantId, tenantId), inArray(tableReservations.tableId, tableIds), eq(tableReservations.status, 'seated'), isNotNull(tableReservations.memberId), gte(tableReservations.seatedAt, since)))
      .orderBy(desc(tableReservations.seatedAt));
    const byTable = new Map<number, number>(); // table → latest seated member
    for (const r of seated) if (r.tableId != null && r.memberId != null && !byTable.has(Number(r.tableId))) byTable.set(Number(r.tableId), Number(r.memberId));
    const memberIds = [...new Set(byTable.values())];
    if (!memberIds.length) return flags;
    const consents = await db.select({ memberId: memberConsents.memberId }).from(memberConsents)
      .where(and(inArray(memberConsents.memberId, memberIds), eq(memberConsents.purpose, DINING_PROFILE_PURPOSE), eq(memberConsents.granted, true)));
    const consented = new Set(consents.map((c: any) => Number(c.memberId)));
    if (!consented.size) return flags;
    const profiles = await db.select().from(memberDiningProfiles).where(inArray(memberDiningProfiles.memberId, [...consented]));
    const members = await db.select({ id: posMembers.id, name: posMembers.name }).from(posMembers).where(inArray(posMembers.id, [...consented]));
    const nameById = new Map(members.map((m: any) => [Number(m.id), m.name]));
    const profById = new Map(profiles.map((p: any) => [Number(p.memberId), p]));
    for (const [tableId, memberId] of byTable) {
      if (!consented.has(memberId)) continue;
      const p: any = profById.get(memberId);
      const allergies = (p?.allergies as string[] | null) ?? [];
      if (!p || (!allergies.length && !p.dietary && !p.serviceNotes && !p.seatingPreference)) continue; // nothing actionable
      flags.set(tableId, { member_id: memberId, name: nameById.get(memberId) ?? null, allergies, dietary: p.dietary, seating_preference: p.seatingPreference, service_notes: p.serviceNotes });
    }
    return flags;
  }

  // Hard delete — companion rows are third-party PII with no accounting value (PDPA data minimization).
  async removeCompanion(memberId: number, companionId: number, user: JwtUser) {
    const db = this.db;
    await this.loadMember(memberId, user);
    const [row] = await db.select().from(memberCompanions).where(and(eq(memberCompanions.id, companionId), eq(memberCompanions.memberId, memberId))).limit(1);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Companion not found', messageTh: 'ไม่พบข้อมูลผู้ร่วมโต๊ะ' });
    await db.delete(memberCompanions).where(eq(memberCompanions.id, companionId));
    return { id: companionId, deleted: true };
  }

  // ── PDPA consent gate ──
  private async hasConsent(memberId: number) {
    const db = this.db;
    const [c] = await db.select({ granted: memberConsents.granted }).from(memberConsents)
      .where(and(eq(memberConsents.memberId, memberId), eq(memberConsents.purpose, DINING_PROFILE_PURPOSE))).limit(1);
    return c?.granted === true;
  }

  // A write needs a live consent; the (first) save may capture it — recorded in the member_consents
  // ledger (source 'pos', createdBy = the staff who confirmed it with the guest). A withdrawn consent is
  // re-grantable only via the same explicit capture, never silently.
  private async requireOrCaptureConsent(memberId: number, capture: boolean, user: JwtUser) {
    if (await this.hasConsent(memberId)) return;
    if (!capture) {
      throw new ForbiddenException({ code: 'CONSENT_REQUIRED', message: `Member has not granted the '${DINING_PROFILE_PURPOSE}' consent`, messageTh: 'ลูกค้ายังไม่ได้ให้ความยินยอมเก็บข้อมูลความชอบ (PDPA) — โปรดขอความยินยอมก่อนบันทึก' });
    }
    const db = this.db;
    await db.insert(memberConsents)
      .values({ tenantId: user.tenantId!, memberId, purpose: DINING_PROFILE_PURPOSE, granted: true, source: 'pos', grantedAt: new Date(), createdBy: user.username })
      .onConflictDoUpdate({ target: [memberConsents.memberId, memberConsents.purpose], set: { granted: true, grantedAt: new Date(), withdrawnAt: null, source: 'pos', updatedAt: new Date() } });
  }

  private async loadMember(memberId: number, user: JwtUser) {
    const db = this.db;
    const [m] = await db.select().from(posMembers).where(and(eq(posMembers.id, memberId), eq(posMembers.tenantId, user.tenantId as number))).limit(1);
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    return m;
  }

  private shapeProfile(p: any) {
    return {
      favorite_menus: (p.favoriteMenus as string[] | null) ?? [],
      favorite_ingredients: (p.favoriteIngredients as string[] | null) ?? [],
      allergies: (p.allergies as string[] | null) ?? [],
      dietary: p.dietary, seating_preference: p.seatingPreference,
      typical_party_size: p.typicalPartySize, service_notes: p.serviceNotes,
      extra: (p.extra as Record<string, string> | null) ?? {},
      updated_at: p.updatedAt,
    };
  }
  private shapeCompanion(c: any) {
    return {
      id: Number(c.id), name: c.name, relationship: c.relationship,
      allergies: (c.allergies as string[] | null) ?? [], preferences: c.preferences, notes: c.notes,
    };
  }
}

// normalize a free-text list: trim, drop empties, cap item length + count (null/empty → cleared)
function cleanList(v: string[] | null | undefined): string[] | null {
  if (!v) return null;
  const out = v.map((s2) => String(s2).trim()).filter(Boolean).slice(0, 40).map((s2) => s2.slice(0, 120));
  return out.length ? out : null;
}
