import { createHash } from 'node:crypto';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { customerProfiles } from '../../database/schema/crm';
import { posMembers } from '../../database/schema/loyalty-members';
import { memberConsents } from '../../database/schema/member-consents';
import { auditLog, audienceExports, audienceExportMembers } from '../../database/schema';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// PDPA-05 audience/CDP egress surface (docs/45 G3) — extracted off CrmService (600-LOC service-size
// headroom round; ctor-body plain class, no DI). Consent-filtered hashed ads-audience export, the
// withdrawal-removal manifest, the append-only export register, and the consent-carrying CDP export.
export class CrmAudienceService {
  constructor(private readonly db: DrizzleDb) {}

  // G3 (docs/45, PDPA-05) — the ads-activation export: SHA-256-hashed phone/email rows in the Meta Custom
  // Audiences / Google Customer Match ingest format. STRICTER than exportForCdp BY DESIGN:
  //   • consent is FILTERED, not carried — only members with a LIVE marketing consent row in
  //     member_consents (granted, not withdrawn) are included. NO fallback to the legacy marketingOptIn
  //     flag: the consent ledger is the legal basis, and a member with no row is EXCLUDED (fail-closed).
  //   • raw PII never leaves — email is trim+lowercased, phone normalized to E.164 digits (Thai 0x → 66x),
  //     then each is SHA-256 hashed (the exact normalization both ad platforms specify). Rows with neither
  //     identifier are skipped. No names, no member codes, no traits.
  async exportForCustomerMatch(user: JwtUser, opts: { tenantId?: number | null; limit?: number; offset?: number } = {}) {
    const db = this.db;
    const tenantId = opts.tenantId ?? user.tenantId;
    if (tenantId == null) return { error: { code: 'TENANT_REQUIRED', message: 'HQ/Admin must specify tenant_id', messageTh: 'สำนักงานใหญ่ต้องระบุ tenant_id' } };
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
    const offset = Math.max(opts.offset ?? 0, 0);

    const liveConsent = and(
      eq(memberConsents.tenantId, tenantId), eq(memberConsents.purpose, 'marketing'),
      eq(memberConsents.granted, true), sql`${memberConsents.withdrawnAt} IS NULL`,
    );
    const consentedIds = db.select({ id: memberConsents.memberId }).from(memberConsents).where(liveConsent);
    const rows = await db.select({ id: posMembers.id, phone: posMembers.phone, email: posMembers.email })
      .from(posMembers)
      .where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.active, true), inArray(posMembers.id, consentedIds)))
      .orderBy(posMembers.id).limit(limit).offset(offset);

    const [tot] = await db.select({ c: sql<number>`count(*)` }).from(posMembers)
      .where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.active, true)));
    const [cons] = await db.select({ c: sql<number>`count(*)` }).from(posMembers)
      .where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.active, true), inArray(posMembers.id, consentedIds)));

    const sha = (v: string) => createHash('sha256').update(v).digest('hex');
    const normPhone = (raw: string): string | null => {
      const digits = String(raw).replace(/\D/g, '').replace(/^00/, '');
      if (digits.length < 7) return null;
      return digits.startsWith('0') ? `66${digits.slice(1)}` : digits; // Thai-first E.164, no '+'
    };
    const members = rows.flatMap((r: any) => {
      const em = r.email ? String(r.email).trim().toLowerCase() : null;
      const ph = r.phone ? normPhone(r.phone) : null;
      if (!em && !ph) return [];
      // hashed_phone = Meta's format (E.164 digits, no '+'); hashed_phone_plus = Google's ('+' prefixed
      // before hashing, per each platform's published normalization). Both are sha256 — still hash-only.
      // member_id is INTERNAL (manifest upkeep) — the BI job strips it before any wire payload.
      return [{ member_id: Number(r.id), ...(em ? { hashed_email: sha(em) } : {}), ...(ph ? { hashed_phone: sha(ph), hashed_phone_plus: sha(`+${ph}`) } : {}) }];
    });

    // ICFR/PDPA egress trail (ITGC-AC-10): a hashed-audience export is still a sensitive egress — record it.
    try {
      await db.insert(auditLog).values({
        actor: user?.username ?? null, tenantId, action: 'CRM.AUDIENCE_EXPORT', entity: 'audience_export',
        entityId: null, status: 'success', meta: { rows: members.length, consented: Number(cons?.c ?? 0), total: Number(tot?.c ?? 0), limit, offset },
      });
    } catch { /* never throw from audit */ }

    return {
      tenant_id: tenantId, hash_alg: 'sha256', consent_basis: 'member_consents:marketing',
      total_active: Number(tot?.c ?? 0), consented: Number(cons?.c ?? 0),
      count: members.length, limit, offset, members,
    };
  }

  // ── Withdrawal removal sync (extends PDPA-05) — the upload manifest keeps the external audience
  //    continuously consistent with the consent ledger. Hashes are captured at upload time, so a later
  //    DSAR erasure (which nulls phone/email) cannot orphan the removal. ──
  async upsertAudienceManifest(tenantId: number, rows: { member_id: number; hashed_email?: string; hashed_phone?: string; hashed_phone_plus?: string }[]) {
    const db = this.db;
    const now = new Date();
    for (const r of rows) {
      await db.insert(audienceExportMembers)
        .values({ tenantId, memberId: r.member_id, hashedEmail: r.hashed_email ?? null, hashedPhone: r.hashed_phone ?? null, hashedPhonePlus: r.hashed_phone_plus ?? null, lastPushedAt: now, removedAt: null })
        .onConflictDoUpdate({
          target: [audienceExportMembers.tenantId, audienceExportMembers.memberId],
          set: { hashedEmail: r.hashed_email ?? null, hashedPhone: r.hashed_phone ?? null, hashedPhonePlus: r.hashed_phone_plus ?? null, lastPushedAt: now, removedAt: null, updatedAt: now },
        });
    }
  }

  // Manifest rows still "out there" whose member NO LONGER has a live marketing consent — the removal set.
  async audienceRemovalCandidates(tenantId: number, limit = 5000) {
    const db = this.db;
    const liveConsent = and(
      eq(memberConsents.tenantId, tenantId), eq(memberConsents.purpose, 'marketing'),
      eq(memberConsents.granted, true), sql`${memberConsents.withdrawnAt} IS NULL`,
    );
    const consentedIds = db.select({ id: memberConsents.memberId }).from(memberConsents).where(liveConsent);
    const rows = await db.select().from(audienceExportMembers)
      .where(and(
        eq(audienceExportMembers.tenantId, tenantId), sql`${audienceExportMembers.removedAt} IS NULL`,
        sql`${audienceExportMembers.memberId} NOT IN (${consentedIds})`,
      ))
      .limit(limit);
    return rows.map((r: any) => ({ member_id: Number(r.memberId), ...(r.hashedEmail ? { hashed_email: r.hashedEmail } : {}), ...(r.hashedPhone ? { hashed_phone: r.hashedPhone } : {}), ...(r.hashedPhonePlus ? { hashed_phone_plus: r.hashedPhonePlus } : {}) }));
  }

  async markAudienceRemoved(tenantId: number, memberIds: number[]) {
    if (!memberIds.length) return;
    const db = this.db;
    const now = new Date();
    await db.update(audienceExportMembers).set({ removedAt: now, updatedAt: now })
      .where(and(eq(audienceExportMembers.tenantId, tenantId), inArray(audienceExportMembers.memberId, memberIds)));
  }

  // G3 — the append-only export register (PDPA-05 evidence surface).
  async audienceExportRegister(user: JwtUser, limit = 50) {
    const db = this.db;
    const rows = await db.select().from(audienceExports).orderBy(desc(audienceExports.id)).limit(Math.min(limit, 200));
    return {
      exports: rows.map((r: any) => ({
        id: r.id, purpose: r.purpose, consent_basis: r.consentBasis, target: r.target, hash_alg: r.hashAlg,
        members_considered: Number(r.membersConsidered), members_consented: Number(r.membersConsented), rows_pushed: Number(r.rowsPushed), rows_removed: Number(r.rowsRemoved ?? 0),
        status: r.status, error: r.error, ropa_activity_id: r.ropaActivityId, created_by: r.createdBy, created_at: r.createdAt,
      })),
      count: rows.length,
    };
  }

  async exportForCdp(user: JwtUser, opts: { tenantId?: number | null; limit?: number; offset?: number }) {
    const db = this.db;
    const tenantId = opts.tenantId ?? user.tenantId;
    if (tenantId == null) return { error: { code: 'TENANT_REQUIRED', message: 'HQ/Admin must specify tenant_id', messageTh: 'สำนักงานใหญ่ต้องระบุ tenant_id' } };
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
    const offset = Math.max(opts.offset ?? 0, 0);

    const rows = await db.select({
      id: posMembers.id, code: posMembers.memberCode, name: posMembers.name, phone: posMembers.phone,
      email: posMembers.email, lineUserId: posMembers.lineUserId, tier: posMembers.tier,
      balance: posMembers.balance, lifetime: posMembers.lifetime, marketingOptIn: posMembers.marketingOptIn,
      segment: customerProfiles.rfmSegment, totalOrders: customerProfiles.totalOrders, totalSpend: customerProfiles.totalSpend,
      rfmRecency: customerProfiles.rfmRecency, rfmFrequency: customerProfiles.rfmFrequency, rfmMonetary: customerProfiles.rfmMonetary,
      preferredChannel: customerProfiles.preferredChannel, avgOrderValue: customerProfiles.avgOrderValue, lastOrderAt: customerProfiles.lastOrderAt,
    }).from(posMembers).leftJoin(customerProfiles, eq(customerProfiles.memberId, posMembers.id))
      .where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.active, true)))
      .orderBy(posMembers.id).limit(limit).offset(offset);

    // Per-purpose consent for exactly the members in this page (granted flag; withdrawn if withdrawnAt set).
    const ids = rows.map((r: any) => Number(r.id));
    const consentMap = new Map<number, Record<string, boolean>>();
    if (ids.length) {
      const cons = await db.select({ memberId: memberConsents.memberId, purpose: memberConsents.purpose, granted: memberConsents.granted })
        .from(memberConsents).where(and(eq(memberConsents.tenantId, tenantId), inArray(memberConsents.memberId, ids)));
      for (const c of cons) {
        const m = consentMap.get(Number(c.memberId)) ?? {};
        m[c.purpose] = c.granted === true;
        consentMap.set(Number(c.memberId), m);
      }
    }
    const [tot] = await db.select({ c: sql<number>`count(*)` }).from(posMembers).where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.active, true)));

    // ICFR egress trail: a bulk PII export is a sensitive read — record who exported how much, when
    // (append-only auditLog, ITGC-AC-10). Best-effort: auditing never blocks the export.
    try {
      await db.insert(auditLog).values({
        actor: user?.username ?? null, tenantId, action: 'CRM.CDP_EXPORT', entity: 'member_export',
        entityId: null, status: 'success', meta: { rows: rows.length, total: Number(tot?.c ?? 0), limit, offset },
      });
    } catch { /* never throw from audit */ }

    return {
      tenant_id: tenantId, total: Number(tot?.c ?? 0), count: rows.length, limit, offset,
      members: rows.map((r: any) => {
        const c = consentMap.get(Number(r.id)) ?? {};
        return {
          member_code: r.code, name: r.name, phone: r.phone, email: r.email ?? null, has_line: !!r.lineUserId,
          tier: r.tier, points_balance: n(r.balance), lifetime_points: n(r.lifetime),
          rfm_segment: r.segment ?? null, total_orders: r.totalOrders ?? 0, total_spend: n(r.totalSpend),
          rfm: { recency: r.rfmRecency ?? null, frequency: r.rfmFrequency ?? null, monetary: n(r.rfmMonetary) },
          preferred_channel: r.preferredChannel ?? null, avg_order_value: n(r.avgOrderValue), last_order_at: r.lastOrderAt ?? null,
          // marketing opt-out drives the top-level flag; per-purpose consents (line/sms/email/profiling) fall
          // back to the marketing flag when not explicitly recorded, so the CDP has a safe default.
          consent: {
            marketing: c.marketing ?? (r.marketingOptIn === true),
            line: c.line ?? (r.marketingOptIn === true),
            sms: c.sms ?? (r.marketingOptIn === true),
            email: c.email ?? (r.marketingOptIn === true),
            profiling: c.profiling ?? true,
          },
        };
      }),
    };
  }
}
