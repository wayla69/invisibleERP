import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { JournalService } from './journal.service';
import { EtaxService } from './etax.service';
import { qint, qintOpt } from '../../../common/query';

const AppendBody = z.object({ doc_type: z.string().min(1), doc_no: z.string().optional(), action: z.string().optional(), payload: z.record(z.any()) });
const SubmitBody = z.object({ provider: z.string().optional() });

@Controller('api/pos/journal')
@Permissions('pos', 'order_mgt', 'exec', 'ar')
export class JournalController {
  constructor(private readonly svc: JournalService) {}
  @Get() list(@Query('limit') limit?: string) { return this.svc.list(qint('limit', limit, 100)); }
  @Get('verify') verify() { return this.svc.verify(); }
  @Post('append') @Permissions('pos', 'order_mgt', 'exec') append(@Body(new ZodValidationPipe(AppendBody)) b: z.infer<typeof AppendBody>, @CurrentUser() u: JwtUser) { return this.svc.append(b, u); }
}

@Controller('api/tax/etax')
@Permissions('ar', 'pos', 'exec')
export class EtaxController {
  constructor(private readonly svc: EtaxService) {}
  @Get() list(@Query('limit') limit?: string, @Query('status') status?: string) { return this.svc.list(qint('limit', limit, 100), status); }
  @Get('status/:docNo') status(@Param('docNo') docNo: string) { return this.svc.status(docNo); }
  @Post('submit/:docNo') submit(@Param('docNo') docNo: string, @Body(new ZodValidationPipe(SubmitBody)) b: z.infer<typeof SubmitBody>, @CurrentUser() u: JwtUser) { return this.svc.submit(docNo, b.provider, u); }
  // Operator surface (gap #5, submission durability): manually kick the same retry sweep the BI job runs.
  @Post('retry-failed') @Permissions('exec') retryFailed(@CurrentUser() u: JwtUser) { return this.svc.retryFailed(u); }
}
