import { Injectable, BadRequestException } from '@nestjs/common';
import { MemberService } from '../loyalty/member.service';
import { WebhookService } from '../platform/webhook.service';
import type { JwtUser } from '../../common/decorators';

// Public loyalty write API (Phase C2) — the machine-facing surface for integrations to enrol members and
// move points via API key. Thin: it delegates the (locked, ledgered) logic to MemberService, then fires the
// matching webhook event so subscribers hear about the point movement. Webhooks fire POST-commit (after the
// MemberService own-tx returns) and are best-effort — a webhook failure never rolls back the points.
@Injectable()
export class PublicLoyaltyService {
  constructor(
    private readonly members: MemberService,
    private readonly webhooks: WebhookService,
  ) {}

  // Fire post-commit (the MemberService own-tx has already returned). Awaited but best-effort — a webhook
  // failure is swallowed so it never rolls back the points (deliver() itself records the failed delivery for
  // retry via the standard dispatcher). Mirrors how other business events emit webhooks inline.
  private async fire(event: string, payload: Record<string, any>, user: JwtUser) {
    try { await this.webhooks.deliver(event, payload, user.tenantId ?? null); } catch { /* best-effort */ }
  }

  async enroll(dto: { name?: string; phone?: string; card_no?: string; email?: string; birthday?: string; marketing_opt_in?: boolean }, user: JwtUser) {
    const res = await this.members.enroll(dto, user);
    await this.fire('loyalty.enrolled', { member_id: res.id, member_code: res.member_code, phone: res.phone }, user);
    return res;
  }

  async earn(dto: { member_id: number; net_spend: number; ref_doc?: string }, user: JwtUser) {
    if (!(dto.net_spend > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'net_spend must be > 0', messageTh: 'ยอดต้องมากกว่าศูนย์' });
    const res = await this.members.earn(user, dto.member_id, dto.net_spend, dto.ref_doc ?? `API-EARN-${dto.member_id}`);
    await this.fire('loyalty.earned', res, user);
    return res;
  }

  async redeem(dto: { member_id: number; points: number; ref_doc?: string }, user: JwtUser) {
    if (!(dto.points > 0)) throw new BadRequestException({ code: 'BAD_POINTS', message: 'points must be > 0', messageTh: 'แต้มต้องมากกว่าศูนย์' });
    const res = await this.members.redeem(user, dto.member_id, dto.points, dto.ref_doc ?? `API-RDM-${dto.member_id}`);
    await this.fire('loyalty.redeemed', res, user);
    return res;
  }

  // Read a member's balance by member code / phone / card (read scope). lookup() throws MEMBER_NOT_FOUND.
  async member(q: { code?: string; phone?: string; card?: string }, user: JwtUser) {
    return this.members.lookup({ code: q.code, phone: q.phone, card: q.card }, user);
  }
}
