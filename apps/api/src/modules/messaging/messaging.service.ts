import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { posMembers, messageLog, customerProfiles } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { resolveMessageGateway, type MessageChannel } from './gateways';

type SendDto = { member_id?: number; to?: string; channel: MessageChannel; body: string; campaign?: string };
type BlastDto = { audience: 'all' | 'birthdays_today' | 'segment'; segment?: string; channel: MessageChannel; body: string; campaign?: string };

@Injectable()
export class MessagingService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Send one message. Respects marketing consent for member-addressed messages (logs 'skipped').
  async send(dto: SendDto, user: JwtUser) {
    const db = this.db as any;
    let member: any = null;
    let recipient = dto.to ?? null;
    if (dto.member_id != null) {
      [member] = await db.select().from(posMembers).where(eq(posMembers.id, dto.member_id)).limit(1);
      if (!member) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
      if (member.marketingOptIn === false) return this.record(user, { memberId: dto.member_id, channel: dto.channel, recipient: null, body: dto.body, campaign: dto.campaign, status: 'skipped', provider: null, error: 'opted out' });
      recipient = recipient ?? (dto.channel === 'email' ? member.email : member.phone);
    }
    if (!recipient) return this.record(user, { memberId: dto.member_id ?? null, channel: dto.channel, recipient: null, body: dto.body, campaign: dto.campaign, status: 'failed', provider: null, error: 'no recipient contact' });
    const gw = resolveMessageGateway(dto.channel);
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
    let sent = 0, skipped = 0, failed = 0;
    for (const m of members) {
      const r: any = await this.send({ member_id: Number(m.id), channel: dto.channel, body: dto.body, campaign: dto.campaign ?? `blast:${dto.audience}` }, user);
      if (r.status === 'sent') sent++; else if (r.status === 'skipped') skipped++; else failed++;
    }
    return { audience: dto.audience, segment: dto.segment ?? null, targeted: members.length, sent, skipped, failed };
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
