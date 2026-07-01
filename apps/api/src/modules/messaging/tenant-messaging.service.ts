import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenantMessagingConfig } from '../../database/schema';
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

  // Admin UI view — configured/enabled per channel, NEVER the secret values.
  async get(user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(tenantMessagingConfig).where(eq(tenantMessagingConfig.tenantId, user.tenantId as number));
    const byChannel = new Map<string, any>(rows.map((r: any) => [r.channel, r]));
    return {
      channels: CHANNELS.map((ch) => {
        const r = byChannel.get(ch);
        return { channel: ch, configured: !!r?.configEnc, enabled: r ? r.enabled === true : false, updated_at: r?.updatedAt ?? null, updated_by: r?.updatedBy ?? null };
      }),
    };
  }

  // Store (encrypted) per-tenant provider credentials for a channel. Minimal shape validation per channel.
  async set(channel: string, creds: Record<string, any>, enabled: boolean, user: JwtUser) {
    if (!CHANNELS.includes(channel as MessageChannel)) throw new BadRequestException({ code: 'BAD_CHANNEL', message: `Unknown channel: ${channel}`, messageTh: 'ช่องทางไม่ถูกต้อง' });
    this.validate(channel as MessageChannel, creds);
    const db = this.db as any;
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
