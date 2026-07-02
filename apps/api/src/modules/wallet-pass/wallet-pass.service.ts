import { Inject, Injectable, Optional, BadRequestException, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { eq, and, sql, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { walletPassRegistrations, posMembers, tenants, tenantMessagingConfig } from '../../database/schema';
import { n } from '../../database/queries';
import { decrypt } from '../../common/crypto';
import { runInTenantContext } from '../../common/tenant-run';
import { tenantALS } from '../../common/tenant-context';
import { BiLiveService, type BiLiveEvent } from '../bi/bi-live.service';
import type { JwtUser } from '../../common/decorators';
import { resolveWalletPassProvider, type WalletPlatform, type WalletPassFields } from './wallet-pass.providers';

// V5 (docs/29) — member card in the phone wallet. issue() registers (idempotently, one row per
// member×platform) and returns the provider payload/install link; the BiLive loyalty-tick subscriber keeps
// registered passes current (updates_count/last_points) after every earn/redeem — best-effort like the SSE
// bus itself, never a control. Tenant wallet creds ride tenant_messaging_config (channels 'wallet-apple' /
// 'wallet-google', same AES-GCM write-only posture as messaging) → platform env → mock.
@Injectable()
export class WalletPassService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    // Optional so partial harnesses without BiLiveModule still construct; passes then simply don't auto-update.
    @Optional() private readonly live?: BiLiveService,
  ) {}

  onModuleInit() {
    // Subscribe once to the live loyalty tick. The bus delivers SYNCHRONOUSLY inside the publisher's
    // request — so defer a turn AND exit the tenant ALS before writing, or runInTenantContext would open a
    // savepoint on the publisher's live tx and its set_config would clobber the outer transaction's GUCs
    // (found via the LYL-19 ToE: the coalition earn's later cross-tenant IC leg lost bypass_rls mid-tx).
    // Failures are swallowed: a missed pass refresh is cosmetic.
    this.live?.stream().subscribe((ev: BiLiveEvent) => {
      if (ev?.type !== 'loyalty_points') return;
      setImmediate(() => tenantALS.exit(() => { void this.onPointsTick(ev).catch(() => { /* best-effort */ }); }));
    });
  }

  private async onPointsTick(ev: BiLiveEvent) {
    const tenantId = ev.tenant_id != null ? Number(ev.tenant_id) : null;
    const memberId = ev.member_id != null ? Number(ev.member_id) : null;
    if (tenantId == null || memberId == null) return;
    await runInTenantContext(this.db, { tenantId, bypass: false, actor: 'system:wallet-pass' }, async () => {
      await this.db.update(walletPassRegistrations)
        .set({
          updatesCount: sql`${walletPassRegistrations.updatesCount} + 1`,
          lastPoints: ev.balance_after != null ? String(n(ev.balance_after)) : undefined,
          lastUpdateAt: new Date(),
        })
        .where(and(
          eq(walletPassRegistrations.tenantId, tenantId),
          eq(walletPassRegistrations.memberId, memberId),
          eq(walletPassRegistrations.status, 'Active'),
        ));
    });
  }

  // ── Issue (member self-scoped via /api/member/wallet-pass; staff preview reuses it read-only) ──
  async issueForMember(u: JwtUser, dto: { platform?: string }) {
    if (u.tenantId == null || u.memberId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No member context', messageTh: 'ไม่พบบริบทสมาชิก' });
    return this.issue(u.tenantId, u.memberId, normalizePlatform(dto.platform), u.username ?? 'member:self');
  }

  async issue(tenantId: number, memberId: number, platform: WalletPlatform, actor: string) {
    const db = this.db;
    const [m] = await db.select().from(posMembers).where(and(eq(posMembers.id, memberId), eq(posMembers.tenantId, tenantId))).limit(1);
    if (!m || m.active === false) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found/inactive', messageTh: 'ไม่พบสมาชิก' });
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);

    const serial = `WP-${tenantId}-${memberId}-${platform}`;
    const provider = resolveWalletPassProvider(platform, await this.tenantCreds(tenantId, platform));
    const fields: WalletPassFields = {
      shop: t?.name ?? t?.code ?? 'Shop', member_code: m.memberCode, name: m.name ?? null,
      tier: m.tier ?? 'Standard', points: n(m.balance),
    };
    const issued = provider.issue(serial, fields);

    // Register — idempotent per member×platform (unique index); a repeat issue refreshes the snapshot only.
    const ins = await db.insert(walletPassRegistrations).values({
      tenantId, memberId, platform, provider: issued.provider, passSerial: serial,
      lastPoints: String(fields.points), lastTier: fields.tier, lastUpdateAt: new Date(), createdBy: actor,
    }).onConflictDoNothing().returning({ id: walletPassRegistrations.id });
    const created = ins.length > 0;
    let id: number;
    const first = ins[0];
    if (first) { id = Number(first.id); }
    else {
      const [existing] = await db.select({ id: walletPassRegistrations.id }).from(walletPassRegistrations)
        .where(and(eq(walletPassRegistrations.memberId, memberId), eq(walletPassRegistrations.platform, platform))).limit(1);
      if (!existing) throw new NotFoundException({ code: 'PASS_NOT_FOUND', message: 'Registration lookup failed', messageTh: 'ไม่พบบัตร' });
      id = Number(existing.id);
      await db.update(walletPassRegistrations)
        .set({ provider: issued.provider, lastPoints: String(fields.points), lastTier: fields.tier, lastUpdateAt: new Date(), status: 'Active' })
        .where(eq(walletPassRegistrations.id, id));
    }
    return { id, repeat: !created, platform, provider: issued.provider, serial, install_url: issued.install_url, pass: issued.pass };
  }

  // ── Staff view (GET /api/loyalty/members/:id/wallet-pass) — registrations + live snapshot ──
  async forMember(user: JwtUser, memberId: number) {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบบริบทร้านค้า' });
    const db = this.db;
    const rows = await db.select().from(walletPassRegistrations)
      .where(and(eq(walletPassRegistrations.tenantId, user.tenantId), eq(walletPassRegistrations.memberId, memberId)))
      .orderBy(desc(walletPassRegistrations.id));
    return {
      member_id: memberId,
      registrations: rows.map((r) => ({
        id: Number(r.id), platform: r.platform, provider: r.provider, serial: r.passSerial, status: r.status,
        updates_count: Number(r.updatesCount), last_points: r.lastPoints != null ? n(r.lastPoints) : null,
        last_tier: r.lastTier, last_update_at: r.lastUpdateAt, created_at: r.createdAt,
      })),
    };
  }

  // Tenant wallet creds ride tenant_messaging_config under 'wallet-apple' / 'wallet-google' (AES-GCM,
  // write-only — same posture as messaging creds). Absent/undecryptable → null → env → mock.
  private async tenantCreds(tenantId: number, platform: WalletPlatform): Promise<Record<string, unknown> | null> {
    const [r] = await this.db.select().from(tenantMessagingConfig)
      .where(and(eq(tenantMessagingConfig.tenantId, tenantId), eq(tenantMessagingConfig.channel, `wallet-${platform}`))).limit(1);
    if (!r || r.enabled !== true || !r.configEnc) return null;
    try { return JSON.parse(decrypt(r.configEnc)); } catch { return null; }
  }
}

function normalizePlatform(p?: string): WalletPlatform {
  return p === 'google' ? 'google' : 'apple';
}
