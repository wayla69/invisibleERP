import { Controller, Get, Post, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { MessagingService } from './messaging.service';

const channel = z.enum(['line', 'sms', 'email']);
const SendBody = z.object({ member_id: z.number().int().positive().optional(), to: z.string().optional(), channel, body: z.string().min(1).max(1000), campaign: z.string().optional() })
  .refine((d) => d.member_id != null || d.to != null, { message: 'member_id or to required' });
const BlastBody = z.object({ audience: z.enum(['all', 'birthdays_today', 'segment']), segment: z.string().optional(), channel, body: z.string().min(1).max(1000), campaign: z.string().optional() });

@Controller('api/messaging')
export class MessagingController {
  constructor(private readonly svc: MessagingService) {}

  @Post('send') @Permissions('marketing', 'crm')
  send(@Body(new ZodValidationPipe(SendBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.send(b, u); }

  @Post('blast') @Permissions('marketing')
  blast(@Body(new ZodValidationPipe(BlastBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.blast(b, u); }

  @Get('log') @Permissions('marketing', 'crm')
  log(@Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.log(u, limit ? +limit : 100); }
}
