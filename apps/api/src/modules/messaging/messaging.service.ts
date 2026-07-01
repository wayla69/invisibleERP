import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { posMembers, messageLog, customerProfiles } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { resolveMessageGateway, broadcastLine, broadcastLineFlex, pushLineFlex, type ChannelCreds, type MessageChannel } from './gateways';
import { TenantMessagingService } from './tenant-messaging.service';

type SendDto = { member_id?: number; to?: string; channel: MessageChannel; body: string; campaign?: string };
type BlastDto = { audience: 'all' | 'birthdays_today' | 'segment'; segment?: string; channel: MessageChannel; body: string; campaign?: string };
type BroadcastDto = { body?: string; flex?: any; alt_text?: string; campaign?: string };
type FlexDto = { to: string; alt_text: string; flex: any; member_id?: number; campaign?: string };

@Injectable()
export class MessagingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    // Optional so partial harnesses still construct; when present a tenant's own provider creds override env.
    @Optional() private readonly tenantMsg?: TenantMessagingService,
  ) {}

  // Per-tenant provider creds for a channel (null ⇒ gateway uses the platform env default).
  private creds(user: JwtUser, channel: MessageChannel): Promise<ChannelCreds | null> {
    return this.tenantMsg?.resolveCreds(user.tenantId, channel) ?? Promise.resolve(null);
  }

  // Send one message. Respects marketing consent for member-addressed messages (logs 'skipped').
  async send(dto: SendDto, user: JwtUser, creds?: ChannelCreds | null) {
    const db = this.db as any;
    let member: any = null;
    let recipient = dto.to ?? null;
    if (dto.member_id != null) {
      [member] = await db.select().from(posMembers).where(eq(posMembers.id, dto.member_id)).limit(1);
      if (!member) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
      if (member.marketingOptIn === false) return this.record(user, { memberId: dto.member_id, channel: dto.channel, recipient: null, body: dto.body, campaign: dto.campaign, status: 'skipped', provider: null, error: 'opted out' });
      // LINE pushes address the member's LINE userId (not their phone); email→email; else phone.
      recipient = recipient ?? (dto.channel === 'email' ? member.email : dto.channel === 'line' ? member.lineUserId : member.phone);
    }
    if (!recipient) return this.record(user, { memberId: dto.member_id ?? null, channel: dto.channel, recipient: null, body: dto.body, campaign: dto.campaign, status: 'failed', provider: null, error: 'no recipient contact' });
    // creds passed in (blast resolves once) or resolved here for a single send; null ⇒ env default.
    const resolved = creds !== undefined ? creds : await this.creds(user, dto.channel);
    const gw = resolveMessageGateway(dto.channel, resolved ?? undefined);
    const res = await gw.send(recipient, dto.body);
    return this.record(user, { memberId: dto.member_id ?? null, channel: dto.channel, recipient, body: dto.body, campaign: dto.campaign, status: res.status, provider: res.provider, error: res.error ?? null });
  }

  // Blast to an audience (all opted-in / birthdays today / RFM segment). Sends per member, respecting consent.
  async blast(dto: BlastDto, user: JwtUser) {
    const db = this.db as any;
    let members: any[] = [];
    if (dto.audience === 'segment') {
      if (!dto.segment) throw new BadRequestException({ code: 'NO_SEGMENT', message: 'segment required', messageTh: 'ต้องระบุกลุ่มลูกค้า' });
      const profs = await db.select({ memberId: customerProfiles.memberId }).from(customerProfiles).where(eq(customerProfiles.rfmSegment, dto.segment));
      const ids = profs.map((p: any) => Number(p.memberId)).filter(Boolean);
      members = ids.length ? await db.select().from(posMembers).where(and(inArray(posMembers.id, ids), eq(posMembers.active, true))) : [];
    } else {
      members = await db.select().from(posMembers).where(eq(posMembers.active, true));
      if (dto.audience === 'birthdays_today') {
        const bkk = new Date(Date.now() + 7 * 3600 * 1000);
        const mo = bkk.getUTCMonth() + 1, day = bkk.getUTCDate();
        members = members.filter((m: any) => { if (!m.birthday) return false; const d = new Date(m.birthday + 'T00:00:00Z'); return d.getUTCMonth() + 1 === mo && d.getUTCDate() === day; });
      }
    }
    // Resolve the tenant's provider creds ONCE for the whole blast (not per member).
    const creds = await this.creds(user, dto.channel);
    let sent = 0, skipped = 0, failed = 0;
    for (const m of members) {
      const r: any = await this.send({ member_id: Number(m.id), channel: dto.channel, body: dto.body, campaign: dto.campaign ?? `blast:${dto.audience}` }, user, creds);
      if (r.status === 'sent') sent++; else if (r.status === 'skipped') skipped++; else failed++;
    }
    return { audience: dto.audience, segment: dto.segment ?? null, targeted: members.length, sent, skipped, failed };
  }

  // LINE OA broadcast — one message to every follower of the shop's Official Account. There is no member
  // list and no per-member consent filter (the OA follow relationship IS the consent; users opt out by
  // unfollowing) — so this is an operator action (marketing/exec), and it is audit-logged in message_log with
  // a synthetic recipient 'oa:broadcast' so the send is reviewable. Falls through to the mock when no
  // LINE_CHANNEL_TOKEN is configured (logged as sent, provider 'mock').
  async broadcastOA(dto: BroadcastDto, user: JwtUser) {
    // Prefer the tenant's own OA token, else the platform env default; unset ⇒ mock. A `flex` payload sends a
    // rich card/carousel (alt_text is the notification text); otherwise the plain `body` text is sent.
    const creds = await this.creds(user, 'line');
    const token = creds?.token ?? process.env.LINE_CHANNEL_TOKEN;
    const rich = dto.flex != null;
    const logBody = rich ? (dto.alt_text ?? '[flex]') : (dto.body ?? '');
    const res = token
      ? (rich ? await broadcastLineFlex(token, dto.alt_text ?? logBody, dto.flex) : await broadcastLine(token, dto.body ?? ''))
      : { status: 'sent' as const, provider: 'mock', ref: 'mock_broadcast' };
    return this.record(user, { memberId: null, channel: 'line', recipient: 'oa:broadcast', body: logBody, campaign: dto.campaign ?? 'oa_broadcast', status: res.status, provider: res.provider, error: res.error ?? null });
  }

  // Push a rich LINE flex message (card/carousel) to one LINE userId — for a member or an ad-hoc recipient.
  // Respects marketing consent when addressed to a member. Falls back to mock when LINE is unconfigured.
  async sendFlex(dto: FlexDto, user: JwtUser) {
    const db = this.db as any;
    let recipient = dto.to;
    if (dto.member_id != null) {
      const [m] = await db.select().from(posMembers).where(eq(posMembers.id, dto.member_id)).limit(1);
      if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
      if (m.marketingOptIn === false) return this.record(user, { memberId: dto.member_id, channel: 'line', recipient: null, body: dto.alt_text, campaign: dto.campaign, status: 'skipped', provider: null, error: 'opted out' });
      recipient = recipient || m.lineUserId;
    }
    if (!recipient) return this.record(user, { memberId: dto.member_id ?? null, channel: 'line', recipient: null, body: dto.alt_text, campaign: dto.campaign, status: 'failed', provider: null, error: 'no recipient contact' });
    const creds = await this.creds(user, 'line');
    const token = creds?.token ?? process.env.LINE_CHANNEL_TOKEN;
    const res = token ? await pushLineFlex(token, recipient, dto.alt_text, dto.flex) : { status: 'sent' as const, provider: 'mock', ref: 'mock_flex' };
    return this.record(user, { memberId: dto.member_id ?? null, channel: 'line', recipient, body: dto.alt_text, campaign: dto.campaign ?? 'flex', status: res.status, provider: res.provider, error: res.error ?? null });
  }

  // Send a canned test message through the channel's resolved provider (per-tenant creds → env → mock), so an
  // admin can verify a newly-configured provider actually delivers. Audit-logged like any send.
  async sendTest(channel: MessageChannel, to: string, user: JwtUser) {
    const creds = await this.creds(user, channel);
    const gw = resolveMessageGateway(channel, creds ?? undefined);
    const res = await gw.send(to, `ทดสอบการส่งข้อความจากระบบ (${channel})`);
    return this.record(user, { memberId: null, channel, recipient: to, body: '[provider test]', campaign: 'provider_test', status: res.status, provider: res.provider, error: res.error ?? null });
  }

  async log(_user: JwtUser, limit = 100) {
    const db = this.db as any;
    const rows = await db.select().from(messageLog).orderBy(desc(messageLog.id)).limit(limit);
    return { messages: rows.map((r: any) => ({ id: Number(r.id), member_id: r.memberId != null ? Number(r.memberId) : null, channel: r.channel, recipient: r.recipient, body: r.body, campaign: r.campaign, status: r.status, provider: r.provider, error: r.error, created_at: r.createdAt })) };
  }

  private async record(user: JwtUser, row: { memberId: number | null; channel: string; recipient: string | null; body: string; campaign?: string | null; status: string; provider: string | null; error: string | null }) {
    const db = this.db as any;
    const [r] = await db.insert(messageLog).values({ tenantId: user.tenantId ?? null, memberId: row.memberId, channel: row.channel, recipient: row.recipient, body: row.body, campaign: row.campaign ?? null, status: row.status, provider: row.provider, error: row.error, createdBy: user.username }).returning({ id: messageLog.id });
    return { id: Number(r.id), status: row.status, provider: row.provider, recipient: row.recipient, error: row.error };
  }
}
