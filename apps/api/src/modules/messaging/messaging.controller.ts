import { Controller, Get, Post, Put, Query, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { MessagingService } from './messaging.service';
import type { MessageChannel } from './gateways';
import { TenantMessagingService } from './tenant-messaging.service';
import { LineNotifyService } from './line-notify.service';

const channel = z.enum(['line', 'sms', 'email']);
// Per-tenant provider credentials (write-only). Shapes are loose (per-channel fields validated server-side).
const ProviderBody = z.object({ creds: z.record(z.any()), enabled: z.boolean().optional() });
const TestBody = z.object({ to: z.string().min(1).max(200) });
const SendBody = z.object({ member_id: z.number().int().positive().optional(), to: z.string().optional(), channel, body: z.string().min(1).max(1000), campaign: z.string().optional() })
  .refine((d) => d.member_id != null || d.to != null, { message: 'member_id or to required' });
const BlastBody = z.object({ audience: z.enum(['all', 'birthdays_today', 'segment', 'saved_segment']), segment: z.string().optional(), segment_id: z.number().int().positive().optional(), channel, body: z.string().min(1).max(1000), campaign: z.string().optional() });
// Broadcast: either a plain `body` OR a rich `flex` message (LINE flex container + alt_text). One is required.
const BroadcastBody = z.object({ body: z.string().min(1).max(5000).optional(), flex: z.any().optional(), alt_text: z.string().max(400).optional(), campaign: z.string().optional() })
  .refine((d) => d.body != null || d.flex != null, { message: 'body or flex required' });
const FlexBody = z.object({ to: z.string().optional(), member_id: z.number().int().positive().optional(), alt_text: z.string().min(1).max(400), flex: z.any(), campaign: z.string().optional() })
  .refine((d) => d.to != null || d.member_id != null, { message: 'to or member_id required' });
// W3 (docs/27) — tenant-wide messaging governance (quiet hours + global weekly marketing cap).
const GovernanceBody = z.object({ quiet_start: z.string().regex(/^\d{2}:\d{2}$/).optional(), quiet_end: z.string().regex(/^\d{2}:\d{2}$/).optional(), weekly_cap: z.number().int().nonnegative().optional() });

@Controller('api/messaging')
export class MessagingController {
  constructor(
    private readonly svc: MessagingService,
    private readonly tenantMsg: TenantMessagingService,
    private readonly lineNotify: LineNotifyService,
  ) {}

  @Post('send') @Permissions('marketing', 'crm')
  send(@Body(new ZodValidationPipe(SendBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.send(b, u); }

  @Post('blast') @Permissions('marketing')
  blast(@Body(new ZodValidationPipe(BlastBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.blast(b, u); }

  // LINE OA broadcast to all followers — operator action (no per-member consent filter; audit-logged).
  // Accepts a plain `body` or a rich `flex` message (card/carousel with images + buttons).
  @Post('broadcast-oa') @Permissions('marketing', 'exec')
  broadcastOA(@Body(new ZodValidationPipe(BroadcastBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.broadcastOA(b, u); }

  // Targeted rich LINE flex push (to a member or an explicit LINE userId) — consent-respecting for members.
  @Post('line/flex') @Permissions('marketing', 'crm')
  sendFlex(@Body(new ZodValidationPipe(FlexBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.sendFlex(b, u); }

  @Get('log') @Permissions('marketing', 'crm')
  log(@Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.log(u, limit ? +limit : 100); }

  // ── Per-tenant messaging providers (own LINE OA / SMS / SMTP). Admin-only; secrets are write-only. ──
  @Get('providers') @Permissions('users', 'exec')
  getProviders(@CurrentUser() u: JwtUser) { return this.tenantMsg.get(u); }

  @Put('providers/:channel') @Permissions('users', 'exec')
  setProvider(@Param('channel') ch: string, @Body(new ZodValidationPipe(ProviderBody)) b: any, @CurrentUser() u: JwtUser) {
    return this.tenantMsg.set(ch, b.creds, b.enabled ?? true, u);
  }

  @Post('providers/:channel/test') @Permissions('users', 'exec')
  testProvider(@Param('channel') ch: string, @Body(new ZodValidationPipe(TestBody)) b: any, @CurrentUser() u: JwtUser) {
    return this.svc.sendTest(ch as MessageChannel, b.to, u);
  }

  // LP-1 (docs/31) — go-live console: push a test message to the CALLING admin's own linked LINE (no
  // userId to look up/typo). Errors NOT_LINKED when the admin hasn't linked, so silence is explained.
  @Post('providers/line/test-self') @Permissions('users', 'exec')
  testLineSelf(@CurrentUser() u: JwtUser) { return this.lineNotify.testSelf(u); }

  // ── W3 (docs/27) — messaging governance: quiet hours + global weekly marketing cap (MKT-04/12) ──
  @Get('governance') @Permissions('marketing', 'users', 'exec')
  async getGovernance(@CurrentUser() u: JwtUser) { return { governance: await this.tenantMsg.getGovernance(u.tenantId) }; }

  @Put('governance') @Permissions('marketing', 'users', 'exec')
  setGovernance(@Body(new ZodValidationPipe(GovernanceBody)) b: any, @CurrentUser() u: JwtUser) { return this.tenantMsg.setGovernance(b, u); }
}
