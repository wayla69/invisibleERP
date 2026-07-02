import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Public, NoTx, Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { NpsService } from './nps.service';
import { RecoveryService } from './recovery.service';

const SendBody = z.object({ member_id: z.number().int().positive(), sale_ref: z.string().max(60).optional(), channel: z.enum(['line', 'sms', 'email']).optional() });
const SubmitBody = z.object({ score: z.number().int().min(0).max(10), comment: z.string().max(500).optional() });
const ResolveBody = z.object({ note: z.string().min(1).max(500) });

// W3 (docs/27) — NPS micro-survey. The PUBLIC routes are keyed by the single-use random token only (no PII
// in the URL, CWE-598) and run @NoTx on the base pool (the anonymous respondent has no tenant context —
// the same pattern as the member OTP + delivery-callback public routes); every query is token-keyed.
@Controller('api/nps')
export class NpsController {
  constructor(private readonly svc: NpsService) {}

  // ── Staff ──
  @Post('send') @Permissions('marketing', 'loyalty', 'crm')
  send(@Body(new ZodValidationPipe(SendBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.sendSurvey(u, b); }
  @Post('send-due') @Permissions('marketing', 'loyalty', 'exec')
  sendDue(@Query('window_days') w: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.sendDue(u, w ? Math.max(1, +w) : 1); }
  @Get('summary') @Permissions('marketing', 'loyalty', 'exec')
  summary(@Query('months') months: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.summary(u, months ? Math.min(24, Math.max(1, +months)) : 6); }
  @Get('members/:id/last') @Permissions('marketing', 'loyalty', 'crm')
  lastForMember(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.lastForMember(u, +id); }

  // ── Public (tokenized; must stay LAST so 'summary'/'send' resolve first) ──
  @Public() @NoTx() @Get(':token')
  getSurvey(@Param('token') token: string) { return this.svc.getSurvey(token); }
  @Public() @NoTx() @Post(':token')
  submit(@Param('token') token: string, @Body(new ZodValidationPipe(SubmitBody)) b: any) { return this.svc.submit(token, b); }
}

// V2 (docs/29, LYL-20) — the detractor recovery worklist. Contact/resolve are actor-stamped transitions;
// an unresolved case past its response SLA reads as overdue everywhere it surfaces.
@Controller('api/recovery')
export class RecoveryController {
  constructor(private readonly svc: RecoveryService) {}

  @Get('cases') @Permissions('crm', 'loyalty', 'marketing')
  list(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.list(u, status); }
  @Post('cases/:id/contact') @Permissions('crm', 'loyalty', 'marketing')
  contact(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.contact(u, +id); }
  @Post('cases/:id/resolve') @Permissions('crm', 'loyalty', 'marketing')
  resolve(@Param('id') id: string, @Body(new ZodValidationPipe(ResolveBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.resolve(u, +id, b.note); }
}
