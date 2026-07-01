import { Controller, Get, Post, Put, Query, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { MessagingService } from './messaging.service';
import { TenantMessagingService } from './tenant-messaging.service';

const channel = z.enum(['line', 'sms', 'email']);
// Per-tenant provider credentials (write-only). Shapes are loose (per-channel fields validated server-side).
const ProviderBody = z.object({ creds: z.record(z.any()), enabled: z.boolean().optional() });
const SendBody = z.object({ member_id: z.number().int().positive().optional(), to: z.string().optional(), channel, body: z.string().min(1).max(1000), campaign: z.string().optional() })
  .refine((d) => d.member_id != null || d.to != null, { message: 'member_id or to required' });
const BlastBody = z.object({ audience: z.enum(['all', 'birthdays_today', 'segment']), segment: z.string().optional(), channel, body: z.string().min(1).max(1000), campaign: z.string().optional() });
const BroadcastBody = z.object({ body: z.string().min(1).max(5000), campaign: z.string().optional() });

@Controller('api/messaging')
export class MessagingController {
  constructor(
    private readonly svc: MessagingService,
    private readonly tenantMsg: TenantMessagingService,
  ) {}

  @Post('send') @Permissions('marketing', 'crm')
  send(@Body(new ZodValidationPipe(SendBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.send(b, u); }

  @Post('blast') @Permissions('marketing')
  blast(@Body(new ZodValidationPipe(BlastBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.blast(b, u); }

  // LINE OA broadcast to all followers — operator action (no per-member consent filter; audit-logged).
  @Post('broadcast-oa') @Permissions('marketing', 'exec')
  broadcastOA(@Body(new ZodValidationPipe(BroadcastBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.broadcastOA(b, u); }

  @Get('log') @Permissions('marketing', 'crm')
  log(@Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.log(u, limit ? +limit : 100); }

  // ── Per-tenant messaging providers (own LINE OA / SMS / SMTP). Admin-only; secrets are write-only. ──
  @Get('providers') @Permissions('users', 'exec')
  getProviders(@CurrentUser() u: JwtUser) { return this.tenantMsg.get(u); }

  @Put('providers/:channel') @Permissions('users', 'exec')
  setProvider(@Param('channel') ch: string, @Body(new ZodValidationPipe(ProviderBody)) b: any, @CurrentUser() u: JwtUser) {
    return this.tenantMsg.set(ch, b.creds, b.enabled ?? true, u);
  }
}
