import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenantMessagingConfig, messageLog } from '../../database/schema';
import { encrypt, decrypt } from '../../common/crypto';
import type { MessageChannel } from './gateways';
import type { JwtUser } from '../../common/decorators';

const CHANNELS: MessageChannel[] = ['line', 'sms', 'email'];

// Per-tenant messaging provider credentials. A tenant that configures its own LINE OA token / SMS key /
// SMTP mailbox overrides the shared platform env default in the gateway resolver; unset ⇒ env ⇒ mock.
// Secrets are AES-256-GCM encrypted at rest (config_enc) and are WRITE-ONLY — get() never returns them,
// only which channels are configured/enabled. RLS scopes every row to the caller's tenant.
@Injectable()
export class TenantMessagingService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Admin UI view — configured/enabled per channel, NEVER the secret values. Phase F3 (docs/27) adds go-live
  // readiness: `resolved_provider` mirrors the gateway's resolution order (tenant creds → platform env →
  // mock — a ⚪ mock channel logs sends as 'sent' but nothing leaves the building), `callback_token_set`
  // (boolean only), and the channel's last message_log row (when/status/provider) so an admin can see at a
  // glance whether messaging actually delivers. Secrets are decrypted internally for the boolean checks and
  // never serialized.
  async get(user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(tenantMessagingConfig).where(eq(tenantMessagingConfig.tenantId, user.tenantId as number));
    const byChannel = new Map<string, any>(rows.map((r: any) => [r.channel, r]));
    const e = process.env;
    const envPrimary: Record<MessageChannel, string | undefined> = { line: e.LINE_CHANNEL_TOKEN, sms: e.SMS_API_KEY, email: e.SMTP_HOST };
    const primaryKey: Record<MessageChannel, string> = { line: 'token', sms: 'apiKey', email: 'host' };
    const channels: any[] = [];
    for (const ch of CHANNELS) {
      const r = byChannel.get(ch);
      let creds: Record<string, any> | null = null;
      if (r?.configEnc) { try { creds = JSON.parse(decrypt(r.configEnc)); } catch { creds = null; } }
      const tenantLive = r?.enabled === true && !!creds?.[primaryKey[ch]];
      const resolved = tenantLive ? 'tenant' : envPrimary[ch] ? 'env' : 'mock';
      const [last] = await db.select({ at: messageLog.createdAt, status: messageLog.status, provider: messageLog.provider })
        .from(messageLog).where(and(eq(messageLog.tenantId, user.tenantId as number), eq(messageLog.channel, ch)))
        .orderBy(desc(messageLog.id)).limit(1);
      channels.push({
        channel: ch, configured: !!r?.configEnc, enabled: r ? r.enabled === true : false,
        resolved_provider: resolved, callback_token_set: !!creds?.callbackToken,
        last_send_at: last?.at ?? null, last_status: last?.status ?? null, last_provider: last?.provider ?? null,
        updated_at: r?.updatedAt ?? null, updated_by: r?.updatedBy ?? null,
      });
    }
    return { channels };
  }

  // Store (encrypted) per-tenant provider credentials for a channel. Minimal shape validation per channel.
  async set(channel: string, creds: Record<string, any>, enabled: boolean, user: JwtUser) {
    if (!CHANNELS.includes(channel as MessageChannel)) throw new BadRequestException({ code: 'BAD_CHANNEL', message: `Unknown channel: ${channel}`, messageTh: 'ช่องทางไม่ถูกต้อง' });
    this.validate(channel as MessageChannel, creds);
    const db = this.db;
    const now = new Date();
    const configEnc = encrypt(JSON.stringify(creds));
    await db.insert(tenantMessagingConfig)
      .values({ tenantId: user.tenantId, channel, configEnc, enabled, updatedAt: now, updatedBy: user.username ?? null })
      .onConflictDoUpdate({ target: [tenantMessagingConfig.tenantId, tenantMessagingConfig.channel], set: { configEnc, enabled, updatedAt: now, updatedBy: user.username ?? null } });
    return { channel, configured: true, enabled };
  }

  private validate(channel: MessageChannel, c: Record<string, any>) {
    const need = (k: string) => { if (!c?.[k]) throw new BadRequestException({ code: 'MISSING_FIELD', message: `${channel}: ${k} required`, messageTh: `ต้องระบุ ${k}` }); };
    if (channel === 'line') need('token');
    else if (channel === 'sms') { need('apiKey'); need('apiUrl'); }
    else if (channel === 'email') need('host');
  }

  // ── W3 (docs/27) — tenant-wide messaging governance ──────────────────────
  // Quiet hours + a GLOBAL cross-channel frequency cap for MARKETING sends (transactional exempt), enforced
  // inside MessagingService.send. Stored as a synthetic 'governance' row in tenant_messaging_config (no new
  // table); not a secret, but rides the same encrypted column for storage consistency. OPT-IN: a tenant with
  // no governance row has no quiet window and no cap (existing behaviour unchanged, and harness/CI runs stay
  // deterministic); the settings UI suggests 21:00–09:00 Asia/Bangkok + 4 msgs/member/7d when enabling.
  // cap 0 = no cap; quiet_start == quiet_end = no quiet window.
  async getGovernance(tenantId: number | null | undefined): Promise<{ quiet_start: string; quiet_end: string; weekly_cap: number }> {
    const fallback = { quiet_start: '00:00', quiet_end: '00:00', weekly_cap: 0 };
    if (tenantId == null) return fallback;
    const db = this.db;
    const [r] = await db.select().from(tenantMessagingConfig)
      .where(and(eq(tenantMessagingConfig.tenantId, tenantId), eq(tenantMessagingConfig.channel, 'governance'))).limit(1);
    if (!r?.configEnc) return fallback;
    try {
      const g = JSON.parse(decrypt(r.configEnc));
      return {
        quiet_start: /^\d{2}:\d{2}$/.test(g.quiet_start ?? '') ? g.quiet_start : fallback.quiet_start,
        quiet_end: /^\d{2}:\d{2}$/.test(g.quiet_end ?? '') ? g.quiet_end : fallback.quiet_end,
        weekly_cap: Number.isFinite(Number(g.weekly_cap)) ? Math.max(0, Math.floor(Number(g.weekly_cap))) : fallback.weekly_cap,
      };
    } catch { return fallback; }
  }

  async setGovernance(dto: { quiet_start?: string; quiet_end?: string; weekly_cap?: number }, user: JwtUser) {
    const hhmm = /^\d{2}:\d{2}$/;
    if (dto.quiet_start != null && !hhmm.test(dto.quiet_start)) throw new BadRequestException({ code: 'BAD_TIME', message: 'quiet_start must be HH:MM', messageTh: 'รูปแบบเวลาไม่ถูกต้อง' });
    if (dto.quiet_end != null && !hhmm.test(dto.quiet_end)) throw new BadRequestException({ code: 'BAD_TIME', message: 'quiet_end must be HH:MM', messageTh: 'รูปแบบเวลาไม่ถูกต้อง' });
    if (dto.weekly_cap != null && (!Number.isInteger(dto.weekly_cap) || dto.weekly_cap < 0)) throw new BadRequestException({ code: 'BAD_CAP', message: 'weekly_cap must be an integer ≥ 0', messageTh: 'เพดานต้องเป็นจำนวนเต็ม ≥ 0' });
    const cur = await this.getGovernance(user.tenantId);
    const next = { quiet_start: dto.quiet_start ?? cur.quiet_start, quiet_end: dto.quiet_end ?? cur.quiet_end, weekly_cap: dto.weekly_cap ?? cur.weekly_cap };
    const db = this.db as any;
    const now = new Date();
    const configEnc = encrypt(JSON.stringify(next));
    await db.insert(tenantMessagingConfig)
      .values({ tenantId: user.tenantId, channel: 'governance', configEnc, enabled: true, updatedAt: now, updatedBy: user.username ?? null })
      .onConflictDoUpdate({ target: [tenantMessagingConfig.tenantId, tenantMessagingConfig.channel], set: { configEnc, enabled: true, updatedAt: now, updatedBy: user.username ?? null } });
    return { governance: next };
  }

  // Resolve decrypted per-tenant creds for the gateway. Returns null when the tenant has no (enabled) override
  // for the channel → the gateway falls back to the platform env. Called inside a tenant-scoped request (RLS).
  async resolveCreds(tenantId: number | null | undefined, channel: MessageChannel): Promise<Record<string, any> | null> {
    if (tenantId == null) return null;
    const db = this.db as any;
    const [r] = await db.select().from(tenantMessagingConfig)
      .where(and(eq(tenantMessagingConfig.tenantId, tenantId), eq(tenantMessagingConfig.channel, channel))).limit(1);
    if (!r || r.enabled !== true || !r.configEnc) return null;
    try { return JSON.parse(decrypt(r.configEnc)); } catch { return null; }
  }
}
